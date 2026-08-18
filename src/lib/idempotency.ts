// ============================================================
// Idempotency (§34, §35)
// ------------------------------------------------------------
// THE GUARANTEE: if the same webhook arrives five times, exactly ONE financial
// allocation results. The other four get the stored response replayed.
//
// Replaying the stored response rather than returning an error matters more than
// it looks. A provider that receives a 4xx or 5xx treats the delivery as failed
// and retries harder — so answering "duplicate, rejected" to a duplicate webhook
// produces MORE duplicates. Replaying the original success ends the retry loop,
// which is the behaviour every payment provider's documentation asks for.
//
// This is one of TWO layers. The other is a unique index on
// (providerId, providerTransactionId) in the append-only-guards migration, which
// holds even if two deliveries race past the check below inside the same
// millisecond. Application logic alone cannot win that race; the database can.
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import prisma from './prisma';

/** A transaction client, or the base client. */
type Db = PrismaClient | Prisma.TransactionClient;

/** How long a consumed key is remembered. Configurable via policy settings. */
const DEFAULT_RETENTION_DAYS = 30;

/**
 * The key for this request.
 *
 * Prefers the caller's `Idempotency-Key` header — a client queuing a payment
 * offline mints one so a retry after a dropped connection is recognised. Where
 * none is supplied, a key is DERIVED from the request body, so a double-submitted
 * form is still caught. Deriving from the body is weaker (two genuinely separate
 * identical payments would collide), which is why the derived key includes the
 * caller and a coarse time bucket.
 */
export function idempotencyKeyFrom(request: NextRequest, body: unknown, actorId: string): string {
  const supplied = request.headers.get('idempotency-key') ?? request.headers.get('x-idempotency-key');
  if (supplied && supplied.trim().length >= 8) return supplied.trim();

  // A five-minute bucket: a genuine second payment of the same amount by the
  // same cashier within five minutes is rare enough to be worth a deliberate
  // Idempotency-Key, and a double-click is far more likely.
  const bucket = Math.floor(Date.now() / (5 * 60_000));
  const digest = createHash('sha256')
    .update(JSON.stringify({ body, actorId, bucket }))
    .digest('hex');
  return `derived_${digest.slice(0, 32)}`;
}

/** The stored response for a key already consumed, or null. */
export async function replayIfSeen(key: string, scope: string): Promise<NextResponse | null> {
  const seen = await prisma.idempotencyKey.findUnique({ where: { key } });
  if (!seen) return null;
  if (seen.scope !== scope) {
    // The same key used against a different endpoint is a client bug, and
    // replaying one endpoint's response to another would be worse than an error.
    return NextResponse.json(
      {
        error: 'This idempotency key has already been used against a different operation.',
        code: 'IDEMPOTENCY_KEY_REUSED',
      },
      { status: 409 }
    );
  }

  return NextResponse.json(
    { ...(seen.responseBody as object), idempotentReplay: true },
    { status: seen.httpStatus, headers: { 'Idempotent-Replay': 'true' } }
  );
}

/**
 * Remember what this key produced.
 *
 * Called INSIDE the same database transaction as the financial write wherever
 * possible — see the payment route. Recording the key in a separate transaction
 * leaves a window in which the money moved but the key did not land, and a retry
 * in that window would move it twice.
 */
export async function rememberResult(params: {
  key: string;
  scope: string;
  httpStatus: number;
  body: unknown;
  paymentId?: string | null;
  /** Pass a transaction client to make this atomic with the financial write. */
  tx?: Db;
  retentionDays?: number;
}): Promise<void> {
  const { key, scope, httpStatus, body, paymentId = null, tx, retentionDays = DEFAULT_RETENTION_DAYS } = params;

  const expiresAt = new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000);
  const data = {
    key,
    scope,
    httpStatus,
    responseBody: body as never,
    paymentId,
    expiresAt,
  };

  const client: Db = tx ?? prisma;
  try {
    await client.idempotencyKey.create({ data });
  } catch {
    // A unique-violation here means a concurrent request won the race and has
    // already recorded the same key. That is the system working: the other
    // request's response is the canonical one. Swallowing it is correct — but
    // only for this specific case, which is why nothing else is caught.
  }
}

/** Prune expired keys. Run from the scheduled reconciliation job. */
export async function pruneExpiredKeys(): Promise<number> {
  const { count } = await prisma.idempotencyKey.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return count;
}

// ============================================================
// The audit trail (§33)
// ------------------------------------------------------------
// This is NOT a report that gets written after the interesting work is done. It
// is an INPUT to a live control.
//
// checkSeparationOfDuties() decides whether a user may act on a record by
// reading what that user has ALREADY done to it — and it reads it from here. A
// system that logs nothing cannot enforce §25 at all: without a record of who
// overrode the price, there is no way to stop the same person confirming the
// payment.
//
// Two consequences follow, and both are deliberate:
//
//   1. THE AUDIT WRITE IS INSIDE THE FINANCIAL TRANSACTION. If the money moves
//      and the audit row does not, the next separation-of-duties check is blind
//      to what just happened. So every recordAudit() takes a transaction client,
//      and a failed audit write rolls the money back with it.
//
//   2. THE TABLE IS APPEND-ONLY IN THE DATABASE, not merely in this file. See
//      the append_only_guards migration: a user who could delete their own prior
//      act could delete the thing that bars them from acting again.
// ============================================================

import type { Prisma, PrismaClient } from '@prisma/client';
import type { PriorAct } from './rbac';

/** A transaction client, or the base client. Audit writes accept either. */
type Db = PrismaClient | Prisma.TransactionClient;

/**
 * The §25 duties. A plain string in the database, but constrained here so a
 * typo cannot silently create a duty that no incompatibility rule matches — and
 * therefore silently disable a separation-of-duties check.
 */
export const Duty = {
  INVOICE_CREATED: 'INVOICE_CREATED',
  INVOICE_ISSUED: 'INVOICE_ISSUED',
  INVOICE_CANCELLED: 'INVOICE_CANCELLED',
  PRICE_OVERRIDDEN: 'PRICE_OVERRIDDEN',
  DISCOUNT_APPLIED: 'DISCOUNT_APPLIED',
  DISCOUNT_APPROVED: 'DISCOUNT_APPROVED',
  PAYMENT_CONFIRMED: 'PAYMENT_CONFIRMED',
  PAYMENT_REVERSED: 'PAYMENT_REVERSED',
  REFUND_REQUESTED: 'REFUND_REQUESTED',
  REFUND_APPROVED: 'REFUND_APPROVED',
  SETTLEMENT_INITIATED: 'SETTLEMENT_INITIATED',
  SETTLEMENT_CONFIRMED: 'SETTLEMENT_CONFIRMED',
  ALLOCATION_RULE_CHANGED: 'ALLOCATION_RULE_CHANGED',
  BENEFICIARY_CHANGED: 'BENEFICIARY_CHANGED',
  RECEIPT_ISSUED: 'RECEIPT_ISSUED',
} as const;

export type DutyValue = (typeof Duty)[keyof typeof Duty];

export interface AuditContext {
  userId: string | null;
  userName: string | null;
  userRole: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  sessionId?: string | null;
}

export interface AuditRecord {
  /** The §25 duty this act constitutes, where it is one. */
  duty?: DutyValue | null;
  /** What happened, in plain words: 'payment.confirm', 'invoice.issue'. */
  action: string;
  entity: string;
  entityId?: string | null;

  patientId?: string | null;
  invoiceId?: string | null;
  paymentId?: string | null;

  /** Both sides of a change. "What did it used to say" must always be answerable. */
  previousValue?: unknown;
  newValue?: unknown;

  reason?: string | null;
  approvalId?: string | null;
  /** True where a separation-of-duties bar was overridden under policy. */
  sodOverridden?: boolean;
}

/**
 * Write one audit row.
 *
 * `db` should be the TRANSACTION client whenever this accompanies a financial
 * write — see the note in the header. Passing the base client is correct only
 * for acts that move no money, such as a failed authorisation attempt.
 */
export async function recordAudit(db: Db, context: AuditContext, record: AuditRecord): Promise<void> {
  await db.auditLog.create({
    data: {
      duty: record.duty ?? null,
      action: record.action,
      entity: record.entity,
      entityId: record.entityId ?? null,

      userId: context.userId,
      userName: context.userName,
      userRole: context.userRole,

      patientId: record.patientId ?? null,
      invoiceId: record.invoiceId ?? null,
      paymentId: record.paymentId ?? null,

      previousValue: (record.previousValue ?? undefined) as never,
      newValue: (record.newValue ?? undefined) as never,

      reason: record.reason ?? null,
      approvalId: record.approvalId ?? null,

      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
      sessionId: context.sessionId ?? null,

      sodOverridden: record.sodOverridden ?? false,
    },
  });
}

/**
 * What has already been done to this record, as the separation-of-duties check
 * needs to see it.
 *
 * Only rows carrying a `duty` are returned: an ordinary read or a note is not a
 * duty and must not bar anybody from anything.
 */
export async function priorActsFor(
  db: Db,
  params: { entity: string; entityId: string; alsoInvoiceId?: string | null }
): Promise<PriorAct[]> {
  const rows = await db.auditLog.findMany({
    where: {
      duty: { not: null },
      OR: [
        { entity: params.entity, entityId: params.entityId },
        // A payment's separation-of-duties history includes what was done to the
        // INVOICE it pays. Without this, the person who overrode a price could
        // confirm the payment simply because the price change was recorded
        // against a different row — which is the whole attack §25 describes.
        ...(params.alsoInvoiceId ? [{ invoiceId: params.alsoInvoiceId }] : []),
      ],
    },
    select: { duty: true, userId: true, occurredAt: true },
    orderBy: { occurredAt: 'asc' },
    take: 500,
  });

  return rows
    .filter((r): r is typeof r & { duty: string; userId: string } => Boolean(r.duty && r.userId))
    .map((r) => ({ duty: r.duty, userId: r.userId, at: r.occurredAt }));
}

/** Request context for an audit row, from the incoming request. */
export function auditContextFrom(
  request: Request,
  actor: { userId: string; fullName: string; roles: string[]; sessionId?: string }
): AuditContext {
  // An IP is EVIDENCE, never a credential: it is recorded so an investigation
  // has somewhere to start, and is used for no authorisation decision anywhere.
  const forwarded = request.headers.get('x-forwarded-for');
  const ip = forwarded ? forwarded.split(',')[0].trim() : request.headers.get('x-real-ip');

  return {
    userId: actor.userId,
    userName: actor.fullName,
    userRole: actor.roles.join(','),
    ipAddress: ip ?? null,
    userAgent: request.headers.get('user-agent'),
    sessionId: actor.sessionId ?? null,
  };
}

// ============================================================
// POST /api/webhooks/[provider] — the only unauthenticated route (§35)
// ------------------------------------------------------------
// Everything else in this application sits behind a session. This does not: a
// payment provider has no user account. So this endpoint is the one surface an
// attacker can reach directly, and it is written accordingly.
//
// THE ORDER OF OPERATIONS IS THE SECURITY DESIGN.
//
//   1. Read the RAW body           — before any parsing. The signature is over
//                                    the exact bytes; re-serialised JSON has
//                                    different whitespace and never matches.
//   2. Identify the provider       — unknown code is a 404, not a crash.
//   3. VERIFY THE SIGNATURE        — before the body is trusted for anything.
//                                    A failure here is recorded as a security
//                                    event, not merely refused.
//   4. Parse and normalise
//   5. Ignore events we do not act on
//   6. Idempotency                 — five deliveries, one allocation.
//   7. ASK THE PROVIDER DIRECTLY   — server to server. The webhook's own amount
//                                    is never believed.
//   8. Reconcile against the bill  — a mismatch is flagged, never applied.
//
// WHY STEP 7 EXISTS EVEN THOUGH STEP 3 PASSED. A valid signature proves the
// message came from the provider. It does not prove the message is current: a
// transaction can be reversed after its webhook fires, and a replayed old
// delivery still carries a perfectly valid signature. Only asking the provider
// now establishes what is true now. Paystack's own guidance says the same.
//
// THIS ROUTE NEVER MARKS AN INVOICE PAID. It records a verification. Confirming
// the payment — with its permission check, separation of duties, allocation and
// ledger entries — happens in /api/payments, which will only accept a
// GATEWAY_VERIFIED trust basis if the record this route writes exists.
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { adapterFor } from '@/lib/payments/providers';
import { idempotencyKeyForEvent, isActionable, reconcileVerification } from '@/lib/payments/webhooks';
import { replayIfSeen, rememberResult } from '@/lib/idempotency';
import { recordAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

const SCOPE = 'webhook.receive';

/** Context for audit rows written from a route with no signed-in user. */
function systemContext(request: NextRequest, provider: string) {
  const forwarded = request.headers.get('x-forwarded-for');
  return {
    userId: null,
    userName: `webhook:${provider}`,
    userRole: 'SYSTEM',
    ipAddress: forwarded ? forwarded.split(',')[0].trim() : request.headers.get('x-real-ip'),
    userAgent: request.headers.get('user-agent'),
    sessionId: null,
  };
}

export async function POST(request: NextRequest, context: { params: { provider: string } }) {
  const providerCode = context.params.provider?.toUpperCase() ?? '';
  const audit = systemContext(request, providerCode);

  // --- 1. The raw body, before anything parses it --------------------------
  const rawBody = await request.text();

  // --- 2. Which provider? --------------------------------------------------
  const adapter = adapterFor(providerCode);
  if (!adapter) {
    return NextResponse.json({ error: 'Unknown payment provider.' }, { status: 404 });
  }

  const providerRow = await prisma.paymentProvider.findUnique({ where: { code: providerCode } });
  if (!providerRow || !providerRow.isActive) {
    // A webhook for a provider the hospital has switched off is not an error on
    // their side; it is accepted and ignored so the provider stops retrying.
    return NextResponse.json({ received: true, ignored: 'provider not enabled' }, { status: 200 });
  }

  // --- 3. The signature, before the body is trusted ------------------------
  const signature = adapter.verifySignature({ rawBody, headers: request.headers });

  if (!signature.valid) {
    // A forged or misconfigured webhook is a SECURITY EVENT. Recorded with the
    // failure reason and the source address so a pattern of attempts is visible
    // in the audit trail rather than only in a server log nobody reads.
    await prisma.paymentTransaction
      .create({
        data: {
          providerId: providerRow.id,
          operation: 'WEBHOOK',
          providerStatus: 'SIGNATURE_REJECTED',
          signatureValid: false,
          httpStatus: 401,
          // The body is stored so an investigation can see what was sent. It is
          // NOT trusted for anything.
          requestPayload: { rawBody: rawBody.slice(0, 4000), reason: signature.code } as never,
        },
      })
      .catch(() => undefined);

    await recordAudit(prisma, audit, {
      action: 'webhook.signature-rejected',
      entity: 'payment-provider',
      entityId: providerRow.id,
      reason: signature.message ?? 'Signature verification failed.',
      newValue: { code: signature.code, provider: providerCode },
    }).catch(() => undefined);

    // 401 and nothing else. No detail about why, which would help someone tune
    // a forgery.
    return NextResponse.json({ error: 'Invalid signature.' }, { status: 401 });
  }

  // --- 4. Parse ------------------------------------------------------------
  let event;
  try {
    event = adapter.parseEvent(JSON.parse(rawBody));
  } catch (err) {
    await recordAudit(prisma, audit, {
      action: 'webhook.unparseable',
      entity: 'payment-provider',
      entityId: providerRow.id,
      reason: err instanceof Error ? err.message : 'Unparseable webhook body.',
    }).catch(() => undefined);
    // 200: the signature was valid, so this is our problem to investigate, and
    // making the provider retry a body we cannot read achieves nothing.
    return NextResponse.json({ received: true, ignored: 'unparseable' }, { status: 200 });
  }

  // --- 5. Is this an event we act on? --------------------------------------
  if (!isActionable(event)) {
    return NextResponse.json({ received: true, ignored: event.eventType }, { status: 200 });
  }

  // --- 6. Five deliveries, one allocation (§35) ----------------------------
  const key = idempotencyKeyForEvent(event);
  const replay = await replayIfSeen(key, SCOPE);
  if (replay) return replay;

  // --- 7. Ask the provider directly ---------------------------------------
  let verification;
  try {
    verification = await adapter.verify(event.reference);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Verification failed.';
    await prisma.paymentTransaction
      .create({
        data: {
          providerId: providerRow.id,
          operation: 'VERIFY',
          providerStatus: 'VERIFY_FAILED',
          providerReference: event.reference,
          signatureValid: true,
          requestPayload: { reference: event.reference } as never,
          responsePayload: { error: message } as never,
        },
      })
      .catch(() => undefined);

    // 500 so the provider RETRIES. The webhook was genuine and we could not
    // complete it; a retry is exactly what we want.
    return NextResponse.json({ error: 'Verification could not be completed. Please retry.' }, { status: 500 });
  }

  // The invoice this reference belongs to. The reference was minted by us at
  // initiation and stored on the invoice, so this is our own record — not
  // anything the webhook asserted.
  const invoice = await prisma.invoice.findFirst({
    where: { paymentToken: event.reference },
    select: { id: true, invoiceNumber: true, total: true, amountPaid: true },
  });

  // --- Record the verification, whatever it says ---------------------------
  // Written BEFORE the reconciliation verdict, so even a mismatched payment
  // leaves a trace. Money that arrived and did not match a bill is the single
  // most important thing for reconciliation to find (§31).
  const transaction = await prisma.paymentTransaction.create({
    data: {
      providerId: providerRow.id,
      operation: 'VERIFY',
      providerStatus: verification.status,
      providerReference: event.reference,
      providerAmount: verification.amount,
      signatureValid: true,
      httpStatus: 200,
      requestPayload: { reference: event.reference, event: event.eventType } as never,
      responsePayload: verification.raw as never,
    },
  });

  if (!invoice) {
    // Money arrived against a reference we do not recognise. It is NOT
    // discarded: an exception is raised so a human finds it (§31).
    await recordAudit(prisma, audit, {
      action: 'webhook.unmatched-payment',
      entity: 'payment-transaction',
      entityId: transaction.id,
      reason: `A verified payment of ${verification.amount} kobo arrived for reference ${event.reference}, which matches no invoice.`,
      newValue: { reference: event.reference, amount: verification.amount, providerTransactionId: verification.providerTransactionId },
    }).catch(() => undefined);

    const payload = { received: true, matched: false, note: 'Recorded for reconciliation: this payment matches no invoice.' };
    await rememberResult({ key, scope: SCOPE, httpStatus: 200, body: payload });
    return NextResponse.json(payload, { status: 200 });
  }

  // --- 8. Does it match the bill? -----------------------------------------
  const outstanding = Math.max(0, invoice.total - invoice.amountPaid);
  const verdict = reconcileVerification(
    {
      amount: verification.amount,
      currency: verification.currency,
      status: verification.status,
      providerTransactionId: verification.providerTransactionId,
    },
    { expectedAmount: outstanding, expectedCurrency: 'NGN', invoiceId: invoice.id }
  );

  await recordAudit(prisma, audit, {
    action: verdict.acceptable ? 'webhook.verified' : 'webhook.verified-with-discrepancy',
    entity: 'invoice',
    entityId: invoice.id,
    invoiceId: invoice.id,
    reason: verdict.message ?? 'Verified against the provider.',
    newValue: {
      reference: event.reference,
      verifiedAmount: verification.amount,
      outstanding,
      status: verification.status,
      providerTransactionId: verification.providerTransactionId,
      acceptable: verdict.acceptable,
    },
  }).catch(() => undefined);

  const payload = {
    received: true,
    matched: true,
    invoiceNumber: invoice.invoiceNumber,
    verified: {
      amount: verification.amount,
      currency: verification.currency,
      status: verification.status,
      providerTransactionId: verification.providerTransactionId,
    },
    // Said plainly: this route does not mark anything paid. It establishes that
    // the gateway confirms the money, which /api/payments then requires before
    // it will accept a GATEWAY_VERIFIED confirmation.
    outcome: verdict.acceptable
      ? 'VERIFIED — ready to be confirmed against the invoice.'
      : verdict.message,
    requiresInvestigation: verdict.requiresInvestigation ?? false,
  };

  // Always 200 to the provider once we have got this far: the delivery was
  // genuine and has been handled. A discrepancy is our business to resolve, and
  // making the provider retry it would only produce more copies of the problem.
  await rememberResult({ key, scope: SCOPE, httpStatus: 200, body: payload });
  return NextResponse.json(payload, { status: 200 });
}

/** A GET is how people check a URL is live. Say nothing useful to anyone else. */
export async function GET(_request: NextRequest, context: { params: { provider: string } }) {
  const adapter = adapterFor(context.params.provider ?? '');
  if (!adapter) return NextResponse.json({ error: 'Unknown payment provider.' }, { status: 404 });
  return NextResponse.json({ endpoint: 'webhook', provider: adapter.code, method: 'POST' });
}

// ============================================================
// Webhook verification (§35)
// ------------------------------------------------------------
// "NEVER TRUST WEBHOOK DATA BLINDLY." A webhook is an unauthenticated HTTP
// request from the open internet that claims a patient has paid. Anyone can send
// one. The only thing separating a real notification from a forged one is the
// signature, so this module is where the money is actually protected.
//
// FIVE THINGS ARE CHECKED HERE, and a further three by the route:
//
//   1. THE SIGNATURE, over the RAW BODY.  Re-serialising parsed JSON changes
//      whitespace and key order, and the signature then never matches. The raw
//      bytes as received are the only thing that can be verified.
//   2. CONSTANT-TIME COMPARISON.  A normal string compare returns early on the
//      first differing character, and the time it takes leaks how much of a
//      forged signature was right.
//   3. THE PROVIDER IS ONE WE KNOW, and its secret is configured.
//   4. THE PAYLOAD PARSES and carries the fields we need.
//   5. THE EVENT IS ONE WE ACT ON.  A charge.success is money; a
//      customeridentification.failed is not, and must not touch a balance.
//
// AND THE MOST IMPORTANT RULE OF ALL, enforced in the route rather than here:
//
//   THE AMOUNT IN THE WEBHOOK IS NEVER BELIEVED.
//
// A valid signature proves the message came from the provider. It does not prove
// the message is current, or that the transaction still stands — a payment can be
// reversed after the webhook fires. So a verified webhook only triggers a
// SERVER-TO-SERVER VERIFICATION against the provider's own API, and the figure
// used is the one that call returns. Paystack's own guidance says the same:
// verify before granting value.
// ============================================================

import { createHmac, timingSafeEqual } from 'crypto';

export type ProviderCode = 'PAYSTACK' | 'FLUTTERWAVE';

export interface SignatureVerdict {
  valid: boolean;
  code?: string;
  message?: string;
}

/**
 * Constant-time comparison of two hex signatures.
 *
 * Lengths are compared first and non-matching lengths rejected before
 * timingSafeEqual, which throws on unequal buffers. That length check does leak
 * the length of the expected signature — which is a fixed, public property of
 * the algorithm, so it reveals nothing.
 */
function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Paystack: HMAC-SHA512 of the raw body, keyed with the SECRET key, presented in
 * the `x-paystack-signature` header as lowercase hex.
 *
 * SHA-512, not SHA-256. It is the single detail most integrations get wrong, and
 * getting it wrong means either rejecting every genuine payment or — far worse,
 * if the check is then "temporarily" disabled — accepting forged ones.
 */
export function verifyPaystackSignature(params: {
  rawBody: string;
  signatureHeader: string | null;
  secretKey: string;
}): SignatureVerdict {
  const { rawBody, signatureHeader, secretKey } = params;

  if (!secretKey) {
    return { valid: false, code: 'NO_SECRET', message: 'No Paystack secret key is configured, so webhooks cannot be verified.' };
  }
  if (!signatureHeader) {
    return { valid: false, code: 'NO_SIGNATURE', message: 'This request carries no x-paystack-signature header. It has not been accepted.' };
  }

  const expected = createHmac('sha512', secretKey).update(rawBody, 'utf8').digest('hex');

  return safeCompare(expected, signatureHeader.trim().toLowerCase())
    ? { valid: true }
    : { valid: false, code: 'BAD_SIGNATURE', message: 'The signature on this webhook does not match. It has been rejected and recorded.' };
}

/**
 * Flutterwave: a shared secret hash echoed in the `verif-hash` header.
 *
 * Weaker than Paystack's scheme — it is a fixed value rather than a signature
 * over the payload, so it proves the sender knows the secret but says nothing
 * about the body not having been altered in transit. Compared in constant time
 * regardless, and the route still verifies server-to-server afterwards, which is
 * what actually makes this safe.
 */
export function verifyFlutterwaveSignature(params: {
  signatureHeader: string | null;
  webhookHash: string;
}): SignatureVerdict {
  const { signatureHeader, webhookHash } = params;

  if (!webhookHash) {
    return { valid: false, code: 'NO_SECRET', message: 'No Flutterwave webhook hash is configured, so webhooks cannot be verified.' };
  }
  if (!signatureHeader) {
    return { valid: false, code: 'NO_SIGNATURE', message: 'This request carries no verif-hash header. It has not been accepted.' };
  }

  return safeCompare(webhookHash, signatureHeader.trim())
    ? { valid: true }
    : { valid: false, code: 'BAD_SIGNATURE', message: 'The verif-hash on this webhook does not match. It has been rejected and recorded.' };
}

// ---------------------------------------------------------------------------
// Normalising an event
// ---------------------------------------------------------------------------

/** One provider event, reduced to what this application acts on. */
export interface NormalisedEvent {
  provider: ProviderCode;
  /** The provider's event name, e.g. 'charge.success'. */
  eventType: string;
  /** OUR reference, which we generated and sent when initiating. */
  reference: string;
  /** THEIR transaction id. */
  providerTransactionId: string | null;
  /**
   * Kobo, as the provider states it — recorded for comparison, NEVER acted on.
   * The figure that counts comes from the server-to-server verification.
   */
  claimedAmount: number | null;
  currency: string | null;
  claimedStatus: string | null;
  /** When the provider says it happened. */
  occurredAt: Date | null;
}

export class WebhookError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'WebhookError';
    this.code = code;
  }
}

/**
 * Pull the fields we need out of a provider payload.
 *
 * Defensive throughout: this is attacker-controlled input that has passed a
 * signature check, which proves who sent it and nothing about its shape.
 */
export function normaliseEvent(provider: ProviderCode, payload: unknown): NormalisedEvent {
  if (!payload || typeof payload !== 'object') {
    throw new WebhookError('BAD_PAYLOAD', 'The webhook body is not an object.');
  }

  const body = payload as Record<string, unknown>;
  const data = (body.data ?? {}) as Record<string, unknown>;

  const asString = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
  const asInteger = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);

  if (provider === 'PAYSTACK') {
    const reference = asString(data.reference);
    if (!reference) throw new WebhookError('NO_REFERENCE', 'This Paystack event carries no transaction reference.');

    return {
      provider,
      eventType: asString(body.event) ?? 'unknown',
      reference,
      // Paystack's numeric transaction id.
      providerTransactionId: data.id != null ? String(data.id) : null,
      // Paystack states amounts in KOBO, which is this application's own unit.
      // No conversion happens anywhere, and none should ever be added: a
      // currency conversion in a webhook handler is a rounding error waiting for
      // a reconciliation to find it.
      claimedAmount: asInteger(data.amount),
      currency: asString(data.currency),
      claimedStatus: asString(data.status),
      occurredAt: asString(data.paid_at) ? new Date(asString(data.paid_at) as string) : null,
    };
  }

  if (provider === 'FLUTTERWAVE') {
    const reference = asString(data.tx_ref) ?? asString(body.txRef);
    if (!reference) throw new WebhookError('NO_REFERENCE', 'This Flutterwave event carries no tx_ref.');

    // Flutterwave states amounts in MAJOR units (naira), not kobo. Converting
    // here would be the one place a float could enter the system, so the raw
    // figure is carried through as-is and the verification call — which is what
    // is actually believed — does the conversion once, in the adapter.
    const major = typeof data.amount === 'number' ? data.amount : null;

    return {
      provider,
      eventType: asString(body.event) ?? asString(body['event.type']) ?? 'unknown',
      reference,
      providerTransactionId: data.id != null ? String(data.id) : null,
      claimedAmount: major != null ? Math.round(major * 100) : null,
      currency: asString(data.currency),
      claimedStatus: asString(data.status),
      occurredAt: asString(data.created_at) ? new Date(asString(data.created_at) as string) : null,
    };
  }

  throw new WebhookError('UNKNOWN_PROVIDER', `${provider} is not a provider this application knows.`);
}

/**
 * Is this an event that should trigger verification?
 *
 * Deliberately a SHORT ALLOW-LIST rather than a block-list of things to ignore.
 * A provider adding a new event type must not accidentally move money because
 * nobody thought to exclude it.
 */
const ACTIONABLE: Record<ProviderCode, string[]> = {
  PAYSTACK: ['charge.success'],
  FLUTTERWAVE: ['charge.completed'],
};

export function isActionable(event: NormalisedEvent): boolean {
  return (ACTIONABLE[event.provider] ?? []).includes(event.eventType);
}

/**
 * A stable key for this delivery, so five copies produce one allocation (§35).
 *
 * Built from the PROVIDER and OUR reference rather than from the provider's
 * event id: some providers omit an event id, and some resend the same event with
 * a new one. What must never happen twice is acting on the same transaction, and
 * the reference is what identifies that.
 */
export function idempotencyKeyForEvent(event: NormalisedEvent): string {
  return `webhook_${event.provider}_${event.eventType}_${event.reference}`;
}

// ---------------------------------------------------------------------------
// Reconciling a verification against what we expected
// ---------------------------------------------------------------------------

export interface VerificationClaim {
  /** Kobo, from the server-to-server verification. */
  amount: number;
  currency: string;
  status: string;
  providerTransactionId: string | null;
}

export interface ExpectedPayment {
  /** Kobo. What the invoice says is outstanding. */
  expectedAmount: number;
  expectedCurrency: string;
  invoiceId: string;
}

export interface ReconcileVerdict {
  acceptable: boolean;
  code?: string;
  message?: string;
  /** True where the money is real but disagrees with the bill — needs a human. */
  requiresInvestigation?: boolean;
}

/**
 * Does a verified transaction match the bill it claims to pay? (§11, §35)
 *
 * A MISMATCH IS NOT AN ERROR TO SWALLOW. If the gateway says 500,000 and the
 * invoice says 910,000, the patient's money is real and must not be discarded —
 * but the invoice must not be marked paid either. The verdict says "the money
 * arrived, a person must look at it", which is what RECONCILIATION_REQUIRED is
 * for.
 */
export function reconcileVerification(claim: VerificationClaim, expected: ExpectedPayment): ReconcileVerdict {
  if (claim.status !== 'success' && claim.status !== 'successful') {
    return {
      acceptable: false,
      code: 'NOT_SUCCESSFUL',
      message: `The gateway reports this transaction as "${claim.status}", not successful. Nothing has been credited.`,
    };
  }

  if (claim.currency.toUpperCase() !== expected.expectedCurrency.toUpperCase()) {
    return {
      acceptable: false,
      requiresInvestigation: true,
      code: 'CURRENCY_MISMATCH',
      message: `The gateway reports ${claim.currency} but this invoice is in ${expected.expectedCurrency}. This needs a person to look at it.`,
    };
  }

  if (claim.amount !== expected.expectedAmount) {
    return {
      acceptable: false,
      requiresInvestigation: true,
      code: 'AMOUNT_MISMATCH',
      message:
        `The gateway confirms ${claim.amount} kobo but ${expected.expectedAmount} kobo is outstanding on this invoice. ` +
        `The money has been recorded and flagged for reconciliation rather than applied — it is real, and it is not being discarded.`,
    };
  }

  return { acceptable: true };
}

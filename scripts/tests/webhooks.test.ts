/**
 * Webhook verification.
 *
 * A webhook is an unauthenticated HTTP request from the open internet claiming a
 * patient has paid. The signature is the only thing separating a real one from a
 * forged one, so these are the tests that stop a stranger marking bills as paid.
 *
 * The forgery tests matter most: every one of them describes something an
 * attacker would actually try.
 */
import { describe, expect, it } from 'vitest';
import { createHmac } from 'crypto';

import {
  idempotencyKeyForEvent,
  isActionable,
  normaliseEvent,
  reconcileVerification,
  verifyFlutterwaveSignature,
  verifyPaystackSignature,
} from './payments/webhooks';

const SECRET = 'sk_test_a_secret_key_that_is_long_enough';

const paystackBody = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    event: 'charge.success',
    data: {
      id: 3021, reference: 'CTR-INV-000124', amount: 910_000_00,
      currency: 'NGN', status: 'success', paid_at: '2026-08-18T10:15:00.000Z',
      ...over,
    },
  });

const sign = (body: string, secret = SECRET) => createHmac('sha512', secret).update(body, 'utf8').digest('hex');

// ---------------------------------------------------------------------------
describe('Paystack signatures', () => {
  it('accepts a correctly signed body', () => {
    const body = paystackBody();
    expect(verifyPaystackSignature({ rawBody: body, signatureHeader: sign(body), secretKey: SECRET }).valid).toBe(true);
  });

  it('REJECTS a body that has been altered after signing', () => {
    // The attack: intercept a genuine webhook and change the amount.
    const original = paystackBody();
    const signature = sign(original);
    const tampered = paystackBody({ amount: 10_000_000_00 });
    expect(verifyPaystackSignature({ rawBody: tampered, signatureHeader: signature, secretKey: SECRET }).valid).toBe(false);
  });

  it('REJECTS a body signed with the wrong key', () => {
    const body = paystackBody();
    const forged = sign(body, 'sk_test_an_attackers_own_key');
    const v = verifyPaystackSignature({ rawBody: body, signatureHeader: forged, secretKey: SECRET });
    expect(v.valid).toBe(false);
    expect(v.code).toBe('BAD_SIGNATURE');
  });

  it('REJECTS a request with no signature at all', () => {
    const v = verifyPaystackSignature({ rawBody: paystackBody(), signatureHeader: null, secretKey: SECRET });
    expect(v.valid).toBe(false);
    expect(v.code).toBe('NO_SIGNATURE');
  });

  it('REJECTS an empty signature', () => {
    expect(verifyPaystackSignature({ rawBody: paystackBody(), signatureHeader: '', secretKey: SECRET }).valid).toBe(false);
  });

  it('REJECTS everything when no secret is configured', () => {
    // Better to reject every webhook than to accept every webhook.
    const body = paystackBody();
    const v = verifyPaystackSignature({ rawBody: body, signatureHeader: sign(body), secretKey: '' });
    expect(v.valid).toBe(false);
    expect(v.code).toBe('NO_SECRET');
  });

  it('uses SHA-512, not SHA-256', () => {
    // The detail most integrations get wrong. A SHA-256 signature must fail.
    const body = paystackBody();
    const sha256 = createHmac('sha256', SECRET).update(body, 'utf8').digest('hex');
    expect(verifyPaystackSignature({ rawBody: body, signatureHeader: sha256, secretKey: SECRET }).valid).toBe(false);
  });

  it('is insensitive to header case and surrounding whitespace', () => {
    const body = paystackBody();
    const signature = sign(body);
    expect(verifyPaystackSignature({ rawBody: body, signatureHeader: `  ${signature.toUpperCase()}  `, secretKey: SECRET }).valid).toBe(true);
  });

  it('is sensitive to whitespace INSIDE the body', () => {
    // Why the raw bytes must be used rather than re-serialised JSON: the same
    // object formatted differently is a different signature.
    const body = paystackBody();
    const reserialised = JSON.stringify(JSON.parse(body), null, 2);
    expect(verifyPaystackSignature({ rawBody: reserialised, signatureHeader: sign(body), secretKey: SECRET }).valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('Flutterwave signatures', () => {
  it('accepts the configured hash', () => {
    expect(verifyFlutterwaveSignature({ signatureHeader: 'my-hash', webhookHash: 'my-hash' }).valid).toBe(true);
  });

  it('rejects a wrong hash', () => {
    expect(verifyFlutterwaveSignature({ signatureHeader: 'not-my-hash', webhookHash: 'my-hash' }).valid).toBe(false);
  });

  it('rejects a missing hash', () => {
    expect(verifyFlutterwaveSignature({ signatureHeader: null, webhookHash: 'my-hash' }).code).toBe('NO_SIGNATURE');
  });

  it('rejects everything when unconfigured', () => {
    expect(verifyFlutterwaveSignature({ signatureHeader: 'anything', webhookHash: '' }).code).toBe('NO_SECRET');
  });

  it('does not accept a prefix of the correct hash', () => {
    expect(verifyFlutterwaveSignature({ signatureHeader: 'my-has', webhookHash: 'my-hash' }).valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('reading an event', () => {
  it('pulls out what Paystack sent', () => {
    const e = normaliseEvent('PAYSTACK', JSON.parse(paystackBody()));
    expect(e.reference).toBe('CTR-INV-000124');
    expect(e.providerTransactionId).toBe('3021');
    expect(e.claimedAmount).toBe(910_000_00);
    expect(e.currency).toBe('NGN');
    expect(e.eventType).toBe('charge.success');
  });

  it('keeps Paystack kobo as kobo, with no conversion anywhere', () => {
    // Paystack states amounts in kobo, which is this application's own unit.
    const e = normaliseEvent('PAYSTACK', JSON.parse(paystackBody({ amount: 1 })));
    expect(e.claimedAmount).toBe(1);
  });

  it('converts Flutterwave naira to kobo exactly once', () => {
    const e = normaliseEvent('FLUTTERWAVE', {
      event: 'charge.completed',
      data: { id: 99, tx_ref: 'CTR-INV-000124', amount: 9100.55, currency: 'NGN', status: 'successful' },
    });
    expect(e.claimedAmount).toBe(910_055);
  });

  it('refuses a payload with no reference — there is nothing to match it to', () => {
    expect(() => normaliseEvent('PAYSTACK', { event: 'charge.success', data: {} })).toThrow(/no transaction reference/i);
  });

  it('refuses a payload that is not an object', () => {
    expect(() => normaliseEvent('PAYSTACK', 'not json')).toThrow(/not an object/i);
    expect(() => normaliseEvent('PAYSTACK', null)).toThrow();
  });

  it('survives a payload missing every optional field', () => {
    const e = normaliseEvent('PAYSTACK', { data: { reference: 'r1' } });
    expect(e.claimedAmount).toBeNull();
    expect(e.eventType).toBe('unknown');
  });

  it('ignores a non-integer amount rather than rounding it into a balance', () => {
    const e = normaliseEvent('PAYSTACK', { event: 'charge.success', data: { reference: 'r1', amount: 1234.5 } });
    expect(e.claimedAmount).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('which events move money', () => {
  const event = (provider: 'PAYSTACK' | 'FLUTTERWAVE', eventType: string) => ({
    provider, eventType, reference: 'r1', providerTransactionId: null,
    claimedAmount: null, currency: null, claimedStatus: null, occurredAt: null,
  });

  it('acts on a Paystack charge.success', () => {
    expect(isActionable(event('PAYSTACK', 'charge.success'))).toBe(true);
  });

  it('acts on a Flutterwave charge.completed', () => {
    expect(isActionable(event('FLUTTERWAVE', 'charge.completed'))).toBe(true);
  });

  it('ignores everything else, including events invented later', () => {
    // An allow-list, not a block-list: a provider adding a new event type must
    // not move money because nobody thought to exclude it.
    for (const type of ['charge.failed', 'transfer.success', 'customeridentification.failed', 'subscription.create', 'charge.success.v2', '']) {
      expect(isActionable(event('PAYSTACK', type))).toBe(false);
    }
  });

  it('does not treat one provider\'s event name as another\'s', () => {
    expect(isActionable(event('FLUTTERWAVE', 'charge.success'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('five deliveries, one allocation (§35)', () => {
  const event = {
    provider: 'PAYSTACK' as const, eventType: 'charge.success', reference: 'CTR-INV-000124',
    providerTransactionId: '3021', claimedAmount: 910_000_00, currency: 'NGN',
    claimedStatus: 'success', occurredAt: null,
  };

  it('gives the same key for repeated deliveries of the same event', () => {
    expect(idempotencyKeyForEvent(event)).toBe(idempotencyKeyForEvent({ ...event }));
  });

  it('keys on OUR reference, not the provider transaction id', () => {
    // Some providers resend the same event with a new id. What must not happen
    // twice is acting on the same transaction.
    expect(idempotencyKeyForEvent({ ...event, providerTransactionId: '9999' })).toBe(idempotencyKeyForEvent(event));
  });

  it('gives different keys for different transactions', () => {
    expect(idempotencyKeyForEvent({ ...event, reference: 'CTR-INV-000125' })).not.toBe(idempotencyKeyForEvent(event));
  });

  it('gives different keys across providers', () => {
    expect(idempotencyKeyForEvent({ ...event, provider: 'FLUTTERWAVE' })).not.toBe(idempotencyKeyForEvent(event));
  });
});

// ---------------------------------------------------------------------------
describe('the verified figure must match the bill (§11)', () => {
  const expected = { expectedAmount: 910_000_00, expectedCurrency: 'NGN', invoiceId: 'inv1' };

  it('accepts an exact match', () => {
    const v = reconcileVerification(
      { amount: 910_000_00, currency: 'NGN', status: 'success', providerTransactionId: '3021' },
      expected
    );
    expect(v.acceptable).toBe(true);
  });

  it('accepts Flutterwave\'s "successful" as well as Paystack\'s "success"', () => {
    expect(reconcileVerification({ amount: 910_000_00, currency: 'NGN', status: 'successful', providerTransactionId: '1' }, expected).acceptable).toBe(true);
  });

  it('refuses anything not successful', () => {
    for (const status of ['failed', 'abandoned', 'pending', 'reversed']) {
      const v = reconcileVerification({ amount: 910_000_00, currency: 'NGN', status, providerTransactionId: '1' }, expected);
      expect(v.acceptable).toBe(false);
      expect(v.code).toBe('NOT_SUCCESSFUL');
    }
  });

  it('flags an amount mismatch for investigation rather than discarding the money', () => {
    // The patient's money is real. It must not be applied to the wrong bill,
    // and it must not vanish.
    const v = reconcileVerification({ amount: 500_000_00, currency: 'NGN', status: 'success', providerTransactionId: '1' }, expected);
    expect(v.acceptable).toBe(false);
    expect(v.code).toBe('AMOUNT_MISMATCH');
    expect(v.requiresInvestigation).toBe(true);
    expect(v.message).toContain('not being discarded');
  });

  it('flags a currency mismatch for investigation', () => {
    const v = reconcileVerification({ amount: 910_000_00, currency: 'USD', status: 'success', providerTransactionId: '1' }, expected);
    expect(v.code).toBe('CURRENCY_MISMATCH');
    expect(v.requiresInvestigation).toBe(true);
  });

  it('catches an underpayment by a single kobo', () => {
    expect(reconcileVerification({ amount: 909_999_99, currency: 'NGN', status: 'success', providerTransactionId: '1' }, expected).acceptable).toBe(false);
  });

  it('catches an OVERpayment too', () => {
    // An overpayment is as much a mismatch as a shortfall, and usually means the
    // wrong invoice was paid.
    expect(reconcileVerification({ amount: 910_000_01, currency: 'NGN', status: 'success', providerTransactionId: '1' }, expected).acceptable).toBe(false);
  });
});

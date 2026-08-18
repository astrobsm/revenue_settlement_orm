/**
 * Reconciliation.
 *
 * Each test below is a way money actually goes wrong in a hospital: a webhook
 * that never arrived, a payment counted twice, cash attested at a desk that was
 * never banked, a settlement marked done with nothing proving it.
 *
 * The clean-books test comes first, because a reconciliation that cries wolf on
 * a healthy day will be ignored on the day it matters.
 */
import { describe, expect, it } from 'vitest';

import { reconcile, ReconciliationInput, summarise } from './reconciliation';

const ASOF = new Date('2026-08-18T12:00:00Z');

const base = (over: Partial<ReconciliationInput> = {}): ReconciliationInput => ({
  periodStart: new Date('2026-08-17T00:00:00Z'),
  periodEnd: new Date('2026-08-18T00:00:00Z'),
  invoices: [],
  payments: [],
  gateway: [],
  bankCredits: [],
  distributions: [],
  settlements: [],
  ledger: { debits: 0, credits: 0 },
  asOf: ASOF,
  ...over,
});

const invoice = (over: Record<string, unknown> = {}) => ({
  id: 'inv1', invoiceNumber: 'CTR/INV/2026/000124', status: 'PAID',
  total: 910_000_00, amountPaid: 910_000_00, ...over,
});

const payment = (over: Record<string, unknown> = {}) => ({
  id: 'pay1', paymentNumber: 'CTR/PAY/2026/000124', invoiceId: 'inv1',
  amount: 910_000_00, currency: 'NGN', status: 'SUCCESSFUL',
  trustBasis: 'GATEWAY_VERIFIED', providerTransactionId: '3021',
  bankReference: 'PSTK-3021', confirmedAt: new Date('2026-08-17T10:00:00Z'),
  reversedAt: null, ...over,
});

// ---------------------------------------------------------------------------
describe('a clean day reports nothing', () => {
  it('finds no exceptions when everything agrees', () => {
    const r = reconcile(base({
      invoices: [invoice()],
      payments: [payment()],
      gateway: [{ providerReference: 'PSTK-3021', providerTransactionId: '3021', amount: 910_000_00, currency: 'NGN', status: 'success' }],
      bankCredits: [{ reference: 'PSTK-3021', amount: 910_000_00, valueDate: new Date('2026-08-17') }],
      distributions: [{ id: 'd1', invoiceId: 'inv1', paymentId: 'pay1', amount: 810_000_00, status: 'PENDING' }],
      ledger: { debits: 1_720_000_00, credits: 1_720_000_00 },
    }));
    expect(r.exceptions).toEqual([]);
    expect(r.balanced).toBe(true);
  });

  it('says so plainly', () => {
    const r = reconcile(base({ invoices: [invoice()], payments: [payment()],
      gateway: [{ providerReference: 'PSTK-3021', providerTransactionId: '3021', amount: 910_000_00, currency: 'NGN', status: 'success' }],
      bankCredits: [{ reference: 'PSTK-3021', amount: 910_000_00, valueDate: new Date('2026-08-17') }],
    }));
    expect(summarise(r)).toContain('reconcile against');
  });

  it('does not claim success when it checked nothing', () => {
    // A reconciliation that reassures without having examined anything is worse
    // than not running one.
    expect(summarise(reconcile(base()))).toContain('nothing to reconcile');
  });
});

// ---------------------------------------------------------------------------
describe('money the hospital cannot account for', () => {
  it('finds a payment attached to no invoice', () => {
    const r = reconcile(base({ payments: [payment({ invoiceId: null })] }));
    expect(r.exceptions.some((e) => e.type === 'PAYMENT_WITHOUT_INVOICE')).toBe(true);
    expect(r.exceptions[0].severity).toBe('CRITICAL');
  });

  it('finds a gateway payment this system never heard of', () => {
    // The missed webhook: the patient has paid and their invoice still shows
    // as owing. This is the one that produces angry patients at a desk.
    const r = reconcile(base({
      gateway: [{ providerReference: 'PSTK-9999', providerTransactionId: '9999', amount: 50_000_00, currency: 'NGN', status: 'success' }],
    }));
    const found = r.exceptions.find((e) => e.providerReference === 'PSTK-9999');
    expect(found?.type).toBe('PAYMENT_WITHOUT_INVOICE');
    expect(found?.detail).toContain('webhook');
  });

  it('ignores gateway rows that did not succeed', () => {
    const r = reconcile(base({
      gateway: [{ providerReference: 'PSTK-1', providerTransactionId: '1', amount: 100, currency: 'NGN', status: 'failed' }],
    }));
    expect(r.exceptions).toEqual([]);
  });

  it('finds a bank credit nobody has claimed', () => {
    // Money in the account belonging to somebody. Reported as loudly as money
    // missing — sitting in the hospital's account does not make it theirs.
    const r = reconcile(base({
      bankCredits: [{ reference: 'UNKNOWN-77', amount: 250_000_00, valueDate: new Date('2026-08-17') }],
    }));
    const found = r.exceptions.find((e) => e.type === 'UNMATCHED_BANK_CREDIT');
    expect(found).toBeDefined();
    expect(found?.detail).toContain('belongs to somebody');
  });
});

// ---------------------------------------------------------------------------
describe('invoices and payments disagreeing', () => {
  it('finds an invoice marked paid with no payment behind it', () => {
    const r = reconcile(base({ invoices: [invoice()], payments: [] }));
    const found = r.exceptions.find((e) => e.type === 'INVOICE_PAID_WITHOUT_GATEWAY_RECORD');
    expect(found?.severity).toBe('CRITICAL');
    expect(found?.difference).toBe(910_000_00);
  });

  it('finds an invoice whose amountPaid disagrees with its payments', () => {
    const r = reconcile(base({
      invoices: [invoice({ amountPaid: 910_000_00 })],
      payments: [payment({ amount: 400_000_00 })],
    }));
    const found = r.exceptions.find((e) => e.type === 'AMOUNT_MISMATCH' && e.invoiceId === 'inv1');
    expect(found?.difference).toBe(-510_000_00);
  });

  it('finds a payment whose amount disagrees with the gateway', () => {
    const r = reconcile(base({
      invoices: [invoice()],
      payments: [payment()],
      gateway: [{ providerReference: 'PSTK-3021', providerTransactionId: '3021', amount: 500_000_00, currency: 'NGN', status: 'success' }],
      bankCredits: [{ reference: 'PSTK-3021', amount: 500_000_00, valueDate: new Date() }],
    }));
    const found = r.exceptions.find((e) => e.type === 'AMOUNT_MISMATCH' && e.paymentId === 'pay1');
    expect(found?.severity).toBe('CRITICAL');
    expect(found?.difference).toBe(-410_000_00);
  });

  it('finds a currency mismatch', () => {
    const r = reconcile(base({
      invoices: [invoice()],
      payments: [payment()],
      gateway: [{ providerReference: 'PSTK-3021', providerTransactionId: '3021', amount: 910_000_00, currency: 'USD', status: 'success' }],
      bankCredits: [{ reference: 'PSTK-3021', amount: 910_000_00, valueDate: new Date() }],
    }));
    expect(r.exceptions.some((e) => e.type === 'CURRENCY_MISMATCH')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('the same money counted twice', () => {
  it('finds two payments claiming one gateway transaction', () => {
    const r = reconcile(base({
      invoices: [invoice()],
      payments: [
        payment({ id: 'pay1', paymentNumber: 'P1' }),
        payment({ id: 'pay2', paymentNumber: 'P2' }),
      ],
      bankCredits: [{ reference: 'PSTK-3021', amount: 910_000_00, valueDate: new Date() }],
    }));
    const found = r.exceptions.find((e) => e.type === 'DUPLICATE_TRANSACTION');
    expect(found?.severity).toBe('CRITICAL');
    expect(found?.detail).toContain('counted twice');
  });

  it('does not flag two genuinely separate payments', () => {
    const r = reconcile(base({
      invoices: [invoice({ total: 1_000_000_00, amountPaid: 1_000_000_00 })],
      payments: [
        payment({ id: 'pay1', paymentNumber: 'P1', amount: 600_000_00, providerTransactionId: '1', bankReference: 'R1' }),
        payment({ id: 'pay2', paymentNumber: 'P2', amount: 400_000_00, providerTransactionId: '2', bankReference: 'R2' }),
      ],
      bankCredits: [
        { reference: 'R1', amount: 600_000_00, valueDate: new Date() },
        { reference: 'R2', amount: 400_000_00, valueDate: new Date() },
      ],
    }));
    expect(r.exceptions.some((e) => e.type === 'DUPLICATE_TRANSACTION')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('attested desk payments are chased until the bank confirms them (§51)', () => {
  it('flags cash attested two days ago and never banked', () => {
    // This is the promise the trust model makes good on. Without this check,
    // "attested" would quietly come to mean "trusted".
    const r = reconcile(base({
      invoices: [invoice()],
      payments: [payment({
        trustBasis: 'ATTESTED', providerTransactionId: null, bankReference: null,
        confirmedAt: new Date('2026-08-15T10:00:00Z'),
      })],
    }));
    const found = r.exceptions.find((e) => e.type === 'UNRECONCILED_ATTESTED_PAYMENT');
    expect(found).toBeDefined();
    expect(found?.severity).toBe('HIGH');
  });

  it('does not flag one taken an hour ago', () => {
    const r = reconcile(base({
      invoices: [invoice()],
      payments: [payment({
        trustBasis: 'ATTESTED', providerTransactionId: null, bankReference: null,
        confirmedAt: new Date('2026-08-18T11:00:00Z'),
      })],
    }));
    expect(r.exceptions.some((e) => e.type === 'UNRECONCILED_ATTESTED_PAYMENT')).toBe(false);
  });

  it('clears once a matching bank credit appears', () => {
    const r = reconcile(base({
      invoices: [invoice()],
      payments: [payment({
        trustBasis: 'ATTESTED', providerTransactionId: null, bankReference: 'TELLER-4471',
        confirmedAt: new Date('2026-08-15T10:00:00Z'),
      })],
      bankCredits: [{ reference: 'TELLER-4471', amount: 910_000_00, valueDate: new Date('2026-08-16') }],
    }));
    expect(r.exceptions.some((e) => e.type === 'UNRECONCILED_ATTESTED_PAYMENT')).toBe(false);
  });

  it('respects a configured grace period', () => {
    const input = base({
      invoices: [invoice()],
      payments: [payment({
        trustBasis: 'ATTESTED', providerTransactionId: null, bankReference: null,
        confirmedAt: new Date('2026-08-17T00:00:00Z'), // 36 hours before asOf
      })],
    });
    expect(reconcile({ ...input, attestedGraceHours: 24 }).exceptions.some((e) => e.type === 'UNRECONCILED_ATTESTED_PAYMENT')).toBe(true);
    expect(reconcile({ ...input, attestedGraceHours: 72 }).exceptions.some((e) => e.type === 'UNRECONCILED_ATTESTED_PAYMENT')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('reversals and allocations', () => {
  it('finds an invoice still counting a reversed payment', () => {
    const r = reconcile(base({
      invoices: [invoice({ amountPaid: 910_000_00 })],
      payments: [payment({ reversedAt: new Date('2026-08-17T12:00:00Z') })],
    }));
    expect(r.exceptions.some((e) => e.type === 'REVERSED_PAYMENT')).toBe(true);
  });

  it('finds more allocated than was received', () => {
    // The engine cannot produce this. Anything that DOES produce it wrote
    // distributions without going through the engine, which is what this catches.
    const r = reconcile(base({
      invoices: [invoice()],
      payments: [payment()],
      gateway: [{ providerReference: 'PSTK-3021', providerTransactionId: '3021', amount: 910_000_00, currency: 'NGN', status: 'success' }],
      bankCredits: [{ reference: 'PSTK-3021', amount: 910_000_00, valueDate: new Date() }],
      distributions: [{ id: 'd1', invoiceId: 'inv1', paymentId: 'pay1', amount: 999_000_00, status: 'PENDING' }],
    }));
    const found = r.exceptions.find((e) => e.type === 'ALLOCATION_DOES_NOT_SUM');
    expect(found?.severity).toBe('CRITICAL');
  });

  it('accepts allocating LESS than received, because deposits are not revenue', () => {
    const r = reconcile(base({
      invoices: [invoice()],
      payments: [payment()],
      gateway: [{ providerReference: 'PSTK-3021', providerTransactionId: '3021', amount: 910_000_00, currency: 'NGN', status: 'success' }],
      bankCredits: [{ reference: 'PSTK-3021', amount: 910_000_00, valueDate: new Date() }],
      distributions: [{ id: 'd1', invoiceId: 'inv1', paymentId: 'pay1', amount: 810_000_00, status: 'PENDING' }],
    }));
    expect(r.exceptions.some((e) => e.type === 'ALLOCATION_DOES_NOT_SUM')).toBe(false);
  });

  it('ignores cancelled distributions', () => {
    const r = reconcile(base({
      invoices: [invoice()],
      payments: [payment()],
      gateway: [{ providerReference: 'PSTK-3021', providerTransactionId: '3021', amount: 910_000_00, currency: 'NGN', status: 'success' }],
      bankCredits: [{ reference: 'PSTK-3021', amount: 910_000_00, valueDate: new Date() }],
      distributions: [{ id: 'd1', invoiceId: 'inv1', paymentId: 'pay1', amount: 999_000_00, status: 'CANCELLED' }],
    }));
    expect(r.exceptions.some((e) => e.type === 'ALLOCATION_DOES_NOT_SUM')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('settlements', () => {
  const settlement = (over: Record<string, unknown> = {}) => ({
    id: 's1', settlementNumber: 'CTR/SET/2026/000001', accountId: 'acct1',
    amount: 500_000_00, status: 'CONFIRMED', bankReference: 'NIBSS-99120',
    claimedDistributionTotal: 500_000_00, ...over,
  });

  it('accepts a settlement that matches its distributions', () => {
    expect(reconcile(base({ settlements: [settlement()] })).exceptions).toEqual([]);
  });

  it('finds a settlement that does not match what it discharges', () => {
    const r = reconcile(base({ settlements: [settlement({ claimedDistributionTotal: 450_000_00 })] }));
    const found = r.exceptions.find((e) => e.type === 'SETTLEMENT_AMOUNT_MISMATCH');
    expect(found?.difference).toBe(50_000_00);
  });

  it('finds a failed settlement, because the beneficiary is still owed', () => {
    const r = reconcile(base({ settlements: [settlement({ status: 'FAILED' })] }));
    const found = r.exceptions.find((e) => e.type === 'FAILED_SETTLEMENT');
    expect(found?.detail).toContain('still owed');
  });

  it('finds a settlement confirmed with nothing proving it (§51)', () => {
    const r = reconcile(base({ settlements: [settlement({ bankReference: '   ' })] }));
    const found = r.exceptions.find((e) => e.detail.includes('looks'));
    expect(found?.severity).toBe('CRITICAL');
  });
});

// ---------------------------------------------------------------------------
describe('the ledger itself', () => {
  it('finds an out-of-balance ledger', () => {
    const r = reconcile(base({ ledger: { debits: 1_000_000_00, credits: 999_999_00 } }));
    const found = r.exceptions.find((e) => e.type === 'LEDGER_OUT_OF_BALANCE');
    expect(found?.severity).toBe('CRITICAL');
    expect(found?.difference).toBe(100);
  });
});

// ---------------------------------------------------------------------------
describe('the report is readable', () => {
  it('puts critical findings first', () => {
    const r = reconcile(base({
      invoices: [invoice()],
      payments: [
        payment({ id: 'pay1', paymentNumber: 'P1', invoiceId: null }),
        payment({ id: 'pay2', paymentNumber: 'P2', trustBasis: 'ATTESTED', providerTransactionId: null,
          bankReference: null, confirmedAt: new Date('2026-08-15T00:00:00Z') }),
      ],
    }));
    expect(r.exceptions[0].severity).toBe('CRITICAL');
    expect(r.counts.critical).toBeGreaterThan(0);
  });

  it('totals what was collected against what the bank shows', () => {
    const r = reconcile(base({
      invoices: [invoice()],
      payments: [payment()],
      gateway: [{ providerReference: 'PSTK-3021', providerTransactionId: '3021', amount: 910_000_00, currency: 'NGN', status: 'success' }],
      bankCredits: [{ reference: 'PSTK-3021', amount: 900_000_00, valueDate: new Date() }],
    }));
    expect(r.totals.collected).toBe(910_000_00);
    expect(r.totals.bankCredits).toBe(900_000_00);
    expect(r.totals.unmatchedAgainstBank).toBe(10_000_00);
  });

  it('does not count reversed payments as collected', () => {
    const r = reconcile(base({
      invoices: [invoice({ amountPaid: 0, status: 'ISSUED' })],
      payments: [payment({ reversedAt: new Date('2026-08-17T12:00:00Z') })],
    }));
    expect(r.totals.collected).toBe(0);
  });
});

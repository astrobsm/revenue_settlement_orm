/**
 * The double-entry ledger.
 *
 * One property: every entry balances, or nothing is written. The tests below try
 * hard to write an unbalanced entry and are all expected to fail to do so.
 *
 * The §17 distinction is tested explicitly, because it is the one most revenue
 * systems collapse: money RECEIVED, money SETTLED and money RECONCILED are three
 * different balances, and instructing a transfer moves nothing at all.
 */
import { describe, expect, it } from 'vitest';

import {
  balances,
  entryDepositApplied,
  entryInvoiceIssued,
  entryPaymentReceived,
  entryReconciliationDifference,
  entryRefundApproved,
  entryRefundPaid,
  entryRevenueAllocated,
  entrySettlementConfirmed,
  LedgerEntry,
  naturalSide,
  post,
  reverse,
  settlementChain,
  trialBalance,
} from './ledger';

const balanceOf = (entries: LedgerEntry[], account: string) =>
  balances(entries).find((b) => b.account === account)?.balance ?? 0;

describe('an entry must balance', () => {
  it('refuses debits that do not equal credits', () => {
    expect(() =>
      post({
        eventType: 'PAYMENT_RECEIVED',
        postings: [
          { account: 'CASH_AT_BANK', side: 'DEBIT', amount: 100_00 },
          { account: 'ACCOUNTS_RECEIVABLE', side: 'CREDIT', amount: 99_00 },
        ],
      })
    ).toThrow(/does not balance/i);
  });

  it('refuses a one-sided entry', () => {
    expect(() =>
      post({
        eventType: 'PAYMENT_RECEIVED',
        postings: [{ account: 'CASH_AT_BANK', side: 'DEBIT', amount: 100_00 }],
      })
    ).toThrow(/at least two postings/i);
  });

  it('refuses a negative posting — direction is DEBIT or CREDIT, never a sign', () => {
    expect(() =>
      post({
        eventType: 'ADJUSTMENT',
        postings: [
          { account: 'CASH_AT_BANK', side: 'DEBIT', amount: -100_00 },
          { account: 'REVENUE', side: 'CREDIT', amount: -100_00 },
        ],
      })
    ).toThrow(/always positive/i);
  });

  it('refuses an entry for zero', () => {
    expect(() =>
      post({
        eventType: 'ADJUSTMENT',
        postings: [
          { account: 'CASH_AT_BANK', side: 'DEBIT', amount: 0 },
          { account: 'REVENUE', side: 'CREDIT', amount: 0 },
        ],
      })
    ).toThrow();
  });

  it('accepts a balanced entry and reports its amount once', () => {
    const e = post({
      eventType: 'PAYMENT_RECEIVED',
      postings: [
        { account: 'CASH_AT_BANK', side: 'DEBIT', amount: 910_000_00 },
        { account: 'ACCOUNTS_RECEIVABLE', side: 'CREDIT', amount: 910_000_00 },
      ],
    });
    expect(e.amount).toBe(910_000_00);
  });
});

describe('issuing an invoice', () => {
  it('books services as revenue and a deposit as a liability (§21)', () => {
    const e = entryInvoiceIssued({
      invoiceId: 'inv1',
      grossServiceAmount: 810_000_00,
      taxAmount: 0,
      discountAmount: 0,
      depositAmount: 100_000_00,
    });
    expect(balanceOf([e], 'REVENUE')).toBe(810_000_00);
    // The critical assertion: the deposit is NOT revenue.
    expect(balanceOf([e], 'PATIENT_DEPOSIT_LIABILITY')).toBe(100_000_00);
    expect(balanceOf([e], 'ACCOUNTS_RECEIVABLE')).toBe(910_000_00);
  });

  it('records a discount gross, so what was given away is reportable', () => {
    const e = entryInvoiceIssued({
      invoiceId: 'inv1',
      grossServiceAmount: 100_000_00,
      taxAmount: 0,
      discountAmount: 20_000_00,
      depositAmount: 0,
    });
    expect(trialBalance([e]).balanced).toBe(true);
    expect(balanceOf([e], 'REVENUE')).toBe(100_000_00);
    expect(balanceOf([e], 'DISCOUNT_GIVEN')).toBe(20_000_00);
    // The patient owes the net.
    expect(balanceOf([e], 'ACCOUNTS_RECEIVABLE')).toBe(80_000_00);
  });

  it('separates tax from revenue', () => {
    const e = entryInvoiceIssued({
      invoiceId: 'inv1', grossServiceAmount: 100_000_00, taxAmount: 7_500_00,
      discountAmount: 0, depositAmount: 0,
    });
    expect(balanceOf([e], 'TAX_PAYABLE')).toBe(7_500_00);
    expect(balanceOf([e], 'REVENUE')).toBe(100_000_00);
  });

  it('refuses a discount larger than the services billed', () => {
    expect(() =>
      entryInvoiceIssued({
        invoiceId: 'inv1', grossServiceAmount: 10_000_00, taxAmount: 0,
        discountAmount: 20_000_00, depositAmount: 0,
      })
    ).toThrow(/exceeds/i);
  });
});

describe('the §17 chain: received, settled, reconciled are different states', () => {
  const invoiceId = 'inv-910';
  const issued = entryInvoiceIssued({
    invoiceId, grossServiceAmount: 810_000_00, taxAmount: 0, discountAmount: 0, depositAmount: 100_000_00,
  });
  const received = entryPaymentReceived({ invoiceId, paymentId: 'pay1', amount: 910_000_00 });
  const allocated = entryRevenueAllocated({
    invoiceId,
    paymentId: 'pay1',
    shares: [
      { revenueAccountId: 'acct-surgery', amount: 500_000_00, chargeKind: 'PROFESSIONAL_SURGEON' },
      { revenueAccountId: 'acct-anaesthesia', amount: 100_000_00, chargeKind: 'PROFESSIONAL_ANAESTHETIST' },
      { revenueAccountId: 'acct-pharmacy', amount: 130_000_00, chargeKind: 'DRUG' },
      { revenueAccountId: 'acct-consumables', amount: 80_000_00, chargeKind: 'CONSUMABLE' },
    ],
  });

  it('the whole chain balances', () => {
    expect(trialBalance([issued, received, allocated]).balanced).toBe(true);
  });

  it('a payment moves the patient debt into the hospital bank', () => {
    expect(balanceOf([issued, received], 'CASH_AT_BANK')).toBe(910_000_00);
    expect(balanceOf([issued, received], 'ACCOUNTS_RECEIVABLE')).toBe(0);
  });

  it('allocation turns revenue into money owed to beneficiaries', () => {
    const entries = [issued, received, allocated];
    expect(balanceOf(entries, 'SETTLEMENT_PAYABLE')).toBe(810_000_00);
  });

  it('an INSTRUCTED settlement moves nothing (§51)', () => {
    // There is deliberately no entry function for "settlement initiated".
    // Instructing a bank does not move money, and posting as though it did is
    // exactly the false impression §51 forbids.
    const entries = [issued, received, allocated];
    expect(settlementChain(entries).settled).toBe(0);
    // The money is still sitting in the hospital's bank, all of it.
    expect(balanceOf(entries, 'CASH_AT_BANK')).toBe(910_000_00);
  });

  it('only a CONFIRMED settlement moves money out of the bank', () => {
    const confirmed = entrySettlementConfirmed({
      settlementId: 'set1', revenueAccountId: 'acct-surgery',
      amount: 500_000_00, bankReference: 'NIBSS-99120',
    });
    const entries = [issued, received, allocated, confirmed];
    expect(settlementChain(entries).settled).toBe(500_000_00);
    // What is still owed to beneficiaries drops by exactly that much...
    expect(balanceOf(entries, 'SETTLEMENT_PAYABLE')).toBe(310_000_00);
    // ...and the bank genuinely holds less. There is no account in which the
    // hospital can show cash it has already paid away.
    expect(balanceOf(entries, 'CASH_AT_BANK')).toBe(410_000_00);
    expect(trialBalance(entries).balanced).toBe(true);
  });

  it('derives the whole §30 chain from the postings, so it cannot drift', () => {
    const confirmed = entrySettlementConfirmed({
      settlementId: 'set1', revenueAccountId: 'acct-surgery',
      amount: 500_000_00, bankReference: 'NIBSS-99120',
    });
    const chain = settlementChain([issued, received, allocated, confirmed]);
    expect(chain.collected).toBe(910_000_00);
    expect(chain.allocated).toBe(810_000_00);
    expect(chain.settled).toBe(500_000_00);
    expect(chain.settlementPending).toBe(310_000_00);
  });

  it('refuses to confirm a settlement with no bank reference', () => {
    expect(() =>
      entrySettlementConfirmed({
        settlementId: 'set1', revenueAccountId: 'a', amount: 100, bankReference: '  ',
      })
    ).toThrow(/reference/i);
  });
});

describe('deposits are drawn down, not spent (§21)', () => {
  it('moves liability into revenue only as services are consumed', () => {
    const issued = entryInvoiceIssued({
      invoiceId: 'inv1', grossServiceAmount: 0, taxAmount: 0, discountAmount: 0, depositAmount: 500_000_00,
    });
    const received = entryPaymentReceived({ invoiceId: 'inv1', paymentId: 'p1', amount: 500_000_00 });
    const applied = entryDepositApplied({
      depositId: 'dep1', invoiceId: 'inv1', amount: 120_000_00, chargeKind: 'BED_CHARGE',
    });

    const entries = [issued, received, applied];
    // 500,000 taken; 120,000 earned; 380,000 still the patient's money.
    expect(balanceOf(entries, 'PATIENT_DEPOSIT_LIABILITY')).toBe(380_000_00);
    expect(balanceOf(entries, 'REVENUE')).toBe(120_000_00);
    expect(trialBalance(entries).balanced).toBe(true);
  });
});

describe('refunds', () => {
  it('approving a refund creates a debt to the patient, not a payment', () => {
    const approved = entryRefundApproved({ refundId: 'r1', invoiceId: 'inv1', amount: 50_000_00 });
    expect(balanceOf([approved], 'REFUND_PAYABLE')).toBe(50_000_00);
    // The money has not left yet.
    expect(balanceOf([approved], 'CASH_AT_BANK')).toBe(0);
  });

  it('paying it takes the money out of the bank', () => {
    const approved = entryRefundApproved({ refundId: 'r1', invoiceId: 'inv1', amount: 50_000_00 });
    const paid = entryRefundPaid({ refundId: 'r1', amount: 50_000_00, bankReference: 'RFD-771' });
    const entries = [approved, paid];
    expect(balanceOf(entries, 'REFUND_PAYABLE')).toBe(0);
    expect(balanceOf(entries, 'CASH_AT_BANK')).toBe(-50_000_00);
    expect(trialBalance(entries).balanced).toBe(true);
  });

  it('refuses to pay a refund with no reference', () => {
    expect(() => entryRefundPaid({ refundId: 'r1', amount: 100, bankReference: '' })).toThrow(/reference/i);
  });
});

describe('corrections are compensating entries, never edits (§18, §23)', () => {
  const original = entryPaymentReceived({ invoiceId: 'inv1', paymentId: 'p1', amount: 100_000_00 });

  it('a reversal flips every side and leaves the original alone', () => {
    const reversal = reverse({ original, originalEntryId: 'entry-1', reason: 'Payment keyed against the wrong invoice.' });
    expect(reversal.postings.find((p) => p.account === 'CASH_AT_BANK')?.side).toBe('CREDIT');
    // The original is untouched — this is the whole point.
    expect(original.postings.find((p) => p.account === 'CASH_AT_BANK')?.side).toBe('DEBIT');
    expect(reversal.refs.reversesEntryId).toBe('entry-1');
  });

  it('the pair nets to nothing', () => {
    const reversal = reverse({ original, originalEntryId: 'entry-1', reason: 'Payment keyed against the wrong invoice.' });
    expect(balanceOf([original, reversal], 'CASH_AT_BANK')).toBe(0);
    expect(trialBalance([original, reversal]).balanced).toBe(true);
  });

  it('demands a reason worth reading', () => {
    expect(() => reverse({ original, originalEntryId: 'e1', reason: 'oops' })).toThrow(/reason/i);
  });
});

describe('unexplained differences go to suspense, not to revenue (§31)', () => {
  it('parks a bank surplus in suspense', () => {
    const e = entryReconciliationDifference({
      amount: 5_000_00, bankHasMore: true, memo: 'Unmatched credit on statement 0091',
    });
    expect(balanceOf([e], 'SUSPENSE')).toBe(-5_000_00);
    expect(balanceOf([e], 'CASH_AT_BANK')).toBe(5_000_00);
  });

  it('parks a shortfall in suspense too', () => {
    const e = entryReconciliationDifference({
      amount: 5_000_00, bankHasMore: false, memo: 'Books exceed statement',
    });
    expect(balanceOf([e], 'SUSPENSE')).toBe(5_000_00);
    expect(trialBalance([e]).balanced).toBe(true);
  });
});

describe('account classification', () => {
  it('liabilities are credit-natured, so a liability reads positive', () => {
    expect(naturalSide('PATIENT_DEPOSIT_LIABILITY')).toBe('CREDIT');
    expect(naturalSide('SETTLEMENT_PAYABLE')).toBe('CREDIT');
    expect(naturalSide('REFUND_PAYABLE')).toBe('CREDIT');
    expect(naturalSide('TAX_PAYABLE')).toBe('CREDIT');
    expect(naturalSide('REVENUE')).toBe('CREDIT');
  });

  it('assets and contra-revenue are debit-natured', () => {
    expect(naturalSide('CASH_AT_BANK')).toBe('DEBIT');
    expect(naturalSide('ACCOUNTS_RECEIVABLE')).toBe('DEBIT');
    expect(naturalSide('DISCOUNT_GIVEN')).toBe('DEBIT');
  });
});

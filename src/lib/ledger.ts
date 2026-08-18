// ============================================================
// The double-entry ledger (§17, §18, §23, §51)
// ------------------------------------------------------------
// Every financial event in this application becomes a set of BALANCED POSTINGS:
// debits equal credits, always, or the event is refused and nothing is written.
//
// Why bother, when the invoice already has a total and the distribution already
// has shares? Because those two records can disagree, and without a ledger
// nothing notices. The ledger is the one structure that makes disagreement
// impossible to hide: if the books balance, the money is accounted for; if they
// do not, post() throws and no financial record is created.
//
// THE THREE STATES §17 INSISTS ARE DIFFERENT
//
//   PAYMENT RECEIVED   the hospital holds the money
//   FUNDS SETTLED      the money has been sent to the account that earned it
//   FUNDS RECONCILED   a bank statement agrees
//
// Most revenue systems collapse these into one boolean and then cannot answer
// "where is the money?". Here they are three separate accounts, and money moves
// between them by posting, so the answer is always derivable.
//
// NOTHING IS EVER UPDATED OR DELETED. A correction is a COMPENSATING ENTRY — a
// new, equal, opposite posting that references the original. That is why
// reverse() exists and why there is no update function anywhere in this module.
// ============================================================

import { assertKobo, sumKobo } from './money';

/**
 * The account types money moves between. These are ledger classifications, not
 * bank accounts — a RevenueAccount row is the bank destination; these say what
 * KIND of thing an amount is.
 */
export type LedgerAccountType =
  /** Money owed to the hospital by a patient. Rises when an invoice is issued. */
  | 'ACCOUNTS_RECEIVABLE'
  /** Money the hospital physically holds, before it is allocated out. */
  | 'CASH_AT_BANK'
  /** Held for a patient, not yet earned (§21). A LIABILITY. */
  | 'PATIENT_DEPOSIT_LIABILITY'
  /** Earned income, by service. */
  | 'REVENUE'
  /** Allocated to a beneficiary but not yet transferred. A LIABILITY. */
  | 'SETTLEMENT_PAYABLE'
  /** Money owed back to a patient. A LIABILITY. */
  | 'REFUND_PAYABLE'
  /** Tax collected on behalf of the revenue authority. A LIABILITY. */
  | 'TAX_PAYABLE'
  /** Discounts and waivers given. A contra-revenue account. */
  | 'DISCOUNT_GIVEN'
  /** Where an unexplained difference sits until somebody explains it (§31). */
  | 'SUSPENSE';

/** Which side increases each account. Getting this wrong inverts a balance sheet. */
const NATURAL_SIDE: Record<LedgerAccountType, 'DEBIT' | 'CREDIT'> = {
  ACCOUNTS_RECEIVABLE: 'DEBIT',
  CASH_AT_BANK: 'DEBIT',
  PATIENT_DEPOSIT_LIABILITY: 'CREDIT',
  REVENUE: 'CREDIT',
  SETTLEMENT_PAYABLE: 'CREDIT',
  REFUND_PAYABLE: 'CREDIT',
  TAX_PAYABLE: 'CREDIT',
  DISCOUNT_GIVEN: 'DEBIT',
  SUSPENSE: 'DEBIT',
};

export function naturalSide(account: LedgerAccountType): 'DEBIT' | 'CREDIT' {
  return NATURAL_SIDE[account];
}

/** The events that can move money. Each maps to a fixed posting shape. */
export type LedgerEventType =
  | 'INVOICE_ISSUED'
  | 'PAYMENT_RECEIVED'
  | 'DEPOSIT_RECEIVED'
  | 'DEPOSIT_APPLIED'
  | 'REVENUE_ALLOCATED'
  | 'SETTLEMENT_INITIATED'
  | 'SETTLEMENT_CONFIRMED'
  | 'SETTLEMENT_FAILED'
  | 'REFUND_APPROVED'
  | 'REFUND_PAID'
  | 'PAYMENT_REVERSED'
  | 'ADJUSTMENT'
  | 'DISCOUNT_APPLIED'
  | 'RECONCILIATION_DIFFERENCE';

export interface Posting {
  account: LedgerAccountType;
  side: 'DEBIT' | 'CREDIT';
  /** Kobo. Always positive — direction is carried by `side`, never by a sign. */
  amount: number;
  /** The beneficiary revenue account, where the posting concerns one. */
  revenueAccountId?: string | null;
  /** Charge kind, so a revenue report can be produced by service (§46). */
  chargeKind?: string | null;
  memo?: string;
}

export interface LedgerEntry {
  eventType: LedgerEventType;
  /** What this entry is about, so every posting traces to a real record (§33). */
  refs: {
    invoiceId?: string | null;
    paymentId?: string | null;
    settlementId?: string | null;
    refundId?: string | null;
    depositId?: string | null;
    /** The entry this one corrects, for a compensating posting. */
    reversesEntryId?: string | null;
  };
  postings: Posting[];
  /** Total of one side. Both sides equal this. */
  amount: number;
  occurredAt: Date;
  createdByUserId: string | null;
  memo?: string;
}

export class LedgerError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

/**
 * Assemble a balanced entry, or refuse.
 *
 * This is the only way postings are created. It is deliberately strict: an
 * unbalanced entry is a bug that would otherwise become an unexplainable
 * difference in a report months later, and the cheapest place to catch it is
 * before anything is written.
 */
export function post(params: {
  eventType: LedgerEventType;
  postings: Posting[];
  refs?: LedgerEntry['refs'];
  occurredAt?: Date;
  createdByUserId?: string | null;
  memo?: string;
}): LedgerEntry {
  const { eventType, postings, refs = {}, occurredAt = new Date(), createdByUserId = null, memo } = params;

  if (postings.length < 2) {
    throw new LedgerError('INCOMPLETE_ENTRY', `A ${eventType} entry needs at least two postings; every movement of money comes from somewhere and goes somewhere.`);
  }

  for (const p of postings) {
    assertKobo(p.amount, `posting to ${p.account}`);
    if (p.amount <= 0) {
      throw new LedgerError(
        'SIGNED_POSTING',
        `A posting to ${p.account} has an amount of ${p.amount}. Postings are always positive; direction is carried by DEBIT or CREDIT, never by a minus sign. Use reverse() to undo an entry.`
      );
    }
  }

  const debits = sumKobo(postings.filter((p) => p.side === 'DEBIT').map((p) => p.amount));
  const credits = sumKobo(postings.filter((p) => p.side === 'CREDIT').map((p) => p.amount));

  if (debits !== credits) {
    throw new LedgerError(
      'UNBALANCED',
      `This ${eventType} entry does not balance: ${debits} kobo debited against ${credits} kobo credited. Nothing has been written.`
    );
  }
  if (debits === 0) {
    throw new LedgerError('EMPTY_ENTRY', `A ${eventType} entry for zero kobo says nothing. It has not been written.`);
  }

  return { eventType, refs, postings, amount: debits, occurredAt, createdByUserId, memo };
}

/**
 * The compensating entry that undoes another (§18).
 *
 * Every side is flipped and the original is referenced. The original is left
 * exactly as it was — this is the whole point. A reversal that edited the
 * original would destroy the record of what was believed at the time, which is
 * the one thing an audit needs.
 */
export function reverse(params: {
  original: LedgerEntry;
  originalEntryId: string;
  reason: string;
  occurredAt?: Date;
  createdByUserId?: string | null;
}): LedgerEntry {
  const { original, originalEntryId, reason, occurredAt = new Date(), createdByUserId = null } = params;

  const trimmed = reason?.trim() ?? '';
  if (trimmed.length < 10) {
    throw new LedgerError('REASON_REQUIRED', 'A reversal needs a reason. An unexplained reversal is what an auditor asks about first.');
  }

  return post({
    eventType: original.eventType,
    postings: original.postings.map((p) => ({
      ...p,
      side: p.side === 'DEBIT' ? 'CREDIT' : 'DEBIT',
      memo: `Reversal: ${trimmed}`,
    })),
    refs: { ...original.refs, reversesEntryId: originalEntryId },
    occurredAt,
    createdByUserId,
    memo: `Reverses ${originalEntryId}: ${trimmed}`,
  });
}

// ---------------------------------------------------------------------------
// The standard entries
// ---------------------------------------------------------------------------
// Each function below encodes one financial event's posting shape once, so no
// route has to remember which side a deposit goes on.

/**
 * An invoice is issued: the patient now owes the hospital.
 *
 * `grossServiceAmount` is the service subtotal BEFORE discount. Revenue is
 * credited gross and the discount debited to its own contra account, rather than
 * crediting a net figure — otherwise the hospital has no record of what it gave
 * away, and "total discounts granted this quarter" becomes unanswerable (§46).
 *
 *   DEBIT   Accounts receivable       gross - discount + tax + deposit
 *   DEBIT   Discount given            discount
 *   CREDIT  Revenue                   gross
 *   CREDIT  Tax payable               tax
 *   CREDIT  Patient deposit liability deposit
 */
export function entryInvoiceIssued(params: {
  invoiceId: string;
  /** Service subtotal before discount. */
  grossServiceAmount: number;
  taxAmount: number;
  discountAmount: number;
  depositAmount: number;
  createdByUserId?: string | null;
  occurredAt?: Date;
}): LedgerEntry {
  const { invoiceId, grossServiceAmount, taxAmount, discountAmount, depositAmount } = params;

  if (discountAmount > grossServiceAmount) {
    throw new LedgerError(
      'DISCOUNT_EXCEEDS_SERVICES',
      `A discount of ${discountAmount} kobo exceeds the ${grossServiceAmount} kobo of services billed. A discount cannot be larger than the bill it reduces.`
    );
  }

  const receivable = grossServiceAmount - discountAmount + taxAmount + depositAmount;
  const postings: Posting[] = [];

  if (receivable > 0) postings.push({ account: 'ACCOUNTS_RECEIVABLE', side: 'DEBIT', amount: receivable, memo: 'Invoice issued' });
  if (discountAmount > 0) postings.push({ account: 'DISCOUNT_GIVEN', side: 'DEBIT', amount: discountAmount, memo: 'Discount granted' });
  if (grossServiceAmount > 0) postings.push({ account: 'REVENUE', side: 'CREDIT', amount: grossServiceAmount, memo: 'Services billed' });
  if (taxAmount > 0) postings.push({ account: 'TAX_PAYABLE', side: 'CREDIT', amount: taxAmount, memo: 'Tax billed' });
  if (depositAmount > 0) {
    // NOT revenue. The hospital owes this back until services are consumed (§21).
    postings.push({ account: 'PATIENT_DEPOSIT_LIABILITY', side: 'CREDIT', amount: depositAmount, memo: 'Deposit requested' });
  }

  return post({ eventType: 'INVOICE_ISSUED', postings, refs: { invoiceId }, occurredAt: params.occurredAt, createdByUserId: params.createdByUserId });
}

/** Money arrives: the hospital holds it and the patient owes less. */
export function entryPaymentReceived(params: {
  invoiceId: string;
  paymentId: string;
  amount: number;
  createdByUserId?: string | null;
  occurredAt?: Date;
  memo?: string;
}): LedgerEntry {
  return post({
    eventType: 'PAYMENT_RECEIVED',
    postings: [
      { account: 'CASH_AT_BANK', side: 'DEBIT', amount: params.amount, memo: 'Payment received' },
      { account: 'ACCOUNTS_RECEIVABLE', side: 'CREDIT', amount: params.amount, memo: 'Patient balance reduced' },
    ],
    refs: { invoiceId: params.invoiceId, paymentId: params.paymentId },
    occurredAt: params.occurredAt,
    createdByUserId: params.createdByUserId,
    memo: params.memo,
  });
}

/**
 * Revenue is allocated: money the hospital holds becomes money owed to specific
 * beneficiaries. This is the posting that makes §30's chain real.
 */
export function entryRevenueAllocated(params: {
  invoiceId: string;
  paymentId?: string | null;
  shares: { revenueAccountId: string; amount: number; chargeKind?: string | null }[];
  createdByUserId?: string | null;
  occurredAt?: Date;
}): LedgerEntry {
  const total = sumKobo(params.shares.map((s) => s.amount), 'share');

  const postings: Posting[] = [
    { account: 'REVENUE', side: 'DEBIT', amount: total, memo: 'Revenue allocated to beneficiaries' },
    ...params.shares.map((s) => ({
      account: 'SETTLEMENT_PAYABLE' as const,
      side: 'CREDIT' as const,
      amount: s.amount,
      revenueAccountId: s.revenueAccountId,
      chargeKind: s.chargeKind ?? null,
      memo: 'Owed to beneficiary',
    })),
  ];

  return post({
    eventType: 'REVENUE_ALLOCATED',
    postings,
    refs: { invoiceId: params.invoiceId, paymentId: params.paymentId ?? null },
    occurredAt: params.occurredAt,
    createdByUserId: params.createdByUserId,
  });
}

/**
 * A settlement is CONFIRMED by the bank — not merely instructed.
 *
 * There is deliberately no entry for "settlement initiated moves the money":
 * instructing a transfer does not move anything, and posting as though it did is
 * precisely the false impression §51 forbids. An initiated settlement changes a
 * status; only a confirmed one posts.
 */
export function entrySettlementConfirmed(params: {
  settlementId: string;
  revenueAccountId: string;
  amount: number;
  createdByUserId?: string | null;
  occurredAt?: Date;
  bankReference: string;
}): LedgerEntry {
  if (!params.bankReference?.trim()) {
    throw new LedgerError(
      'REFERENCE_REQUIRED',
      'A confirmed settlement must carry the bank reference that proves it. "Settled, no reference" is worse than leaving it pending: it looks reconciled and cannot be checked.'
    );
  }
  return post({
    eventType: 'SETTLEMENT_CONFIRMED',
    postings: [
      // The liability to the beneficiary is discharged...
      { account: 'SETTLEMENT_PAYABLE', side: 'DEBIT', amount: params.amount, revenueAccountId: params.revenueAccountId, memo: 'Beneficiary paid' },
      // ...and the money genuinely leaves the hospital's bank. There is no
      // separate "settled" account: money that has gone is simply money the
      // bank no longer holds. Inventing an account for it would let the books
      // show cash the hospital does not have. The §17 settled TOTAL is derived
      // instead — see settlementChain().
      { account: 'CASH_AT_BANK', side: 'CREDIT', amount: params.amount, memo: `Bank ref ${params.bankReference}` },
    ],
    refs: { settlementId: params.settlementId },
    occurredAt: params.occurredAt,
    createdByUserId: params.createdByUserId,
    memo: `Bank reference ${params.bankReference}`,
  });
}

/** A deposit is drawn down against a real charge: liability becomes revenue (§21). */
export function entryDepositApplied(params: {
  depositId: string;
  invoiceId: string;
  amount: number;
  chargeKind?: string | null;
  createdByUserId?: string | null;
  occurredAt?: Date;
}): LedgerEntry {
  return post({
    eventType: 'DEPOSIT_APPLIED',
    postings: [
      { account: 'PATIENT_DEPOSIT_LIABILITY', side: 'DEBIT', amount: params.amount, memo: 'Deposit drawn down' },
      { account: 'REVENUE', side: 'CREDIT', amount: params.amount, chargeKind: params.chargeKind ?? null, memo: 'Service consumed against deposit' },
    ],
    refs: { depositId: params.depositId, invoiceId: params.invoiceId },
    occurredAt: params.occurredAt,
    createdByUserId: params.createdByUserId,
  });
}

/** A refund is approved: the hospital now owes the patient. */
export function entryRefundApproved(params: {
  refundId: string;
  invoiceId: string;
  amount: number;
  createdByUserId?: string | null;
  occurredAt?: Date;
}): LedgerEntry {
  return post({
    eventType: 'REFUND_APPROVED',
    postings: [
      { account: 'REVENUE', side: 'DEBIT', amount: params.amount, memo: 'Revenue reversed for refund' },
      { account: 'REFUND_PAYABLE', side: 'CREDIT', amount: params.amount, memo: 'Owed back to patient' },
    ],
    refs: { refundId: params.refundId, invoiceId: params.invoiceId },
    occurredAt: params.occurredAt,
    createdByUserId: params.createdByUserId,
  });
}

/** The refund actually leaves the bank. */
export function entryRefundPaid(params: {
  refundId: string;
  amount: number;
  bankReference: string;
  createdByUserId?: string | null;
  occurredAt?: Date;
}): LedgerEntry {
  if (!params.bankReference?.trim()) {
    throw new LedgerError('REFERENCE_REQUIRED', 'A paid refund must carry the reference that proves the money left.');
  }
  return post({
    eventType: 'REFUND_PAID',
    postings: [
      { account: 'REFUND_PAYABLE', side: 'DEBIT', amount: params.amount, memo: 'Refund settled' },
      { account: 'CASH_AT_BANK', side: 'CREDIT', amount: params.amount, memo: `Bank ref ${params.bankReference}` },
    ],
    refs: { refundId: params.refundId },
    occurredAt: params.occurredAt,
    createdByUserId: params.createdByUserId,
  });
}

/**
 * An unexplained difference found during reconciliation (§31).
 *
 * It goes to SUSPENSE rather than being absorbed into revenue. A difference in
 * suspense is a question somebody must answer; a difference quietly added to
 * revenue is a question nobody will ever ask.
 */
export function entryReconciliationDifference(params: {
  amount: number;
  /** True when the bank holds MORE than the books say. */
  bankHasMore: boolean;
  memo: string;
  createdByUserId?: string | null;
  occurredAt?: Date;
}): LedgerEntry {
  const { amount, bankHasMore, memo } = params;
  return post({
    eventType: 'RECONCILIATION_DIFFERENCE',
    postings: bankHasMore
      ? [
          { account: 'CASH_AT_BANK', side: 'DEBIT', amount, memo },
          { account: 'SUSPENSE', side: 'CREDIT', amount, memo },
        ]
      : [
          { account: 'SUSPENSE', side: 'DEBIT', amount, memo },
          { account: 'CASH_AT_BANK', side: 'CREDIT', amount, memo },
        ],
    refs: {},
    occurredAt: params.occurredAt,
    createdByUserId: params.createdByUserId,
    memo,
  });
}

// ---------------------------------------------------------------------------
// Reading the ledger back
// ---------------------------------------------------------------------------

export interface AccountBalance {
  account: LedgerAccountType;
  debits: number;
  credits: number;
  /** Signed in the account's natural direction, so a liability reads positive. */
  balance: number;
}

/** Balances per account, from postings. The trial balance is derived, never stored. */
export function balances(entries: LedgerEntry[]): AccountBalance[] {
  const map = new Map<LedgerAccountType, { debits: number; credits: number }>();

  for (const entry of entries) {
    for (const p of entry.postings) {
      const row = map.get(p.account) ?? { debits: 0, credits: 0 };
      if (p.side === 'DEBIT') row.debits += p.amount;
      else row.credits += p.amount;
      map.set(p.account, row);
    }
  }

  return Array.from(map.entries()).map(([account, { debits, credits }]) => ({
    account,
    debits,
    credits,
    balance: naturalSide(account) === 'DEBIT' ? debits - credits : credits - debits,
  }));
}

/**
 * The §17 / §30 chain, derived from the postings.
 *
 * COLLECTED -> ALLOCATED -> SETTLEMENT PENDING -> SETTLED
 *
 * Deliberately derived rather than stored. Four status columns that code must
 * remember to keep in step are four columns that will eventually disagree; a
 * figure computed from the postings cannot drift from them. `settled` is the
 * cumulative discharge of beneficiary liabilities, which is exactly the money
 * that has gone out and been confirmed.
 */
export function settlementChain(entries: LedgerEntry[]): {
  collected: number;
  allocated: number;
  settlementPending: number;
  settled: number;
  reconciledDifference: number;
} {
  let collected = 0;
  let allocated = 0;
  let settled = 0;
  let reconciledDifference = 0;

  for (const entry of entries) {
    if (entry.eventType === 'PAYMENT_RECEIVED') collected += entry.amount;
    if (entry.eventType === 'REVENUE_ALLOCATED') allocated += entry.amount;
    if (entry.eventType === 'SETTLEMENT_CONFIRMED') settled += entry.amount;
    if (entry.eventType === 'RECONCILIATION_DIFFERENCE') reconciledDifference += entry.amount;
  }

  return {
    collected,
    allocated,
    // What has been allocated but not yet paid out is the live liability.
    settlementPending: allocated - settled,
    settled,
    reconciledDifference,
  };
}

/**
 * Does the whole ledger balance?
 *
 * Should be run as a scheduled check (§32) and asserted in tests. If this is
 * ever false, something wrote postings without going through post().
 */
export function trialBalance(entries: LedgerEntry[]): { balanced: boolean; debits: number; credits: number; difference: number } {
  let debits = 0;
  let credits = 0;
  for (const entry of entries) {
    for (const p of entry.postings) {
      if (p.side === 'DEBIT') debits += p.amount;
      else credits += p.amount;
    }
  }
  return { balanced: debits === credits, debits, credits, difference: debits - credits };
}

// ============================================================
// Reconciliation (§31, §32)
// ------------------------------------------------------------
// Four records of the same money, compared:
//
//   INVOICES   what the hospital billed
//   PAYMENTS   what this application believes it received
//   GATEWAY    what the payment provider says it processed
//   BANK       what actually landed in the account
//   LEDGER     what the books say about all of it
//
// They should agree. When they do not, SOMETHING IS WRONG WITH THE MONEY, and
// the entire value of this module is that it says so out loud rather than
// letting a difference age quietly into an unexplainable balance.
//
// TWO PRINCIPLES GOVERN EVERY CHECK BELOW.
//
// AN EXCEPTION IS A QUESTION, NOT A CORRECTION. Nothing here adjusts a balance,
// writes off a difference or "fixes" anything. It raises a finding for a person
// to resolve. Software that silently corrects financial discrepancies destroys
// the evidence of whatever caused them.
//
// A DIFFERENCE IN OUR FAVOUR IS STILL A DIFFERENCE. Money in the bank that no
// invoice accounts for is reported exactly as loudly as money missing. It is
// somebody's, and the fact that it is sitting in the hospital's account does not
// make it the hospital's.
//
// Pure functions over plain rows: the runner fetches, this decides. That is what
// lets every one of these findings be tested without a database.
// ============================================================

export type ExceptionType =
  | 'PAYMENT_WITHOUT_INVOICE'
  | 'INVOICE_PAID_WITHOUT_GATEWAY_RECORD'
  | 'AMOUNT_MISMATCH'
  | 'CURRENCY_MISMATCH'
  | 'DUPLICATE_TRANSACTION'
  | 'SETTLEMENT_AMOUNT_MISMATCH'
  | 'FAILED_SETTLEMENT'
  | 'REVERSED_PAYMENT'
  | 'UNRECONCILED_ATTESTED_PAYMENT'
  | 'ALLOCATION_DOES_NOT_SUM'
  | 'LEDGER_OUT_OF_BALANCE'
  | 'UNMATCHED_BANK_CREDIT';

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface Exception {
  type: ExceptionType;
  severity: Severity;
  /** What is wrong, in words a finance officer can act on without reading code. */
  detail: string;
  expectedAmount?: number | null;
  actualAmount?: number | null;
  difference?: number | null;
  invoiceId?: string | null;
  paymentId?: string | null;
  settlementId?: string | null;
  providerReference?: string | null;
}

// --- The inputs, as plain rows --------------------------------------------

export interface InvoiceRow {
  id: string;
  invoiceNumber: string;
  status: string;
  total: number;
  amountPaid: number;
}

export interface PaymentRow {
  id: string;
  paymentNumber: string;
  invoiceId: string | null;
  amount: number;
  currency: string;
  status: string;
  trustBasis: string | null;
  providerTransactionId: string | null;
  bankReference: string | null;
  confirmedAt: Date | string | null;
  reversedAt: Date | string | null;
}

/** What the provider says, from its settlement or transaction report. */
export interface GatewayRow {
  providerReference: string;
  providerTransactionId: string | null;
  amount: number;
  currency: string;
  status: string;
}

/** One credit line from a bank statement import. */
export interface BankCreditRow {
  reference: string;
  amount: number;
  valueDate: Date | string;
}

export interface DistributionRow {
  id: string;
  invoiceId: string;
  paymentId: string | null;
  amount: number;
  status: string;
}

export interface SettlementRow {
  id: string;
  settlementNumber: string;
  accountId: string;
  amount: number;
  status: string;
  bankReference: string | null;
  /** Sum of the distributions this settlement claims to discharge. */
  claimedDistributionTotal: number;
}

export interface ReconciliationInput {
  periodStart: Date;
  periodEnd: Date;
  invoices: InvoiceRow[];
  payments: PaymentRow[];
  gateway: GatewayRow[];
  bankCredits: BankCreditRow[];
  distributions: DistributionRow[];
  settlements: SettlementRow[];
  /** From lib/ledger trialBalance(). */
  ledger: { debits: number; credits: number };
  /** How long an attested desk payment may go unconfirmed before it is flagged. */
  attestedGraceHours?: number;
  /** "Now", passed in so a run is reproducible and testable. */
  asOf?: Date;
}

export interface ReconciliationResult {
  exceptions: Exception[];
  totals: {
    invoiced: number;
    collected: number;
    allocated: number;
    settled: number;
    bankCredits: number;
    /** Collected less what the bank actually shows. Zero is the healthy answer. */
    unmatchedAgainstBank: number;
  };
  counts: {
    invoices: number;
    payments: number;
    exceptions: number;
    critical: number;
  };
  balanced: boolean;
}

const HOURS = 60 * 60 * 1000;

function asDate(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  return v instanceof Date ? v : new Date(v);
}

/**
 * Compare everything, and report what disagrees.
 *
 * Findings are ordered most severe first, because a reconciliation report that
 * buries a missing payment under forty rounding notes will not be read to the
 * end.
 */
export function reconcile(input: ReconciliationInput): ReconciliationResult {
  const {
    invoices, payments, gateway, bankCredits, distributions, settlements, ledger,
    attestedGraceHours = 48,
    asOf = new Date(),
  } = input;

  const exceptions: Exception[] = [];

  const invoicesById = new Map(invoices.map((i) => [i.id, i]));
  const gatewayByReference = new Map(gateway.map((g) => [g.providerReference, g]));
  const livePayments = payments.filter((p) => !p.reversedAt);

  // -----------------------------------------------------------------------
  // 1. A payment against no invoice
  // -----------------------------------------------------------------------
  // Money received that no bill accounts for. Somebody paid for something, and
  // the hospital does not know what — so it can be neither allocated nor
  // refunded until a person works it out.
  for (const payment of livePayments) {
    if (!payment.invoiceId || !invoicesById.has(payment.invoiceId)) {
      exceptions.push({
        type: 'PAYMENT_WITHOUT_INVOICE',
        severity: 'CRITICAL',
        detail:
          `Payment ${payment.paymentNumber} of ${payment.amount} kobo is not attached to any invoice in this period. ` +
          `The money is real and cannot be allocated until it is matched to a bill.`,
        paymentId: payment.id,
        actualAmount: payment.amount,
      });
    }
  }

  // -----------------------------------------------------------------------
  // 2. A gateway payment with no record here
  // -----------------------------------------------------------------------
  // The opposite direction, and the one most systems forget to check. The
  // provider processed money this application has never heard of — a webhook
  // that never arrived, or one that was rejected.
  const knownProviderTxns = new Set(livePayments.map((p) => p.providerTransactionId).filter(Boolean));
  const knownReferences = new Set(livePayments.map((p) => p.bankReference).filter(Boolean));

  for (const g of gateway) {
    if (g.status !== 'success' && g.status !== 'successful') continue;
    const matched =
      (g.providerTransactionId && knownProviderTxns.has(g.providerTransactionId)) ||
      knownReferences.has(g.providerReference);

    if (!matched) {
      exceptions.push({
        type: 'PAYMENT_WITHOUT_INVOICE',
        severity: 'CRITICAL',
        detail:
          `The gateway processed ${g.amount} kobo under reference ${g.providerReference}, but this application has no ` +
          `record of it. A webhook was probably missed. The patient has paid and their invoice may still show as owing.`,
        providerReference: g.providerReference,
        actualAmount: g.amount,
      });
    }
  }

  // -----------------------------------------------------------------------
  // 3. An invoice marked paid with nothing behind it
  // -----------------------------------------------------------------------
  for (const invoice of invoices) {
    if (invoice.status !== 'PAID' && invoice.status !== 'OVERPAID') continue;

    const against = livePayments.filter((p) => p.invoiceId === invoice.id);
    const received = against.reduce((s, p) => s + p.amount, 0);

    if (against.length === 0) {
      exceptions.push({
        type: 'INVOICE_PAID_WITHOUT_GATEWAY_RECORD',
        severity: 'CRITICAL',
        detail:
          `Invoice ${invoice.invoiceNumber} is marked ${invoice.status} but has no payment recorded against it. ` +
          `Either the money was never received, or a payment record has been lost.`,
        invoiceId: invoice.id,
        expectedAmount: invoice.total,
        actualAmount: 0,
        difference: invoice.total,
      });
      continue;
    }

    if (received !== invoice.amountPaid) {
      exceptions.push({
        type: 'AMOUNT_MISMATCH',
        severity: 'HIGH',
        detail:
          `Invoice ${invoice.invoiceNumber} records ${invoice.amountPaid} kobo paid, but its payments total ` +
          `${received} kobo. The invoice and its payments disagree.`,
        invoiceId: invoice.id,
        expectedAmount: invoice.amountPaid,
        actualAmount: received,
        difference: received - invoice.amountPaid,
      });
    }
  }

  // -----------------------------------------------------------------------
  // 4. Payment against gateway: amount and currency
  // -----------------------------------------------------------------------
  for (const payment of livePayments) {
    if (payment.trustBasis !== 'GATEWAY_VERIFIED') continue;
    const g = payment.bankReference ? gatewayByReference.get(payment.bankReference) : undefined;
    if (!g) continue;

    if (g.amount !== payment.amount) {
      exceptions.push({
        type: 'AMOUNT_MISMATCH',
        severity: 'CRITICAL',
        detail:
          `Payment ${payment.paymentNumber} records ${payment.amount} kobo but the gateway reports ${g.amount} kobo ` +
          `for the same transaction.`,
        paymentId: payment.id,
        invoiceId: payment.invoiceId,
        expectedAmount: payment.amount,
        actualAmount: g.amount,
        difference: g.amount - payment.amount,
        providerReference: g.providerReference,
      });
    }

    if (g.currency.toUpperCase() !== payment.currency.toUpperCase()) {
      exceptions.push({
        type: 'CURRENCY_MISMATCH',
        severity: 'CRITICAL',
        detail: `Payment ${payment.paymentNumber} is in ${payment.currency} but the gateway reports ${g.currency}.`,
        paymentId: payment.id,
        providerReference: g.providerReference,
      });
    }
  }

  // -----------------------------------------------------------------------
  // 5. Duplicate transactions
  // -----------------------------------------------------------------------
  // The same provider transaction confirming two payments means the same money
  // has been counted twice, and something has been allocated that never arrived.
  const seenTxn = new Map<string, PaymentRow>();
  for (const payment of livePayments) {
    if (!payment.providerTransactionId) continue;
    const first = seenTxn.get(payment.providerTransactionId);
    if (first) {
      exceptions.push({
        type: 'DUPLICATE_TRANSACTION',
        severity: 'CRITICAL',
        detail:
          `Payments ${first.paymentNumber} and ${payment.paymentNumber} both claim gateway transaction ` +
          `${payment.providerTransactionId}. The same money has been counted twice.`,
        paymentId: payment.id,
        actualAmount: payment.amount,
        providerReference: payment.providerTransactionId,
      });
    } else {
      seenTxn.set(payment.providerTransactionId, payment);
    }
  }

  // -----------------------------------------------------------------------
  // 6. Attested desk payments still unconfirmed by a bank (§51)
  // -----------------------------------------------------------------------
  // This is the promise the trust model makes good on. An ATTESTED payment is
  // allowed and allocated so care is not delayed — but it appears here, every
  // day, until a bank statement confirms it. Without this check, "attested" would
  // quietly mean "trusted", which is exactly what §2 forbids.
  const bankByReference = new Map(bankCredits.map((b) => [b.reference, b]));

  for (const payment of livePayments) {
    if (payment.trustBasis !== 'ATTESTED') continue;

    const confirmed = asDate(payment.confirmedAt);
    const ageHours = confirmed ? (asOf.getTime() - confirmed.getTime()) / HOURS : 0;
    const matchedInBank = payment.bankReference ? bankByReference.has(payment.bankReference) : false;

    if (!matchedInBank && ageHours > attestedGraceHours) {
      exceptions.push({
        type: 'UNRECONCILED_ATTESTED_PAYMENT',
        severity: 'HIGH',
        detail:
          `Payment ${payment.paymentNumber} of ${payment.amount} kobo was attested at the desk ` +
          `${Math.floor(ageHours)} hours ago and still has no matching bank credit. Either it has not been banked, ` +
          `or the reference does not match.`,
        paymentId: payment.id,
        invoiceId: payment.invoiceId,
        actualAmount: payment.amount,
      });
    }
  }

  // -----------------------------------------------------------------------
  // 7. Bank credits nobody has claimed
  // -----------------------------------------------------------------------
  // Money in the account that no payment explains. Reported as loudly as money
  // missing: it is somebody's, and sitting in the hospital's account does not
  // make it the hospital's.
  const claimedBankReferences = new Set(livePayments.map((p) => p.bankReference).filter(Boolean));
  for (const credit of bankCredits) {
    if (!claimedBankReferences.has(credit.reference)) {
      exceptions.push({
        type: 'UNMATCHED_BANK_CREDIT',
        severity: 'HIGH',
        detail:
          `The bank shows a credit of ${credit.amount} kobo under reference ${credit.reference} that no payment ` +
          `in this system accounts for. It belongs to somebody and must be identified.`,
        actualAmount: credit.amount,
        providerReference: credit.reference,
      });
    }
  }

  // -----------------------------------------------------------------------
  // 8. Reversed payments still counted
  // -----------------------------------------------------------------------
  for (const payment of payments) {
    if (!payment.reversedAt) continue;
    const invoice = payment.invoiceId ? invoicesById.get(payment.invoiceId) : undefined;
    if (!invoice) continue;

    const liveForInvoice = livePayments.filter((p) => p.invoiceId === invoice.id).reduce((s, p) => s + p.amount, 0);
    if (invoice.amountPaid > liveForInvoice) {
      exceptions.push({
        type: 'REVERSED_PAYMENT',
        severity: 'HIGH',
        detail:
          `Payment ${payment.paymentNumber} was reversed, but invoice ${invoice.invoiceNumber} still shows ` +
          `${invoice.amountPaid} kobo paid against ${liveForInvoice} kobo of live payments.`,
        paymentId: payment.id,
        invoiceId: invoice.id,
        expectedAmount: liveForInvoice,
        actualAmount: invoice.amountPaid,
        difference: invoice.amountPaid - liveForInvoice,
      });
    }
  }

  // -----------------------------------------------------------------------
  // 9. Allocations that do not sum to the money they allocate
  // -----------------------------------------------------------------------
  // The allocation engine guarantees this at write time. Checking it again here
  // is not distrust of the engine — it catches a distribution edited, deleted or
  // inserted by any route OTHER than the engine, which is precisely the kind of
  // thing that would otherwise never be noticed.
  const distributionsByPayment = new Map<string, number>();
  for (const d of distributions) {
    if (!d.paymentId || d.status === 'CANCELLED' || d.status === 'REVERSED') continue;
    distributionsByPayment.set(d.paymentId, (distributionsByPayment.get(d.paymentId) ?? 0) + d.amount);
  }

  for (const [paymentId, allocated] of Array.from(distributionsByPayment.entries())) {
    const payment = payments.find((p) => p.id === paymentId);
    if (!payment || payment.reversedAt) continue;
    const invoice = payment.invoiceId ? invoicesById.get(payment.invoiceId) : undefined;
    if (!invoice) continue;

    // Deposits are not allocated as revenue, so the allocated figure is
    // legitimately lower than the payment. What is never legitimate is
    // allocating MORE than was received.
    if (allocated > payment.amount) {
      exceptions.push({
        type: 'ALLOCATION_DOES_NOT_SUM',
        severity: 'CRITICAL',
        detail:
          `Payment ${payment.paymentNumber} of ${payment.amount} kobo has ${allocated} kobo allocated against it. ` +
          `More has been distributed than was received.`,
        paymentId: payment.id,
        invoiceId: invoice.id,
        expectedAmount: payment.amount,
        actualAmount: allocated,
        difference: allocated - payment.amount,
      });
    }
  }

  // -----------------------------------------------------------------------
  // 10. Settlements
  // -----------------------------------------------------------------------
  for (const settlement of settlements) {
    if (settlement.amount !== settlement.claimedDistributionTotal) {
      exceptions.push({
        type: 'SETTLEMENT_AMOUNT_MISMATCH',
        severity: 'HIGH',
        detail:
          `Settlement ${settlement.settlementNumber} is for ${settlement.amount} kobo but the distributions it ` +
          `discharges total ${settlement.claimedDistributionTotal} kobo.`,
        settlementId: settlement.id,
        expectedAmount: settlement.claimedDistributionTotal,
        actualAmount: settlement.amount,
        difference: settlement.amount - settlement.claimedDistributionTotal,
      });
    }

    if (settlement.status === 'FAILED') {
      exceptions.push({
        type: 'FAILED_SETTLEMENT',
        severity: 'HIGH',
        detail:
          `Settlement ${settlement.settlementNumber} of ${settlement.amount} kobo failed. The beneficiary has not ` +
          `been paid and the money is still owed to them.`,
        settlementId: settlement.id,
        actualAmount: settlement.amount,
      });
    }

    // The §51 check: confirmed, but with nothing proving it.
    if (settlement.status === 'CONFIRMED' && !settlement.bankReference?.trim()) {
      exceptions.push({
        type: 'SETTLEMENT_AMOUNT_MISMATCH',
        severity: 'CRITICAL',
        detail:
          `Settlement ${settlement.settlementNumber} is marked confirmed but carries no bank reference. It looks ` +
          `reconciled and cannot be checked, which is worse than leaving it pending.`,
        settlementId: settlement.id,
        actualAmount: settlement.amount,
      });
    }
  }

  // -----------------------------------------------------------------------
  // 11. Does the ledger itself balance?
  // -----------------------------------------------------------------------
  if (ledger.debits !== ledger.credits) {
    exceptions.push({
      type: 'LEDGER_OUT_OF_BALANCE',
      severity: 'CRITICAL',
      detail:
        `The ledger does not balance: ${ledger.debits} kobo debited against ${ledger.credits} kobo credited. ` +
        `Something has written postings without going through the ledger module.`,
      expectedAmount: ledger.debits,
      actualAmount: ledger.credits,
      difference: ledger.debits - ledger.credits,
    });
  }

  // --- Totals --------------------------------------------------------------
  const collected = livePayments.reduce((s, p) => s + p.amount, 0);
  const bankTotal = bankCredits.reduce((s, b) => s + b.amount, 0);

  const totals = {
    invoiced: invoices.reduce((s, i) => s + i.total, 0),
    collected,
    allocated: distributions
      .filter((d) => d.status !== 'CANCELLED' && d.status !== 'REVERSED')
      .reduce((s, d) => s + d.amount, 0),
    settled: settlements.filter((s2) => s2.status === 'CONFIRMED').reduce((s, x) => s + x.amount, 0),
    bankCredits: bankTotal,
    unmatchedAgainstBank: collected - bankTotal,
  };

  const order: Record<Severity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  exceptions.sort((a, b) => order[a.severity] - order[b.severity]);

  return {
    exceptions,
    totals,
    counts: {
      invoices: invoices.length,
      payments: payments.length,
      exceptions: exceptions.length,
      critical: exceptions.filter((e) => e.severity === 'CRITICAL').length,
    },
    balanced: exceptions.length === 0,
  };
}

/**
 * A short summary for the daily report and the dashboard tile.
 *
 * Says "nothing to report" only when that is literally true. A reconciliation
 * that reassures when it has not actually checked anything is worse than none.
 */
export function summarise(result: ReconciliationResult): string {
  if (result.counts.payments === 0 && result.counts.invoices === 0) {
    return 'Nothing was billed or collected in this period, so there is nothing to reconcile.';
  }
  if (result.balanced) {
    return `All ${result.counts.payments} payments reconcile against invoices, gateway, bank and ledger.`;
  }
  const critical = result.counts.critical;
  return (
    `${result.counts.exceptions} exception${result.counts.exceptions === 1 ? '' : 's'}` +
    (critical > 0 ? `, ${critical} critical` : '') +
    `, across ${result.counts.payments} payments. These need resolving, not clearing.`
  );
}

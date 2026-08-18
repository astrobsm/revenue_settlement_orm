// ============================================================
// The payment state machine (§10, §11, §51)
// ------------------------------------------------------------
// A payment's status is the single most dangerous field in this application. It
// is the field that decides whether a patient is treated as having paid, whether
// revenue is allocated, and whether a settlement instruction goes to a bank.
//
// So it is not a free-text column that code assigns at will. Every change passes
// through transition(), which knows:
//
//   - which moves are legal at all (the table below), and
//   - which moves additionally require PROOF (canTransition).
//
// THE RULE THAT MATTERS (§2, §10):
//
//   Nothing reaches SUCCESSFUL because a browser said so.
//
// A frontend callback, a screenshot, a patient's word and a clerk clicking
// "confirm" are all worth exactly nothing here. SUCCESSFUL is reachable only
// with a trust basis:
//
//   GATEWAY_VERIFIED  the provider was asked, server to server, and said yes
//   BANK_CONFIRMED    a bank statement line was matched to this payment
//   ATTESTED          a named, authorised cashier recorded cash or POS taken at
//                     a desk, with evidence, under their own user id
//
// ATTESTED exists because refusing it would be dishonest about how a Nigerian
// teaching hospital actually collects money. Cash and POS at the revenue desk
// are real, and a human entry is the ONLY possible source of truth for them.
// What ATTESTED does not get is the pretence of verification: it lands in
// RECONCILIATION_REQUIRED-adjacent reporting until a bank statement confirms it,
// it names the cashier, and it appears in the daily exceptions report until
// matched. That satisfies §51 — the system never suggests money has arrived
// somewhere it has not — without pretending a cash desk does not exist.
// ============================================================

export type PaymentStatus =
  | 'DRAFT'
  | 'PENDING'
  | 'INITIATED'
  | 'PROCESSING'
  | 'SUCCESSFUL'
  | 'FAILED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'REFUNDED'
  | 'PARTIALLY_REFUNDED'
  | 'REVERSED'
  | 'RECONCILIATION_REQUIRED';

/**
 * How we know a payment is real. Ordered weakest to strongest for reporting;
 * the order is not a permission — see requiresProof().
 */
export type TrustBasis = 'ATTESTED' | 'BANK_CONFIRMED' | 'GATEWAY_VERIFIED';

/** Statuses in which money is considered to be in the hospital's hands. */
const MONEY_HELD: PaymentStatus[] = ['SUCCESSFUL', 'PARTIALLY_REFUNDED', 'RECONCILIATION_REQUIRED'];

/** Statuses from which no further movement is possible. */
const TERMINAL: PaymentStatus[] = ['FAILED', 'CANCELLED', 'EXPIRED', 'REFUNDED', 'REVERSED'];

/**
 * The legal moves. Anything absent from this table is illegal, by omission
 * rather than by a list of prohibitions — a new status added without deciding
 * its transitions is therefore inert rather than dangerously permissive.
 */
const TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  // Being prepared. Not yet money.
  DRAFT: ['PENDING', 'CANCELLED'],

  // Awaiting a channel. A desk payment starts here too.
  PENDING: ['INITIATED', 'SUCCESSFUL', 'FAILED', 'CANCELLED', 'EXPIRED'],

  // Handed to a provider; the patient has been sent to pay.
  INITIATED: ['PROCESSING', 'SUCCESSFUL', 'FAILED', 'CANCELLED', 'EXPIRED'],

  // The provider has it and is working.
  PROCESSING: ['SUCCESSFUL', 'FAILED', 'EXPIRED', 'RECONCILIATION_REQUIRED'],

  // Money is in. From here money can only go back out through a controlled path.
  SUCCESSFUL: ['PARTIALLY_REFUNDED', 'REFUNDED', 'REVERSED', 'RECONCILIATION_REQUIRED'],

  // A discrepancy was found. It must be resolved one way or the other.
  RECONCILIATION_REQUIRED: ['SUCCESSFUL', 'FAILED', 'REVERSED', 'REFUNDED', 'PARTIALLY_REFUNDED'],

  PARTIALLY_REFUNDED: ['REFUNDED', 'REVERSED', 'RECONCILIATION_REQUIRED'],

  // Terminal.
  FAILED: [],
  CANCELLED: [],
  EXPIRED: [],
  REFUNDED: [],
  REVERSED: [],
};

export function isTerminal(status: PaymentStatus): boolean {
  return TERMINAL.includes(status);
}

export function isMoneyHeld(status: PaymentStatus): boolean {
  return MONEY_HELD.includes(status);
}

/** Does reaching this status count as the hospital having received the money? */
export function countsTowardInvoicePaid(status: PaymentStatus): boolean {
  return isMoneyHeld(status);
}

/**
 * Which statuses may only be entered with independent proof?
 *
 * SUCCESSFUL is the obvious one. PARTIALLY_REFUNDED and REFUNDED are here too:
 * a refund means money genuinely left, and marking one without proof produces
 * exactly the false impression §51 forbids.
 */
export function requiresProof(status: PaymentStatus): boolean {
  return status === 'SUCCESSFUL' || status === 'REFUNDED' || status === 'PARTIALLY_REFUNDED';
}

export interface TransitionContext {
  /** How the new status is evidenced. Required wherever requiresProof(). */
  trustBasis?: TrustBasis;
  /** The provider's own transaction id. Required for GATEWAY_VERIFIED. */
  providerTransactionId?: string | null;
  /** Bank statement line or teller reference. Required for BANK_CONFIRMED. */
  bankReference?: string | null;
  /** The user recording an ATTESTED payment. Required for ATTESTED. */
  attestedByUserId?: string | null;
  /** Evidence image for an ATTESTED payment — teller slip, POS receipt. */
  evidenceRef?: string | null;
}

export interface TransitionVerdict {
  allowed: boolean;
  code?: string;
  message?: string;
}

/**
 * May this payment move from `from` to `to`, given this evidence?
 *
 * Returns a verdict rather than throwing, because every caller is an API route
 * that must turn a refusal into a 409 with an explanation a cashier can act on.
 */
export function canTransition(from: PaymentStatus, to: PaymentStatus, context: TransitionContext = {}): TransitionVerdict {
  if (from === to) {
    // Idempotent replay of a webhook is normal and must not be an error, but it
    // is not a transition either — the caller should treat it as already done.
    return { allowed: false, code: 'NO_CHANGE', message: `This payment is already ${from}.` };
  }

  const legal = TRANSITIONS[from];
  if (!legal) {
    return { allowed: false, code: 'UNKNOWN_STATUS', message: `${from} is not a known payment status.` };
  }
  if (!legal.includes(to)) {
    return {
      allowed: false,
      code: 'ILLEGAL_TRANSITION',
      message: isTerminal(from)
        ? `This payment is ${from}, which is final. Correct it with a new transaction — an adjustment, a refund or a fresh payment — rather than changing this one.`
        : `A payment cannot move from ${from} to ${to}.`,
    };
  }

  if (!requiresProof(to)) return { allowed: true };

  const basis = context.trustBasis;
  if (!basis) {
    return {
      allowed: false,
      code: 'PROOF_REQUIRED',
      message: `A payment cannot be marked ${to} without evidence. This status requires gateway verification, a matched bank reference, or an authorised cashier's attestation.`,
    };
  }

  switch (basis) {
    case 'GATEWAY_VERIFIED':
      if (!context.providerTransactionId) {
        return {
          allowed: false,
          code: 'PROVIDER_REFERENCE_REQUIRED',
          message: 'A gateway-verified payment must carry the provider transaction id that was verified.',
        };
      }
      return { allowed: true };

    case 'BANK_CONFIRMED':
      if (!context.bankReference) {
        return {
          allowed: false,
          code: 'BANK_REFERENCE_REQUIRED',
          message: 'A bank-confirmed payment must carry the bank reference it was matched against.',
        };
      }
      return { allowed: true };

    case 'ATTESTED':
      if (!context.attestedByUserId) {
        return {
          allowed: false,
          code: 'ATTESTATION_REQUIRED',
          message: 'A desk payment must record which cashier took it. An unattributed attestation is not evidence.',
        };
      }
      if (!context.evidenceRef) {
        return {
          allowed: false,
          code: 'EVIDENCE_REQUIRED',
          message: 'A desk payment must carry evidence — the teller slip, POS receipt or transfer confirmation.',
        };
      }
      return { allowed: true };

    default:
      return { allowed: false, code: 'UNKNOWN_TRUST_BASIS', message: `${String(basis)} is not a recognised trust basis.` };
  }
}

export class TransitionError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'TransitionError';
    this.code = code;
  }
}

/**
 * Perform the transition, or throw.
 *
 * Used inside a database transaction where a refusal must abort the write. API
 * routes that need to answer politely should call canTransition() first.
 */
export function transition(from: PaymentStatus, to: PaymentStatus, context: TransitionContext = {}): PaymentStatus {
  const verdict = canTransition(from, to, context);
  if (!verdict.allowed) {
    throw new TransitionError(verdict.code ?? 'ILLEGAL_TRANSITION', verdict.message ?? 'Illegal payment transition.');
  }
  return to;
}

/**
 * Does an ATTESTED payment need reconciling before it can be trusted fully?
 *
 * Yes, always — and this is the function the exceptions report uses. Naming it
 * separately keeps the honesty explicit: an attested payment is allocated and
 * the patient is not made to wait, but it is not silently equated with money a
 * bank has confirmed.
 */
export function needsBankReconciliation(basis: TrustBasis): boolean {
  return basis === 'ATTESTED';
}

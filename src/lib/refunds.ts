// ============================================================
// Refunds (§19, §44)
// ------------------------------------------------------------
// A REFUND IS NOT AN UNDO. §19 is explicit: it must not delete or reverse the
// original payment. The payment happened, and the record of it stands for ever.
// A refund is its OWN transaction, running in the opposite direction, which
// references the payment it relates to.
//
// The distinction is not pedantry. If a refund erased the payment, then a
// patient who paid ₦910,000 and was refunded ₦50,000 would leave no trace of
// having paid ₦910,000 — and the day's takings, the cashier's till and the bank
// statement would all disagree with the system with no way to explain why.
//
// THE HARD PART IS NOT THE MONEY COMING BACK. It is that the money may already
// have been ALLOCATED and SETTLED — sent out to the pharmacy, the theatre, a
// vendor. Refunding the patient does not automatically pull it back from them.
// So a refund has to distinguish:
//
//   PENDING distributions    still owed to a beneficiary, not yet paid out.
//                            These are simply cancelled — nothing to recover.
//
//   SETTLED distributions    the money has genuinely left. It must be RECOVERED
//                            from that beneficiary, which is a real-world
//                            conversation, not a database update. The system's
//                            job is to say precisely who owes what back.
//
// Pretending a settled distribution can be silently unwound is the single most
// dishonest thing this module could do, so planRecovery() names every account
// and amount and the refund is flagged as requiring recovery.
// ============================================================

import { proRataLines } from './allocation';
import { assertKobo, formatNaira } from './money';

export type RefundStatus =
  | 'REQUESTED'
  | 'UNDER_REVIEW'
  | 'APPROVED'
  | 'PROCESSING'
  | 'REFUNDED'
  | 'FAILED'
  | 'REJECTED';

/**
 * The legal moves. As with payments, anything absent is illegal by omission
 * rather than by a list of prohibitions.
 */
const TRANSITIONS: Record<RefundStatus, RefundStatus[]> = {
  REQUESTED: ['UNDER_REVIEW', 'APPROVED', 'REJECTED'],
  UNDER_REVIEW: ['APPROVED', 'REJECTED'],
  APPROVED: ['PROCESSING', 'REJECTED'],
  PROCESSING: ['REFUNDED', 'FAILED'],
  // A failed refund can be retried: the money did not move, so nothing is lost.
  FAILED: ['PROCESSING', 'REJECTED'],
  // Terminal.
  REFUNDED: [],
  REJECTED: [],
};

export interface RefundVerdict {
  allowed: boolean;
  code?: string;
  message?: string;
}

export function canTransitionRefund(from: RefundStatus, to: RefundStatus): RefundVerdict {
  if (from === to) return { allowed: false, code: 'NO_CHANGE', message: `This refund is already ${from}.` };

  const legal = TRANSITIONS[from];
  if (!legal) return { allowed: false, code: 'UNKNOWN_STATUS', message: `${from} is not a known refund status.` };

  if (!legal.includes(to)) {
    return {
      allowed: false,
      code: 'ILLEGAL_TRANSITION',
      message:
        from === 'REFUNDED'
          ? 'This refund has already been paid. Money that has gone back to a patient cannot be un-refunded — raise a new charge if it was wrong.'
          : from === 'REJECTED'
            ? 'This refund was rejected. Raise a new request rather than reviving this one.'
            : `A refund cannot move from ${from} to ${to}.`,
    };
  }
  return { allowed: true };
}

export function isRefundTerminal(status: RefundStatus): boolean {
  return status === 'REFUNDED' || status === 'REJECTED';
}

/** Has the money actually gone back to the patient? */
export function refundIsPaid(status: RefundStatus): boolean {
  return status === 'REFUNDED';
}

// ---------------------------------------------------------------------------
// May this refund be requested at all?
// ---------------------------------------------------------------------------

export interface RefundRequestCheck {
  allowed: boolean;
  code?: string;
  message?: string;
}

/**
 * Can `amount` be refunded against this payment?
 *
 * The ceiling is what the payment actually brought in, LESS anything already
 * refunded against it. Refunding twice against one payment is the commonest way
 * a refund process leaks money, and it is easy to do when two people are
 * handling the same complaint.
 */
export function canRequestRefund(params: {
  paymentAmount: number;
  paymentStatus: string;
  paymentReversed: boolean;
  /** Total of refunds already REQUESTED or paid against this payment. */
  alreadyRefunded: number;
  amount: number;
  reason: string;
}): RefundRequestCheck {
  const { paymentAmount, paymentStatus, paymentReversed, alreadyRefunded, amount, reason } = params;

  if (!Number.isInteger(amount) || amount <= 0) {
    return { allowed: false, code: 'INVALID_AMOUNT', message: 'A refund must be a whole number of kobo greater than zero.' };
  }
  if ((reason?.trim().length ?? 0) < 10) {
    return {
      allowed: false,
      code: 'REASON_REQUIRED',
      message: 'A refund needs a reason that will still make sense to an auditor next year.',
    };
  }
  if (paymentStatus !== 'SUCCESSFUL' && paymentStatus !== 'PARTIALLY_REFUNDED') {
    return {
      allowed: false,
      code: 'PAYMENT_NOT_REFUNDABLE',
      message: `This payment is ${paymentStatus}. Only money that was actually received can be refunded.`,
    };
  }
  if (paymentReversed) {
    return {
      allowed: false,
      code: 'PAYMENT_REVERSED',
      message: 'This payment was reversed, so there is nothing to refund. A reversal and a refund are different corrections and must not be applied to the same money.',
    };
  }

  const refundable = paymentAmount - alreadyRefunded;
  if (amount > refundable) {
    return {
      allowed: false,
      code: 'EXCEEDS_REFUNDABLE',
      message:
        `Only ${formatNaira(refundable)} of this ${formatNaira(paymentAmount)} payment can still be refunded` +
        (alreadyRefunded > 0 ? `; ${formatNaira(alreadyRefunded)} has already been refunded.` : '.'),
    };
  }

  return { allowed: true };
}

/**
 * Is this refund fully refunding the payment, or part of it?
 *
 * Drives whether the payment becomes REFUNDED or PARTIALLY_REFUNDED, which the
 * payment state machine then enforces.
 */
export function refundIsFull(params: { paymentAmount: number; alreadyRefunded: number; amount: number }): boolean {
  return params.alreadyRefunded + params.amount >= params.paymentAmount;
}

// ---------------------------------------------------------------------------
// Unwinding the allocation
// ---------------------------------------------------------------------------

export interface DistributionForRecovery {
  id: string;
  accountId: string;
  amount: number;
  status: string;
  chargeKind?: string | null;
}

export interface RecoveryLine {
  accountId: string;
  /** Kobo to take back. Positive; the direction is in the field name. */
  amount: number;
  /** The distributions this covers. */
  distributionIds: string[];
  /**
   * PENDING money is simply cancelled. SETTLED money has left the building and
   * has to be asked for back — which is a conversation, not an update.
   */
  method: 'CANCEL_PENDING' | 'RECOVER_SETTLED';
  chargeKind?: string | null;
}

export interface RecoveryPlan {
  lines: RecoveryLine[];
  /** Kobo that can simply be cancelled. */
  cancellable: number;
  /** Kobo that must genuinely be recovered from beneficiaries already paid. */
  recoverable: number;
  /** True where any money has already been settled out. */
  requiresRecovery: boolean;
  /** Plain wording for the approver, who must understand what they are agreeing to. */
  summary: string;
}

/**
 * Work out what has to come back from where, for a refund of `refundAmount`.
 *
 * Uses the SAME allocation engine as the original distribution, with a negative
 * total, so the unwind is the mirror image rather than a second algorithm that
 * could disagree with the first. For a partial refund, each beneficiary gives
 * back in proportion to what they received — which is the only division that
 * cannot be argued with.
 */
export function planRecovery(params: {
  refundAmount: number;
  distributions: DistributionForRecovery[];
}): RecoveryPlan {
  const { refundAmount, distributions } = params;
  assertKobo(refundAmount, 'refund amount');

  const live = distributions.filter((d) => d.status !== 'CANCELLED' && d.status !== 'REVERSED');
  const allocatedTotal = live.reduce((s, d) => s + d.amount, 0);

  if (live.length === 0 || allocatedTotal === 0) {
    return {
      lines: [],
      cancellable: 0,
      recoverable: 0,
      requiresRecovery: false,
      summary: 'Nothing has been allocated against this payment yet, so there is nothing to unwind.',
    };
  }

  const toTakeBack = Math.min(refundAmount, allocatedTotal);

  // Proportional shares of the refund, exact to the kobo.
  //
  // Deliberately NOT by converting each distribution's proportion to basis
  // points first: 500,000 of 810,000 is 6,172.83bp, and rounding that to an
  // integer before dividing rounds twice and puts the shares out by a few kobo.
  // proRataLines scales the amounts directly by largest remainder, so a partial
  // refund takes back exactly what it should from each beneficiary — the same
  // guarantee, and the same tested code, as a pro-rata part payment.
  const scaled = proRataLines(
    live.map((d) => ({ lineId: d.id, lineTotal: d.amount })),
    toTakeBack,
    allocatedTotal
  );

  const byAccount = new Map<string, RecoveryLine>();

  for (const share of scaled) {
    if (share.lineTotal === 0) continue;
    const distribution = live.find((d) => d.id === share.lineId);
    if (!distribution) continue;

    const method: RecoveryLine['method'] = distribution.status === 'SETTLED' ? 'RECOVER_SETTLED' : 'CANCEL_PENDING';
    const key = `${distribution.accountId}::${method}`;

    const existing = byAccount.get(key);
    if (existing) {
      existing.amount += share.lineTotal;
      existing.distributionIds.push(distribution.id);
    } else {
      byAccount.set(key, {
        accountId: distribution.accountId,
        amount: share.lineTotal,
        distributionIds: [distribution.id],
        method,
        chargeKind: distribution.chargeKind ?? null,
      });
    }
  }

  const lines = Array.from(byAccount.values());
  const cancellable = lines.filter((l) => l.method === 'CANCEL_PENDING').reduce((s, l) => s + l.amount, 0);
  const recoverable = lines.filter((l) => l.method === 'RECOVER_SETTLED').reduce((s, l) => s + l.amount, 0);

  return {
    lines,
    cancellable,
    recoverable,
    requiresRecovery: recoverable > 0,
    summary:
      recoverable > 0
        ? `${formatNaira(cancellable)} can be cancelled before it is paid out, but ${formatNaira(recoverable)} has ` +
          `ALREADY BEEN SETTLED to ${lines.filter((l) => l.method === 'RECOVER_SETTLED').length} account(s) and must be ` +
          `recovered from them. Approving this refund does not take that money back automatically.`
        : `${formatNaira(cancellable)} is still pending and will simply be cancelled. Nothing needs recovering.`,
  };
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

export interface ApprovalCheck {
  allowed: boolean;
  code?: string;
  message?: string;
  /** True where this refund is large enough to need a second approver. */
  requiresSeniorApproval?: boolean;
}

/**
 * May this person approve this refund?
 *
 * The separation-of-duties check (requester ≠ approver) lives in lib/rbac and is
 * applied by the route against the audit trail. What is decided HERE is whether
 * the amount is large enough to need more than one approval at all, which is
 * institutional policy rather than a fixed rule (§50).
 */
export function checkRefundApproval(params: {
  status: RefundStatus;
  amount: number;
  /** Kobo above which a second, more senior approval is required. */
  seniorApprovalThreshold: number;
  requiresRecovery: boolean;
}): ApprovalCheck {
  const { status, amount, seniorApprovalThreshold, requiresRecovery } = params;

  const move = canTransitionRefund(status, 'APPROVED');
  if (!move.allowed) return { allowed: false, code: move.code, message: move.message };

  // A refund that requires recovery ALWAYS needs senior approval, whatever its
  // size. Someone is being asked to go and get money back from a department or a
  // vendor, and that should be a decision taken at the right level rather than
  // discovered later by whoever has to make the call.
  const requiresSeniorApproval = requiresRecovery || amount > seniorApprovalThreshold;

  return { allowed: true, requiresSeniorApproval };
}

// ============================================================
// Deposits (§21)
// ------------------------------------------------------------
// AN ADMISSION DEPOSIT IS MONEY THE HOSPITAL HOLDS, NOT MONEY IT HAS EARNED.
//
// §21 calls this critical for proper financial reporting, and it is: booking a
// deposit as revenue on the day it is received overstates income by whatever is
// still sitting unspent, and understates the hospital's liabilities by the same
// amount. At a teaching hospital taking deposits on every admission, that is not
// a rounding difference — it is a materially wrong set of accounts.
//
// So a deposit lives as a LIABILITY and becomes revenue only as services are
// actually consumed:
//
//   Deposit received     500,000   liability 500,000   revenue 0
//   Bed charge applied  -120,000   liability 380,000   revenue 120,000
//   Discharge, unused    380,000   returned to the patient
//
// THE BALANCE IS ALWAYS THE PATIENT'S. That single sentence decides every rule
// below: a deposit cannot be drawn down beyond what remains, cannot be applied to
// another patient's bill, and whatever is left at discharge goes back rather than
// quietly ageing into the hospital's income.
// ============================================================

import { assertKobo, formatNaira } from './money';

export interface DepositState {
  /** Kobo received. */
  amount: number;
  /** Kobo already drawn down against real charges. */
  amountApplied: number;
  /** Kobo already given back. */
  amountRefunded: number;
  closedAt?: Date | string | null;
}

/** What is still the patient's — held, unspent, unreturned. */
export function depositBalance(deposit: DepositState): number {
  return deposit.amount - deposit.amountApplied - deposit.amountRefunded;
}

/** How much of the deposit has been earned by the hospital so far. */
export function depositEarned(deposit: DepositState): number {
  return deposit.amountApplied;
}

export interface ApplicationCheck {
  allowed: boolean;
  code?: string;
  message?: string;
  /** How much CAN be applied, where the request exceeds the balance. */
  availableAmount?: number;
}

/**
 * May `amount` be drawn from this deposit against a charge?
 *
 * Over-application is refused rather than capped silently. If a ₦150,000 bill
 * meets a ₦120,000 remaining deposit, the answer is not "take 120,000 and say
 * nothing" — the patient owes ₦30,000 and somebody has to tell them. Returning
 * `availableAmount` lets the caller offer exactly that, in words.
 */
export function canApplyDeposit(params: {
  deposit: DepositState;
  amount: number;
  /** The encounter the deposit was taken for. */
  depositEncounterId: string;
  /** The encounter being billed. */
  invoiceEncounterId: string;
}): ApplicationCheck {
  const { deposit, amount, depositEncounterId, invoiceEncounterId } = params;

  if (!Number.isInteger(amount) || amount <= 0) {
    return { allowed: false, code: 'INVALID_AMOUNT', message: 'An amount drawn from a deposit must be a whole number of kobo greater than zero.' };
  }

  if (deposit.closedAt) {
    return { allowed: false, code: 'DEPOSIT_CLOSED', message: 'This deposit has been closed and cannot be drawn from.' };
  }

  // A deposit belongs to one patient and one episode of care. Applying it
  // elsewhere spends one patient's money on another's treatment, which is not a
  // configuration option.
  if (depositEncounterId !== invoiceEncounterId) {
    return {
      allowed: false,
      code: 'WRONG_ENCOUNTER',
      message:
        'This deposit was taken for a different episode of care. A deposit belongs to the patient and the admission it was taken for, and cannot be applied to another bill.',
    };
  }

  const balance = depositBalance(deposit);
  if (balance <= 0) {
    return { allowed: false, code: 'DEPOSIT_EXHAUSTED', message: 'This deposit has been fully used.', availableAmount: 0 };
  }

  if (amount > balance) {
    return {
      allowed: false,
      code: 'EXCEEDS_DEPOSIT_BALANCE',
      message:
        `Only ${formatNaira(balance)} remains on this deposit, but ${formatNaira(amount)} was requested. ` +
        `The difference of ${formatNaira(amount - balance)} is still owed by the patient.`,
      availableAmount: balance,
    };
  }

  return { allowed: true };
}

export interface RefundCheck {
  allowed: boolean;
  code?: string;
  message?: string;
  refundableAmount?: number;
}

/**
 * May unused deposit be returned to the patient?
 *
 * This is not an optional courtesy. An unused deposit is the patient's money,
 * and a system that makes returning it awkward is a system that will end up
 * keeping it.
 */
export function canRefundDeposit(params: { deposit: DepositState; amount?: number }): RefundCheck {
  const { deposit } = params;
  const balance = depositBalance(deposit);
  const amount = params.amount ?? balance;

  if (balance <= 0) {
    return { allowed: false, code: 'NOTHING_TO_REFUND', message: 'This deposit has no unused balance.', refundableAmount: 0 };
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    return { allowed: false, code: 'INVALID_AMOUNT', message: 'A refund must be a whole number of kobo greater than zero.' };
  }
  if (amount > balance) {
    return {
      allowed: false,
      code: 'EXCEEDS_BALANCE',
      message: `Only ${formatNaira(balance)} of this deposit is unused; ${formatNaira(amount)} cannot be returned.`,
      refundableAmount: balance,
    };
  }

  return { allowed: true, refundableAmount: amount };
}

// ---------------------------------------------------------------------------
// Applying a deposit across a bill
// ---------------------------------------------------------------------------

export interface ChargeToSettle {
  lineId: string;
  chargeKind: string;
  amount: number;
}

export interface DepositApplicationPlan {
  applications: { lineId: string; chargeKind: string; amount: number }[];
  totalApplied: number;
  /** What the deposit could not cover, and the patient therefore still owes. */
  shortfall: number;
  remainingDeposit: number;
  summary: string;
}

/**
 * Draw a deposit down across a bill's charges, oldest first.
 *
 * Applied line by line rather than as one lump so that each draw-down names the
 * service that consumed it. "₦120,000 of the deposit was used" is not an answer
 * a patient can check; "₦45,000 bed charges, ₦75,000 nursing" is.
 *
 * Charges are settled in the order given — chronological, in practice — which is
 * the ordinary reading of drawing a deposit down as care is delivered.
 */
export function planDepositApplication(params: {
  deposit: DepositState;
  charges: ChargeToSettle[];
}): DepositApplicationPlan {
  const { deposit, charges } = params;

  let remaining = depositBalance(deposit);
  const applications: DepositApplicationPlan['applications'] = [];

  for (const charge of charges) {
    assertKobo(charge.amount, `charge ${charge.lineId}`);
    if (remaining <= 0) break;
    if (charge.amount <= 0) continue;

    const applied = Math.min(charge.amount, remaining);
    applications.push({ lineId: charge.lineId, chargeKind: charge.chargeKind, amount: applied });
    remaining -= applied;
  }

  const totalApplied = applications.reduce((s, a) => s + a.amount, 0);
  const chargeTotal = charges.reduce((s, c) => s + Math.max(0, c.amount), 0);
  const shortfall = Math.max(0, chargeTotal - totalApplied);

  return {
    applications,
    totalApplied,
    shortfall,
    remainingDeposit: remaining,
    summary:
      shortfall > 0
        ? `${formatNaira(totalApplied)} of the deposit has been applied. ${formatNaira(shortfall)} is still owed by the patient.`
        : remaining > 0
          ? `${formatNaira(totalApplied)} of the deposit has been applied. ${formatNaira(remaining)} remains and is the patient's.`
          : `The deposit has been fully applied against these charges.`,
  };
}

/**
 * What should happen to this deposit at discharge?
 *
 * Named as its own decision because it is the step most likely to be skipped —
 * a patient goes home, the ward closes the episode, and an unused balance sits
 * on the books for ever. This makes the answer explicit.
 */
export function settlementAtDischarge(deposit: DepositState): {
  action: 'REFUND_BALANCE' | 'CLOSE' | 'ALREADY_CLOSED';
  amount: number;
  message: string;
} {
  if (deposit.closedAt) {
    return { action: 'ALREADY_CLOSED', amount: 0, message: 'This deposit has already been closed.' };
  }

  const balance = depositBalance(deposit);
  if (balance > 0) {
    return {
      action: 'REFUND_BALANCE',
      amount: balance,
      message: `${formatNaira(balance)} of this deposit was not used and must be returned to the patient before the deposit is closed.`,
    };
  }

  return { action: 'CLOSE', amount: 0, message: 'The deposit was fully applied to charges and can be closed.' };
}

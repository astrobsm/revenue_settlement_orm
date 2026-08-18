/**
 * Deposits.
 *
 * One sentence decides every test here: THE BALANCE IS ALWAYS THE PATIENT'S.
 * A deposit cannot be drawn beyond what remains, cannot be spent on somebody
 * else's care, and whatever is left at discharge goes back rather than quietly
 * ageing into the hospital's income.
 */
import { describe, expect, it } from 'vitest';

import {
  canApplyDeposit,
  canRefundDeposit,
  depositBalance,
  depositEarned,
  planDepositApplication,
  settlementAtDischarge,
} from './deposits';

const deposit = (over: Record<string, unknown> = {}) => ({
  amount: 500_000_00, amountApplied: 0, amountRefunded: 0, closedAt: null, ...over,
});

// ---------------------------------------------------------------------------
describe('what the deposit is worth', () => {
  it('is entirely the patient\'s before anything is consumed', () => {
    expect(depositBalance(deposit())).toBe(500_000_00);
    expect(depositEarned(deposit())).toBe(0);
  });

  it('shrinks as services are consumed', () => {
    const d = deposit({ amountApplied: 120_000_00 });
    expect(depositBalance(d)).toBe(380_000_00);
    // Only the consumed part is the hospital's income (§21).
    expect(depositEarned(d)).toBe(120_000_00);
  });

  it('accounts for money already returned', () => {
    expect(depositBalance(deposit({ amountApplied: 100_000_00, amountRefunded: 400_000_00 }))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('drawing a deposit down', () => {
  const ids = { depositEncounterId: 'enc1', invoiceEncounterId: 'enc1' };

  it('allows a draw-down within the balance', () => {
    expect(canApplyDeposit({ deposit: deposit(), amount: 120_000_00, ...ids }).allowed).toBe(true);
  });

  it('allows drawing the whole remaining balance', () => {
    expect(canApplyDeposit({ deposit: deposit({ amountApplied: 400_000_00 }), amount: 100_000_00, ...ids }).allowed).toBe(true);
  });

  it('REFUSES to exceed the balance, and says what is still owed', () => {
    // Not capped silently: the patient owes the difference and somebody has to
    // tell them.
    const v = canApplyDeposit({ deposit: deposit({ amountApplied: 380_000_00 }), amount: 150_000_00, ...ids });
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('EXCEEDS_DEPOSIT_BALANCE');
    expect(v.availableAmount).toBe(120_000_00);
    expect(v.message).toContain('still owed by the patient');
  });

  it('REFUSES to spend one patient\'s deposit on another\'s bill', () => {
    const v = canApplyDeposit({
      deposit: deposit(), amount: 100, depositEncounterId: 'enc1', invoiceEncounterId: 'enc2',
    });
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('WRONG_ENCOUNTER');
  });

  it('refuses a closed deposit', () => {
    expect(canApplyDeposit({ deposit: deposit({ closedAt: new Date() }), amount: 100, ...ids }).code).toBe('DEPOSIT_CLOSED');
  });

  it('refuses an exhausted deposit', () => {
    const v = canApplyDeposit({ deposit: deposit({ amountApplied: 500_000_00 }), amount: 100, ...ids });
    expect(v.code).toBe('DEPOSIT_EXHAUSTED');
    expect(v.availableAmount).toBe(0);
  });

  it('refuses zero, negative and fractional amounts', () => {
    for (const amount of [0, -1, 1.5]) {
      expect(canApplyDeposit({ deposit: deposit(), amount, ...ids }).code).toBe('INVALID_AMOUNT');
    }
  });
});

// ---------------------------------------------------------------------------
describe('applying a deposit across a bill', () => {
  const charges = [
    { lineId: 'l1', chargeKind: 'BED_CHARGE', amount: 45_000_00 },
    { lineId: 'l2', chargeKind: 'NURSING', amount: 75_000_00 },
    { lineId: 'l3', chargeKind: 'DRUG', amount: 30_000_00 },
  ];

  it('names the service each part of the deposit paid for', () => {
    // "120,000 of the deposit was used" is not something a patient can check.
    const plan = planDepositApplication({ deposit: deposit(), charges });
    expect(plan.applications).toHaveLength(3);
    expect(plan.applications[0]).toEqual({ lineId: 'l1', chargeKind: 'BED_CHARGE', amount: 45_000_00 });
    expect(plan.totalApplied).toBe(150_000_00);
  });

  it('leaves the unused balance as the patient\'s', () => {
    const plan = planDepositApplication({ deposit: deposit(), charges });
    expect(plan.remainingDeposit).toBe(350_000_00);
    expect(plan.shortfall).toBe(0);
    expect(plan.summary).toContain("the patient's");
  });

  it('settles charges in order and stops when the deposit runs out', () => {
    const plan = planDepositApplication({ deposit: deposit({ amount: 50_000_00 }), charges });
    expect(plan.applications).toHaveLength(2);
    expect(plan.applications[0].amount).toBe(45_000_00);
    // The second charge is only part-covered.
    expect(plan.applications[1].amount).toBe(5_000_00);
    expect(plan.totalApplied).toBe(50_000_00);
  });

  it('reports the shortfall the patient still owes', () => {
    const plan = planDepositApplication({ deposit: deposit({ amount: 50_000_00 }), charges });
    expect(plan.shortfall).toBe(100_000_00);
    expect(plan.summary).toContain('still owed by the patient');
  });

  it('never applies more than the deposit holds', () => {
    for (const amount of [1, 999, 45_000_00, 150_000_00, 999_999_00]) {
      const plan = planDepositApplication({ deposit: deposit({ amount }), charges });
      expect(plan.totalApplied).toBeLessThanOrEqual(amount);
    }
  });

  it('applies nothing from an exhausted deposit', () => {
    const plan = planDepositApplication({ deposit: deposit({ amountApplied: 500_000_00 }), charges });
    expect(plan.totalApplied).toBe(0);
    expect(plan.shortfall).toBe(150_000_00);
  });

  it('ignores zero and negative charges rather than crediting them', () => {
    const plan = planDepositApplication({
      deposit: deposit(),
      charges: [{ lineId: 'l1', chargeKind: 'BED_CHARGE', amount: 0 }, { lineId: 'l2', chargeKind: 'NURSING', amount: 10_000_00 }],
    });
    expect(plan.applications).toHaveLength(1);
    expect(plan.totalApplied).toBe(10_000_00);
  });
});

// ---------------------------------------------------------------------------
describe('returning what was not used', () => {
  it('allows the unused balance to be returned', () => {
    const v = canRefundDeposit({ deposit: deposit({ amountApplied: 120_000_00 }) });
    expect(v.allowed).toBe(true);
    expect(v.refundableAmount).toBe(380_000_00);
  });

  it('allows a partial return', () => {
    expect(canRefundDeposit({ deposit: deposit(), amount: 100_000_00 }).allowed).toBe(true);
  });

  it('refuses to return more than is unused', () => {
    const v = canRefundDeposit({ deposit: deposit({ amountApplied: 400_000_00 }), amount: 200_000_00 });
    expect(v.allowed).toBe(false);
    expect(v.refundableAmount).toBe(100_000_00);
  });

  it('refuses when the deposit was fully consumed', () => {
    expect(canRefundDeposit({ deposit: deposit({ amountApplied: 500_000_00 }) }).code).toBe('NOTHING_TO_REFUND');
  });
});

// ---------------------------------------------------------------------------
describe('discharge', () => {
  it('requires the unused balance to go back before closing', () => {
    // The step most likely to be skipped: a patient goes home and a balance sits
    // on the books for ever.
    const d = settlementAtDischarge(deposit({ amountApplied: 120_000_00 }));
    expect(d.action).toBe('REFUND_BALANCE');
    expect(d.amount).toBe(380_000_00);
    expect(d.message).toContain('must be returned to the patient');
  });

  it('closes cleanly when the deposit was fully applied', () => {
    const d = settlementAtDischarge(deposit({ amountApplied: 500_000_00 }));
    expect(d.action).toBe('CLOSE');
    expect(d.amount).toBe(0);
  });

  it('says so if it is already closed', () => {
    expect(settlementAtDischarge(deposit({ closedAt: new Date() })).action).toBe('ALREADY_CLOSED');
  });
});

// ---------------------------------------------------------------------------
describe('the §21 worked example', () => {
  it('follows a deposit from receipt to discharge', () => {
    let d = deposit({ amount: 500_000_00 });
    expect(depositBalance(d)).toBe(500_000_00);
    expect(depositEarned(d)).toBe(0);

    // Services consumed.
    const plan = planDepositApplication({
      deposit: d,
      charges: [{ lineId: 'l1', chargeKind: 'BED_CHARGE', amount: 120_000_00 }],
    });
    d = { ...d, amountApplied: plan.totalApplied };

    expect(depositBalance(d)).toBe(380_000_00);
    expect(depositEarned(d)).toBe(120_000_00);

    // Discharge: the rest goes back.
    const discharge = settlementAtDischarge(d);
    expect(discharge.action).toBe('REFUND_BALANCE');
    expect(discharge.amount).toBe(380_000_00);

    // And once returned, nothing is left over.
    d = { ...d, amountRefunded: discharge.amount };
    expect(depositBalance(d)).toBe(0);
    expect(depositEarned(d)).toBe(120_000_00);
  });
});

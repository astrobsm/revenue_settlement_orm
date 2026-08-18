/**
 * Refunds.
 *
 * The tests that matter here are the ones about money that has ALREADY LEFT.
 * Refunding a patient is easy; the hard part is that their money may already
 * have been settled out to a pharmacy or a vendor, and no database update pulls
 * it back. The system's job is to say precisely who owes what, and never to
 * pretend the recovery has happened.
 */
import { describe, expect, it } from 'vitest';

import {
  canRequestRefund,
  canTransitionRefund,
  checkRefundApproval,
  isRefundTerminal,
  planRecovery,
  RefundStatus,
  refundIsFull,
  refundIsPaid,
} from './refunds';

// ---------------------------------------------------------------------------
describe('what may be refunded', () => {
  const base = {
    paymentAmount: 910_000_00,
    paymentStatus: 'SUCCESSFUL',
    paymentReversed: false,
    alreadyRefunded: 0,
    reason: 'Procedure cancelled after payment; patient discharged unoperated.',
  };

  it('allows a full refund of a successful payment', () => {
    expect(canRequestRefund({ ...base, amount: 910_000_00 }).allowed).toBe(true);
  });

  it('allows a partial refund', () => {
    expect(canRequestRefund({ ...base, amount: 50_000_00 }).allowed).toBe(true);
  });

  it('refuses more than the payment brought in', () => {
    const v = canRequestRefund({ ...base, amount: 910_000_01 });
    expect(v.code).toBe('EXCEEDS_REFUNDABLE');
  });

  it('counts what has already been refunded against the ceiling', () => {
    // The commonest way a refund process leaks money: two people handling one
    // complaint, each refunding the "remaining" balance.
    const v = canRequestRefund({ ...base, alreadyRefunded: 900_000_00, amount: 50_000_00 });
    expect(v.allowed).toBe(false);
    expect(v.message).toContain('already been refunded');
  });

  it('allows exactly the remainder', () => {
    expect(canRequestRefund({ ...base, alreadyRefunded: 900_000_00, amount: 10_000_00 }).allowed).toBe(true);
  });

  it('refuses a refund with no usable reason', () => {
    expect(canRequestRefund({ ...base, amount: 100, reason: 'nope' }).code).toBe('REASON_REQUIRED');
  });

  it('refuses zero, negative and fractional amounts', () => {
    for (const amount of [0, -1, 1.5]) {
      expect(canRequestRefund({ ...base, amount }).code).toBe('INVALID_AMOUNT');
    }
  });

  it('refuses to refund money that was never received', () => {
    for (const paymentStatus of ['PENDING', 'FAILED', 'CANCELLED', 'EXPIRED']) {
      expect(canRequestRefund({ ...base, paymentStatus, amount: 100 }).code).toBe('PAYMENT_NOT_REFUNDABLE');
    }
  });

  it('refuses to refund a payment that was reversed', () => {
    // A reversal and a refund are different corrections. Applying both to the
    // same money gives it back twice.
    const v = canRequestRefund({ ...base, paymentReversed: true, amount: 100 });
    expect(v.code).toBe('PAYMENT_REVERSED');
    expect(v.message).toContain('different corrections');
  });

  it('allows a further refund against a partially refunded payment', () => {
    expect(canRequestRefund({ ...base, paymentStatus: 'PARTIALLY_REFUNDED', alreadyRefunded: 100_00, amount: 100_00 }).allowed).toBe(true);
  });

  it('knows whether a refund settles the payment in full', () => {
    expect(refundIsFull({ paymentAmount: 1000, alreadyRefunded: 0, amount: 1000 })).toBe(true);
    expect(refundIsFull({ paymentAmount: 1000, alreadyRefunded: 600, amount: 400 })).toBe(true);
    expect(refundIsFull({ paymentAmount: 1000, alreadyRefunded: 0, amount: 400 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('the refund lifecycle', () => {
  it('runs request to review to approval to payment', () => {
    expect(canTransitionRefund('REQUESTED', 'UNDER_REVIEW').allowed).toBe(true);
    expect(canTransitionRefund('UNDER_REVIEW', 'APPROVED').allowed).toBe(true);
    expect(canTransitionRefund('APPROVED', 'PROCESSING').allowed).toBe(true);
    expect(canTransitionRefund('PROCESSING', 'REFUNDED').allowed).toBe(true);
  });

  it('allows rejection at every stage before the money moves', () => {
    for (const from of ['REQUESTED', 'UNDER_REVIEW', 'APPROVED'] as RefundStatus[]) {
      expect(canTransitionRefund(from, 'REJECTED').allowed).toBe(true);
    }
  });

  it('cannot pay a refund that was never approved', () => {
    expect(canTransitionRefund('REQUESTED', 'REFUNDED').allowed).toBe(false);
    expect(canTransitionRefund('UNDER_REVIEW', 'PROCESSING').allowed).toBe(false);
  });

  it('cannot un-refund money that has gone back to a patient', () => {
    const v = canTransitionRefund('REFUNDED', 'REJECTED');
    expect(v.allowed).toBe(false);
    expect(v.message).toContain('cannot be un-refunded');
  });

  it('cannot revive a rejected refund', () => {
    const v = canTransitionRefund('REJECTED', 'APPROVED');
    expect(v.allowed).toBe(false);
    expect(v.message).toContain('new request');
  });

  it('allows a FAILED refund to be retried, because the money did not move', () => {
    expect(canTransitionRefund('FAILED', 'PROCESSING').allowed).toBe(true);
  });

  it('treats a repeat of the same status as no change', () => {
    expect(canTransitionRefund('APPROVED', 'APPROVED').code).toBe('NO_CHANGE');
  });

  it('knows which states are final', () => {
    expect(isRefundTerminal('REFUNDED')).toBe(true);
    expect(isRefundTerminal('REJECTED')).toBe(true);
    expect(isRefundTerminal('FAILED')).toBe(false);
    expect(refundIsPaid('REFUNDED')).toBe(true);
    expect(refundIsPaid('APPROVED')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('unwinding what was allocated', () => {
  const distributions = [
    { id: 'd1', accountId: 'acct-surgery', amount: 500_000_00, status: 'PENDING' },
    { id: 'd2', accountId: 'acct-anaesthesia', amount: 100_000_00, status: 'PENDING' },
    { id: 'd3', accountId: 'acct-pharmacy', amount: 130_000_00, status: 'PENDING' },
    { id: 'd4', accountId: 'acct-consumables', amount: 80_000_00, status: 'PENDING' },
  ];

  it('cancels pending distributions and needs no recovery', () => {
    const plan = planRecovery({ refundAmount: 810_000_00, distributions });
    expect(plan.requiresRecovery).toBe(false);
    expect(plan.cancellable).toBe(810_000_00);
    expect(plan.recoverable).toBe(0);
    expect(plan.summary).toContain('Nothing needs recovering');
  });

  it('takes back proportionally on a partial refund, exactly', () => {
    // Half the allocation refunded: every beneficiary gives back half.
    const plan = planRecovery({ refundAmount: 405_000_00, distributions });
    expect(plan.lines.reduce((s, l) => s + l.amount, 0)).toBe(405_000_00);
    expect(plan.lines.find((l) => l.accountId === 'acct-surgery')?.amount).toBe(250_000_00);
  });

  it('sums exactly across a thousand awkward refund amounts', () => {
    // The unwind uses the same largest-remainder engine as the allocation, so a
    // refund can never take back more or less than it should.
    for (let amount = 1; amount <= 1000; amount++) {
      const plan = planRecovery({ refundAmount: amount, distributions });
      expect(plan.lines.reduce((s, l) => s + l.amount, 0)).toBe(amount);
    }
  });

  it('SEPARATES money already settled, and says so plainly', () => {
    // The case this module exists for: the pharmacy has already been paid.
    const plan = planRecovery({
      refundAmount: 810_000_00,
      distributions: [
        { id: 'd1', accountId: 'acct-surgery', amount: 500_000_00, status: 'PENDING' },
        { id: 'd3', accountId: 'acct-pharmacy', amount: 310_000_00, status: 'SETTLED' },
      ],
    });
    expect(plan.requiresRecovery).toBe(true);
    expect(plan.cancellable).toBe(500_000_00);
    expect(plan.recoverable).toBe(310_000_00);
    expect(plan.summary).toContain('ALREADY BEEN SETTLED');
    expect(plan.summary).toContain('does not take that money back automatically');
  });

  it('names each account the money must be recovered from', () => {
    const plan = planRecovery({
      refundAmount: 200_000_00,
      distributions: [
        { id: 'd1', accountId: 'vendor-acme', amount: 100_000_00, status: 'SETTLED' },
        { id: 'd2', accountId: 'acct-pharmacy', amount: 100_000_00, status: 'SETTLED' },
      ],
    });
    const accounts = plan.lines.filter((l) => l.method === 'RECOVER_SETTLED').map((l) => l.accountId).sort();
    expect(accounts).toEqual(['acct-pharmacy', 'vendor-acme']);
  });

  it('ignores distributions already cancelled or reversed', () => {
    const plan = planRecovery({
      refundAmount: 100_000_00,
      distributions: [
        { id: 'd1', accountId: 'a', amount: 100_000_00, status: 'PENDING' },
        { id: 'd2', accountId: 'b', amount: 500_000_00, status: 'CANCELLED' },
        { id: 'd3', accountId: 'c', amount: 500_000_00, status: 'REVERSED' },
      ],
    });
    expect(plan.lines).toHaveLength(1);
    expect(plan.lines[0].accountId).toBe('a');
  });

  it('handles a payment that was never allocated', () => {
    const plan = planRecovery({ refundAmount: 100_000_00, distributions: [] });
    expect(plan.requiresRecovery).toBe(false);
    expect(plan.summary).toContain('nothing to unwind');
  });

  it('never takes back more than was allocated', () => {
    // A deposit is not allocated as revenue, so a refund can legitimately exceed
    // the allocated total. It must not invent a negative balance somewhere.
    const plan = planRecovery({
      refundAmount: 910_000_00,
      distributions: [{ id: 'd1', accountId: 'a', amount: 810_000_00, status: 'PENDING' }],
    });
    expect(plan.lines.reduce((s, l) => s + l.amount, 0)).toBe(810_000_00);
  });
});

// ---------------------------------------------------------------------------
describe('approval', () => {
  const base = { status: 'REQUESTED' as RefundStatus, seniorApprovalThreshold: 100_000_00, requiresRecovery: false };

  it('lets a small refund through on one approval', () => {
    const v = checkRefundApproval({ ...base, amount: 50_000_00 });
    expect(v.allowed).toBe(true);
    expect(v.requiresSeniorApproval).toBe(false);
  });

  it('requires senior approval above the threshold', () => {
    expect(checkRefundApproval({ ...base, amount: 500_000_00 }).requiresSeniorApproval).toBe(true);
  });

  it('ALWAYS requires senior approval when money must be recovered', () => {
    // Someone is being asked to go and get money back from a department or a
    // vendor. That decision should be taken at the right level, not discovered
    // later by whoever has to make the call.
    const v = checkRefundApproval({ ...base, amount: 1_00, requiresRecovery: true });
    expect(v.requiresSeniorApproval).toBe(true);
  });

  it('refuses to approve a refund already paid', () => {
    expect(checkRefundApproval({ ...base, status: 'REFUNDED', amount: 100 }).allowed).toBe(false);
  });
});

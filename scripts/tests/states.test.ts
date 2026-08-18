/**
 * The payment state machine.
 *
 * The single most important test in this repository is the first one: a payment
 * cannot reach SUCCESSFUL because something claimed it did. Everything else in
 * the platform — allocation, settlement, receipts — is downstream of that status,
 * so if it can be set without proof, none of the rest of the controls matter.
 */
import { describe, expect, it } from 'vitest';

import {
  canTransition,
  countsTowardInvoicePaid,
  isMoneyHeld,
  isTerminal,
  needsBankReconciliation,
  PaymentStatus,
  requiresProof,
  transition,
  TransitionError,
} from './payments/states';

describe('nothing reaches SUCCESSFUL without proof (§2, §10)', () => {
  it('refuses a bare PENDING to SUCCESSFUL', () => {
    // This is the frontend saying "payment successful". It is worth nothing.
    const v = canTransition('PENDING', 'SUCCESSFUL');
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('PROOF_REQUIRED');
  });

  it('refuses a gateway claim with no provider transaction id', () => {
    const v = canTransition('PROCESSING', 'SUCCESSFUL', { trustBasis: 'GATEWAY_VERIFIED' });
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('PROVIDER_REFERENCE_REQUIRED');
  });

  it('accepts a verified gateway payment', () => {
    const v = canTransition('PROCESSING', 'SUCCESSFUL', {
      trustBasis: 'GATEWAY_VERIFIED',
      providerTransactionId: 'ps_tx_10023',
    });
    expect(v.allowed).toBe(true);
  });

  it('refuses a bank confirmation with no bank reference', () => {
    const v = canTransition('PENDING', 'SUCCESSFUL', { trustBasis: 'BANK_CONFIRMED' });
    expect(v.code).toBe('BANK_REFERENCE_REQUIRED');
  });

  it('refuses a desk attestation that names nobody', () => {
    // An unattributed attestation is not evidence.
    const v = canTransition('PENDING', 'SUCCESSFUL', { trustBasis: 'ATTESTED', evidenceRef: 'slip.jpg' });
    expect(v.code).toBe('ATTESTATION_REQUIRED');
  });

  it('refuses a desk attestation with no evidence', () => {
    const v = canTransition('PENDING', 'SUCCESSFUL', { trustBasis: 'ATTESTED', attestedByUserId: 'u1' });
    expect(v.code).toBe('EVIDENCE_REQUIRED');
  });

  it('accepts a named cashier with evidence, because a cash desk is real', () => {
    const v = canTransition('PENDING', 'SUCCESSFUL', {
      trustBasis: 'ATTESTED',
      attestedByUserId: 'u1',
      evidenceRef: 'teller-slip-4471.jpg',
    });
    expect(v.allowed).toBe(true);
  });

  it('rejects an invented trust basis', () => {
    const v = canTransition('PENDING', 'SUCCESSFUL', { trustBasis: 'TRUST_ME' as never });
    expect(v.allowed).toBe(false);
  });

  it('requires proof for refunds too — money leaving is money moving', () => {
    expect(requiresProof('REFUNDED')).toBe(true);
    expect(requiresProof('PARTIALLY_REFUNDED')).toBe(true);
    expect(canTransition('SUCCESSFUL', 'REFUNDED').allowed).toBe(false);
  });

  it('does not require proof to fail or cancel a payment', () => {
    expect(canTransition('PENDING', 'FAILED').allowed).toBe(true);
    expect(canTransition('PENDING', 'CANCELLED').allowed).toBe(true);
  });
});

describe('illegal moves are impossible', () => {
  it('cannot resurrect a FAILED payment', () => {
    const v = canTransition('FAILED', 'SUCCESSFUL', {
      trustBasis: 'GATEWAY_VERIFIED',
      providerTransactionId: 'x',
    });
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('ILLEGAL_TRANSITION');
    expect(v.message).toContain('final');
  });

  it('cannot revive a CANCELLED or EXPIRED payment', () => {
    for (const from of ['CANCELLED', 'EXPIRED', 'REVERSED', 'REFUNDED'] as PaymentStatus[]) {
      expect(canTransition(from, 'SUCCESSFUL', {
        trustBasis: 'GATEWAY_VERIFIED', providerTransactionId: 'x',
      }).allowed).toBe(false);
    }
  });

  it('cannot skip straight from DRAFT to SUCCESSFUL', () => {
    // A draft is not yet money. It must at least be pending first.
    expect(canTransition('DRAFT', 'SUCCESSFUL', {
      trustBasis: 'GATEWAY_VERIFIED', providerTransactionId: 'x',
    }).code).toBe('ILLEGAL_TRANSITION');
  });

  it('treats a repeat of the same status as no change, not an error', () => {
    // A webhook delivered five times must be harmless (§35).
    const v = canTransition('SUCCESSFUL', 'SUCCESSFUL');
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('NO_CHANGE');
  });

  it('every terminal status is genuinely terminal', () => {
    for (const s of ['FAILED', 'CANCELLED', 'EXPIRED', 'REFUNDED', 'REVERSED'] as PaymentStatus[]) {
      expect(isTerminal(s)).toBe(true);
      for (const to of ['SUCCESSFUL', 'PENDING', 'PROCESSING'] as PaymentStatus[]) {
        expect(canTransition(s, to).allowed).toBe(false);
      }
    }
  });

  it('allows a discrepancy to be resolved either way', () => {
    expect(canTransition('RECONCILIATION_REQUIRED', 'SUCCESSFUL', {
      trustBasis: 'BANK_CONFIRMED', bankReference: 'STMT-0091',
    }).allowed).toBe(true);
    expect(canTransition('RECONCILIATION_REQUIRED', 'FAILED').allowed).toBe(true);
  });
});

describe('transition() throws where a route would 409', () => {
  it('throws with a code that can be surfaced', () => {
    let caught: TransitionError | null = null;
    try {
      transition('PENDING', 'SUCCESSFUL');
    } catch (err) {
      caught = err as TransitionError;
    }
    expect(caught?.code).toBe('PROOF_REQUIRED');
  });

  it('returns the new status on success', () => {
    expect(transition('PENDING', 'INITIATED')).toBe('INITIATED');
  });
});

describe('which statuses mean the hospital holds the money', () => {
  it('counts SUCCESSFUL and PARTIALLY_REFUNDED', () => {
    expect(countsTowardInvoicePaid('SUCCESSFUL')).toBe(true);
    expect(countsTowardInvoicePaid('PARTIALLY_REFUNDED')).toBe(true);
  });

  it('counts a payment under reconciliation — the money did arrive', () => {
    // It arrived; what is in doubt is the paperwork, and refusing to count it
    // would leave a paid patient looking unpaid.
    expect(isMoneyHeld('RECONCILIATION_REQUIRED')).toBe(true);
  });

  it('does not count anything merely in progress', () => {
    for (const s of ['DRAFT', 'PENDING', 'INITIATED', 'PROCESSING'] as PaymentStatus[]) {
      expect(countsTowardInvoicePaid(s)).toBe(false);
    }
  });

  it('does not count money that has gone back out', () => {
    for (const s of ['REFUNDED', 'REVERSED', 'FAILED', 'CANCELLED', 'EXPIRED'] as PaymentStatus[]) {
      expect(countsTowardInvoicePaid(s)).toBe(false);
    }
  });
});

describe('attested payments stay visibly unreconciled (§51)', () => {
  it('flags a desk payment for bank reconciliation', () => {
    expect(needsBankReconciliation('ATTESTED')).toBe(true);
  });

  it('does not flag gateway or bank-confirmed payments', () => {
    expect(needsBankReconciliation('GATEWAY_VERIFIED')).toBe(false);
    expect(needsBankReconciliation('BANK_CONFIRMED')).toBe(false);
  });
});

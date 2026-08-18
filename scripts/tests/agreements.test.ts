/**
 * Vendor supply agreements.
 *
 * The levy is a deduction from a supplier's money. So the tests that matter are
 * the ones proving it CANNOT happen without consent — an unsigned agreement, a
 * revoked signature, or a percentage that moved after signing must all yield a
 * levy of zero and a vendor paid in full.
 */
import { describe, expect, it } from 'vitest';

import {
  AgreementSnapshot,
  canActivate,
  canEditLevy,
  checkLevyChange,
  consentStatementFor,
  levyInForce,
  signatureStatus,
} from './agreements';

const signature = (party: 'HOSPITAL' | 'VENDOR', bp: number, over: Record<string, unknown> = {}) => ({
  party,
  consentGiven: true,
  agreedLevyBasisPoints: bp,
  signedAt: new Date('2026-01-05'),
  revokedAt: null,
  ...over,
});

const agreement = (over: Partial<AgreementSnapshot> = {}): AgreementSnapshot => ({
  levyBasisPoints: 1500,
  status: 'ACTIVE',
  effectiveFrom: new Date('2026-01-01'),
  effectiveTo: null,
  coveredKinds: ['CONSUMABLE'],
  signatures: [signature('HOSPITAL', 1500), signature('VENDOR', 1500)],
  ...over,
});

const ASOF = new Date('2026-06-01');

describe('no levy without consent', () => {
  it('applies the agreed levy when both parties have signed', () => {
    const r = levyInForce({ agreement: agreement(), chargeKind: 'CONSUMABLE', asOf: ASOF });
    expect(r.basisPoints).toBe(1500);
  });

  it('applies NO levy when the vendor has not signed', () => {
    const r = levyInForce({
      agreement: agreement({ signatures: [signature('HOSPITAL', 1500)] }),
      chargeKind: 'CONSUMABLE',
      asOf: ASOF,
    });
    expect(r.basisPoints).toBe(0);
    expect(r.reason).toContain('VENDOR');
  });

  it('applies NO levy when the hospital has not signed', () => {
    const r = levyInForce({
      agreement: agreement({ signatures: [signature('VENDOR', 1500)] }),
      chargeKind: 'CONSUMABLE',
      asOf: ASOF,
    });
    expect(r.basisPoints).toBe(0);
  });

  it('applies NO levy when a signature has been revoked', () => {
    const r = levyInForce({
      agreement: agreement({
        signatures: [signature('HOSPITAL', 1500), signature('VENDOR', 1500, { revokedAt: new Date('2026-05-01') })],
      }),
      chargeKind: 'CONSUMABLE',
      asOf: ASOF,
    });
    expect(r.basisPoints).toBe(0);
  });

  it('applies NO levy when a party signed but withheld consent', () => {
    const r = levyInForce({
      agreement: agreement({
        signatures: [signature('HOSPITAL', 1500), signature('VENDOR', 1500, { consentGiven: false })],
      }),
      chargeKind: 'CONSUMABLE',
      asOf: ASOF,
    });
    expect(r.basisPoints).toBe(0);
  });

  it('applies NO levy where there is no agreement at all', () => {
    const r = levyInForce({ agreement: null, chargeKind: 'CONSUMABLE', asOf: ASOF });
    expect(r.basisPoints).toBe(0);
    expect(r.reason).toContain('no supply agreement');
  });

  it('applies NO levy while the agreement is only awaiting signature', () => {
    const r = levyInForce({
      agreement: agreement({ status: 'AWAITING_SIGNATURES' }),
      chargeKind: 'CONSUMABLE', asOf: ASOF,
    });
    expect(r.basisPoints).toBe(0);
  });

  it('applies NO levy while suspended or terminated', () => {
    for (const status of ['SUSPENDED', 'TERMINATED', 'SUPERSEDED', 'EXPIRED'] as const) {
      expect(levyInForce({ agreement: agreement({ status }), chargeKind: 'CONSUMABLE', asOf: ASOF }).basisPoints).toBe(0);
    }
  });
});

describe('a signature is for a PERCENTAGE, not merely for an agreement', () => {
  it('applies NO levy when the figure moved after signing', () => {
    // The whole point. Both parties signed at 15%; the row now says 20%.
    // Charging 20% would mean applying a number the vendor never agreed to.
    const r = levyInForce({
      agreement: agreement({
        levyBasisPoints: 2000,
        signatures: [signature('HOSPITAL', 1500), signature('VENDOR', 1500)],
      }),
      chargeKind: 'CONSUMABLE',
      asOf: ASOF,
    });
    expect(r.basisPoints).toBe(0);
  });

  it('reports those signatures as stale rather than missing', () => {
    const status = signatureStatus(
      agreement({ levyBasisPoints: 2000, signatures: [signature('HOSPITAL', 1500), signature('VENDOR', 1500)] })
    );
    expect(status.complete).toBe(false);
    expect(status.staleSignatures.sort()).toEqual(['HOSPITAL', 'VENDOR']);
    expect(status.message).toContain('re-signed');
  });
});

describe('scope and dates', () => {
  it('does not levy a charge kind the agreement does not cover', () => {
    const r = levyInForce({ agreement: agreement({ coveredKinds: ['IMPLANT'] }), chargeKind: 'CONSUMABLE', asOf: ASOF });
    expect(r.basisPoints).toBe(0);
    expect(r.reason).toContain('does not cover');
  });

  it('covers everything when no kinds are named', () => {
    expect(levyInForce({ agreement: agreement({ coveredKinds: [] }), chargeKind: 'IMPLANT', asOf: ASOF }).basisPoints).toBe(1500);
  });

  it('does not levy before the agreement takes effect', () => {
    const r = levyInForce({ agreement: agreement(), chargeKind: 'CONSUMABLE', asOf: new Date('2025-12-31') });
    expect(r.basisPoints).toBe(0);
  });

  it('does not levy after it expires', () => {
    const r = levyInForce({
      agreement: agreement({ effectiveTo: new Date('2026-03-31') }),
      chargeKind: 'CONSUMABLE', asOf: ASOF,
    });
    expect(r.basisPoints).toBe(0);
    expect(r.reason).toContain('expired');
  });
});

describe('the percentage is editable — but only before signature', () => {
  it('allows a draft to be edited with a reason', () => {
    const v = checkLevyChange({ status: 'DRAFT', currentBasisPoints: 1500, newBasisPoints: 2000, reason: 'Renegotiated at the supply meeting.' });
    expect(v.allowed).toBe(true);
    expect(v.requiresNewVersion).toBeFalsy();
  });

  it('refuses a draft edit with no reason', () => {
    expect(checkLevyChange({ status: 'DRAFT', currentBasisPoints: 1500, newBasisPoints: 2000 }).code).toBe('REASON_REQUIRED');
  });

  it('requires a NEW VERSION once it has gone out for signature', () => {
    const v = checkLevyChange({
      status: 'AWAITING_SIGNATURES', currentBasisPoints: 1500, newBasisPoints: 2000,
      reason: 'Renegotiated after the vendor came back.',
    });
    expect(v.allowed).toBe(true);
    expect(v.requiresNewVersion).toBe(true);
    expect(v.message).toContain('both parties must sign');
  });

  it('requires a new version to change a live agreement', () => {
    const v = checkLevyChange({ status: 'ACTIVE', currentBasisPoints: 1500, newBasisPoints: 1000, reason: 'Annual review reduced the share.' });
    expect(v.requiresNewVersion).toBe(true);
  });

  it('keeps the old agreement in force until the new one is signed', () => {
    // Stated in the message, and true of the data: superseding does not change
    // the current agreement's status until the replacement activates.
    const v = checkLevyChange({ status: 'ACTIVE', currentBasisPoints: 1500, newBasisPoints: 2500, reason: 'Vendor requested an increase.' });
    expect(v.message).toContain('stays in force');
  });

  it('cannot change a closed agreement at all', () => {
    for (const status of ['TERMINATED', 'SUPERSEDED', 'EXPIRED'] as const) {
      expect(checkLevyChange({ status, currentBasisPoints: 1500, newBasisPoints: 2000, reason: 'A long enough reason.' }).allowed).toBe(false);
    }
  });

  it('rejects a share outside 0 to 100 per cent', () => {
    for (const bp of [-1, 10_001, 15.5]) {
      expect(checkLevyChange({ status: 'DRAFT', currentBasisPoints: 1500, newBasisPoints: bp, reason: 'A long enough reason.' }).code).toBe('INVALID_SHARE');
    }
  });

  it('allows a zero levy — a vendor may supply with no share retained', () => {
    expect(checkLevyChange({ status: 'DRAFT', currentBasisPoints: 1500, newBasisPoints: 0, reason: 'Supply at no retained share this year.' }).allowed).toBe(true);
  });

  it('only a draft is editable in place', () => {
    expect(canEditLevy('DRAFT')).toBe(true);
    for (const s of ['AWAITING_SIGNATURES', 'ACTIVE', 'SUSPENDED', 'TERMINATED', 'SUPERSEDED', 'EXPIRED'] as const) {
      expect(canEditLevy(s)).toBe(false);
    }
  });
});

describe('activation requires both signatures', () => {
  it('refuses to activate an unsigned agreement', () => {
    const v = canActivate(agreement({ status: 'AWAITING_SIGNATURES', signatures: [] }));
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('SIGNATURES_INCOMPLETE');
  });

  it('refuses to activate on one signature alone', () => {
    const v = canActivate(agreement({ status: 'AWAITING_SIGNATURES', signatures: [signature('HOSPITAL', 1500)] }));
    expect(v.allowed).toBe(false);
    expect(v.message).toContain('VENDOR');
  });

  it('activates once both have signed at the stated figure', () => {
    expect(canActivate(agreement({ status: 'AWAITING_SIGNATURES' })).allowed).toBe(true);
  });

  it('refuses to reactivate a closed agreement', () => {
    expect(canActivate(agreement({ status: 'TERMINATED' })).allowed).toBe(false);
  });
});

describe('consent is informed', () => {
  it('tells the vendor the exact percentage and what it is taken from', () => {
    const text = consentStatementFor({
      party: 'VENDOR', vendorName: 'Acme Surgical Ltd', levyBasisPoints: 1500, coveredKinds: ['CONSUMABLE'],
    });
    expect(text).toContain('Acme Surgical Ltd');
    expect(text).toContain('15.00%');
    expect(text).toContain('CONSUMABLE');
    expect(text).toContain('may not be varied without a new agreement');
  });

  it('states the hospital side in the same terms', () => {
    const text = consentStatementFor({
      party: 'HOSPITAL', vendorName: 'Acme Surgical Ltd', levyBasisPoints: 2000, coveredKinds: [],
    });
    expect(text).toContain('20.00%');
    expect(text).toContain('all supplied items');
  });
});

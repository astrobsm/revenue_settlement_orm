/**
 * Roles, permissions and separation of duties.
 *
 * The permission tests are ordinary. The separation-of-duties tests are the ones
 * that matter: they encode §25's claim that no single person may hold a whole
 * fraud, and they are written as assertions about the matrix itself so that a
 * future well-meaning edit ("the cashier needs to fix allocation rules") fails
 * the build rather than quietly opening the door.
 */
import { describe, expect, it } from 'vitest';

import {
  ALL_ROLES,
  can,
  checkSeparationOfDuties,
  matrixFor,
  Permission as P,
  permissionsFor,
  reviewRoleCombination,
  RevenueRole,
} from './rbac';

describe('the matrix itself upholds §25', () => {
  it('no single role can both confirm payment and set allocation rules', () => {
    for (const role of ALL_ROLES) {
      if (role === 'SUPER_ADMINISTRATOR') continue; // audited, and SoD-checked per record
      const held = permissionsFor([role]);
      const both = held.has(P.PAYMENT_CONFIRM) && held.has(P.ALLOCATION_RULE_MANAGE);
      expect(both).toBe(false);
    }
  });

  it('no single role can both confirm payment and change bank accounts', () => {
    for (const role of ALL_ROLES) {
      if (role === 'SUPER_ADMINISTRATOR') continue;
      const held = permissionsFor([role]);
      expect(held.has(P.PAYMENT_CONFIRM) && held.has(P.ACCOUNT_MANAGE)).toBe(false);
    }
  });

  it('no single role can both set prices and confirm payment', () => {
    for (const role of ALL_ROLES) {
      if (role === 'SUPER_ADMINISTRATOR') continue;
      const held = permissionsFor([role]);
      expect(held.has(P.CATALOGUE_MANAGE) && held.has(P.PAYMENT_CONFIRM)).toBe(false);
    }
  });

  it('no single role can both request and approve a refund', () => {
    for (const role of ALL_ROLES) {
      if (role === 'SUPER_ADMINISTRATOR') continue;
      const held = permissionsFor([role]);
      // FINANCE_OFFICER intentionally holds both, because a refund may be
      // raised by finance; the per-record SoD check is what stops the SAME
      // person approving their OWN request. Assert that is the only exception.
      if (held.has(P.REFUND_REQUEST) && held.has(P.REFUND_APPROVE)) {
        expect(role).toBe('FINANCE_OFFICER');
      }
    }
  });

  it('the auditor can write nothing at all (§24)', () => {
    const held = matrixFor('AUDITOR');
    const writes = held.filter((p) =>
      /:(manage|create|issue|cancel|confirm|initiate|approve|reverse|apply|run|resolve|override-approve|override-request|request)$/.test(p)
    );
    // RECEIPT_VERIFY and REPORT_EXPORT are reads despite their verbs; anything
    // else appearing here means the auditor has been given a write.
    expect(writes).toEqual([]);
  });

  it('the finance administrator configures but never confirms money', () => {
    const held = permissionsFor(['FINANCE_ADMINISTRATOR']);
    expect(held.has(P.ALLOCATION_RULE_MANAGE)).toBe(true);
    expect(held.has(P.PAYMENT_CONFIRM)).toBe(false);
    expect(held.has(P.REFUND_APPROVE)).toBe(false);
  });

  it('the cashier confirms money but configures nothing', () => {
    const held = permissionsFor(['CASHIER']);
    expect(held.has(P.PAYMENT_CONFIRM)).toBe(true);
    expect(held.has(P.ALLOCATION_RULE_MANAGE)).toBe(false);
    expect(held.has(P.ACCOUNT_MANAGE)).toBe(false);
    expect(held.has(P.CATALOGUE_MANAGE)).toBe(false);
  });

  it('clinicians may request services but never price or confirm them', () => {
    for (const role of ['SURGEON', 'ANAESTHETIST', 'PHARMACY', 'STORES', 'LABORATORY'] as RevenueRole[]) {
      const held = permissionsFor([role]);
      expect(held.has(P.INVOICE_ADD_ITEM)).toBe(true);
      expect(held.has(P.PAYMENT_CONFIRM)).toBe(false);
      expect(held.has(P.CATALOGUE_MANAGE)).toBe(false);
      expect(held.has(P.DISCOUNT_APPROVE)).toBe(false);
    }
  });

  it('nobody but finance can approve a discount', () => {
    const approvers = ALL_ROLES.filter((r) => can([r], P.DISCOUNT_APPROVE));
    expect(approvers.sort()).toEqual(['FINANCE_OFFICER', 'SUPER_ADMINISTRATOR']);
  });
});

describe('separation of duties is checked per record (§25)', () => {
  const priorActs = [
    { duty: 'INVOICE_CREATED', userId: 'kemi' },
    { duty: 'PRICE_OVERRIDDEN', userId: 'kemi' },
  ];

  it('bars the person who raised the invoice from confirming its payment', () => {
    const v = checkSeparationOfDuties({ userId: 'kemi', duty: 'PAYMENT_CONFIRMED', priorActs });
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('SEPARATION_OF_DUTIES');
    expect(v.message).toContain('somebody else');
  });

  it('names the conflicting duty so the refusal can be explained', () => {
    const v = checkSeparationOfDuties({ userId: 'kemi', duty: 'PAYMENT_CONFIRMED', priorActs });
    expect(['INVOICE_CREATED', 'PRICE_OVERRIDDEN']).toContain(v.conflictingDuty!);
  });

  it('lets a DIFFERENT person confirm the same payment', () => {
    // The bar is on the person, not the record. A hospital with three finance
    // staff must still be able to work.
    const v = checkSeparationOfDuties({ userId: 'adaobi', duty: 'PAYMENT_CONFIRMED', priorActs });
    expect(v.allowed).toBe(true);
  });

  it('lets the same person act on a DIFFERENT record', () => {
    const v = checkSeparationOfDuties({ userId: 'kemi', duty: 'PAYMENT_CONFIRMED', priorActs: [] });
    expect(v.allowed).toBe(true);
  });

  it('bars approving your own discount', () => {
    const v = checkSeparationOfDuties({
      userId: 'kemi', duty: 'DISCOUNT_APPROVED',
      priorActs: [{ duty: 'DISCOUNT_APPLIED', userId: 'kemi' }],
    });
    expect(v.allowed).toBe(false);
  });

  it('bars approving your own refund request', () => {
    const v = checkSeparationOfDuties({
      userId: 'kemi', duty: 'REFUND_APPROVED',
      priorActs: [{ duty: 'REFUND_REQUESTED', userId: 'kemi' }],
    });
    expect(v.allowed).toBe(false);
  });

  it('bars confirming a settlement to a beneficiary you just changed', () => {
    const v = checkSeparationOfDuties({
      userId: 'kemi', duty: 'SETTLEMENT_CONFIRMED',
      priorActs: [{ duty: 'BENEFICIARY_CHANGED', userId: 'kemi' }],
    });
    expect(v.allowed).toBe(false);
  });

  it('bars confirming a settlement under allocation rules you just changed', () => {
    const v = checkSeparationOfDuties({
      userId: 'kemi', duty: 'SETTLEMENT_CONFIRMED',
      priorActs: [{ duty: 'ALLOCATION_RULE_CHANGED', userId: 'kemi' }],
    });
    expect(v.allowed).toBe(false);
  });

  it('is symmetric — order of the two duties does not matter', () => {
    const forward = checkSeparationOfDuties({
      userId: 'k', duty: 'DISCOUNT_APPROVED', priorActs: [{ duty: 'DISCOUNT_APPLIED', userId: 'k' }],
    });
    const backward = checkSeparationOfDuties({
      userId: 'k', duty: 'DISCOUNT_APPLIED', priorActs: [{ duty: 'DISCOUNT_APPROVED', userId: 'k' }],
    });
    expect(forward.allowed).toBe(false);
    expect(backward.allowed).toBe(false);
  });

  it('allows unrelated duties to be held by one person', () => {
    const v = checkSeparationOfDuties({
      userId: 'kemi', duty: 'PAYMENT_CONFIRMED',
      priorActs: [{ duty: 'RECEIPT_ISSUED', userId: 'kemi' }],
    });
    expect(v.allowed).toBe(true);
  });

  it('downgrades to a recorded warning only under an explicit policy', () => {
    const v = checkSeparationOfDuties({
      userId: 'kemi', duty: 'PAYMENT_CONFIRMED', priorActs, policyAllowsSelfService: true,
    });
    expect(v.allowed).toBe(true);
    expect(v.code).toBe('SOD_OVERRIDDEN');
    expect(v.message).toContain('recorded');
  });
});

describe('role combinations are reviewed before they are granted', () => {
  it('accepts a sensible single role', () => {
    expect(reviewRoleCombination(['CASHIER']).safe).toBe(true);
  });

  it('rejects cashier plus finance administrator', () => {
    // Confirm the money AND decide where it goes.
    const r = reviewRoleCombination(['CASHIER', 'FINANCE_ADMINISTRATOR']);
    expect(r.safe).toBe(false);
    expect(r.concerns.length).toBeGreaterThan(0);
  });

  it('rejects revenue officer plus cashier', () => {
    // Raise the bill AND confirm its payment.
    expect(reviewRoleCombination(['REVENUE_OFFICER', 'CASHIER']).safe).toBe(false);
  });

  it('rejects an auditor who holds any other role', () => {
    const r = reviewRoleCombination(['AUDITOR', 'CASHIER']);
    expect(r.safe).toBe(false);
    expect(r.concerns.join(' ')).toContain('auditing their own work');
  });

  it('accepts an auditor alone', () => {
    expect(reviewRoleCombination(['AUDITOR']).safe).toBe(true);
  });
});

describe('the super administrator is powerful but not exempt', () => {
  it('holds every permission', () => {
    expect(can(['SUPER_ADMINISTRATOR'], P.PAYMENT_CONFIRM)).toBe(true);
    expect(can(['SUPER_ADMINISTRATOR'], P.ALLOCATION_RULE_MANAGE)).toBe(true);
  });

  it('is still barred by separation of duties on a record it has touched', () => {
    // An exemption here would be a door, and a door in a separation-of-duties
    // control is the whole control.
    const v = checkSeparationOfDuties({
      userId: 'root', duty: 'PAYMENT_CONFIRMED',
      priorActs: [{ duty: 'PRICE_OVERRIDDEN', userId: 'root' }],
    });
    expect(v.allowed).toBe(false);
  });
});

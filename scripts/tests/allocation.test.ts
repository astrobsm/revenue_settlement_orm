/**
 * The allocation engine.
 *
 * The property that matters is not "the percentages look right" — it is that the
 * shares sum back to the total, EXACTLY, for every total and every rule set. A
 * kobo lost per invoice is a ledger that never reconciles and nobody can say why.
 *
 * So the tests below are mostly property tests over ranges of awkward numbers,
 * not a handful of tidy examples.
 */
import { describe, expect, it } from 'vitest';

import {
  allocate,
  allocateInvoice,
  AllocationRule,
  proRataLines,
  validateRuleSet,
} from './allocation';

const pct = (accountId: string, bp: number, priority = 0): AllocationRule => ({
  accountId, type: 'PERCENTAGE', shareBasisPoints: bp, priority,
});
const fixed = (accountId: string, amount: number, priority = 0): AllocationRule => ({
  accountId, type: 'FIXED', amount, priority,
});
const tier = (accountId: string, amount: number, priority = 0): AllocationRule => ({
  accountId, type: 'TIERED', amount, priority,
});
const residual = (accountId: string, priority = 99): AllocationRule => ({
  accountId, type: 'RESIDUAL', priority,
});

const total = (shares: { amount: number }[]) => shares.reduce((s, x) => s + x.amount, 0);

// ---------------------------------------------------------------------------
describe('percentage allocation is exact', () => {
  it('divides a clean amount cleanly', () => {
    const r = allocate(100_00, [pct('a', 5000), pct('b', 5000)]);
    expect(r.shares.map((s) => s.amount).sort((x, y) => x - y)).toEqual([50_00, 50_00]);
  });

  it('THE case: three ways on 100.00 loses nothing', () => {
    // 10000 / 3 = 3333.33 each. Rounding each down loses a kobo.
    const r = allocate(100_00, [pct('a', 3333), pct('b', 3333), pct('c', 3334)]);
    expect(r.allocated).toBe(100_00);
    expect(total(r.shares)).toBe(100_00);
  });

  it('sums exactly across a thousand consecutive totals', () => {
    // The property, near-exhaustively. This is the test that catches a
    // regression in the remainder handling.
    const rules = [pct('a', 3333), pct('b', 3333), pct('c', 3334)];
    for (let amount = 0; amount <= 1000; amount++) {
      const r = allocate(amount, rules);
      expect(total(r.shares)).toBe(amount);
    }
  });

  it('sums exactly for seven-way splits on prime totals', () => {
    const rules = [
      pct('a', 1429), pct('b', 1429), pct('c', 1429), pct('d', 1428),
      pct('e', 1428), pct('f', 1428), pct('g', 1429),
    ];
    for (const amount of [7, 13, 97, 1_009, 99_991, 1_000_003]) {
      expect(total(allocate(amount, rules).shares)).toBe(amount);
    }
  });

  it('compensates the account rounded down hardest, first', () => {
    // 1 kobo across three equal shares: exactly 0.333 each. The leftover kobo
    // goes to one account, deterministically, not to nobody.
    const r = allocate(1, [pct('a', 3333), pct('b', 3333), pct('c', 3334)]);
    expect(total(r.shares)).toBe(1);
    expect(r.shares.filter((s) => s.amount === 1)).toHaveLength(1);
  });

  it('splits the same way every time it is asked', () => {
    const rules = [pct('zebra', 3333), pct('alpha', 3333), pct('mid', 3334)];
    const first = allocate(7_777, rules).shares.map((s) => `${s.accountId}:${s.amount}`);
    for (let i = 0; i < 20; i++) {
      expect(allocate(7_777, rules).shares.map((s) => `${s.accountId}:${s.amount}`)).toEqual(first);
    }
  });

  it('treats partial percentages as proportions and warns', () => {
    // 30/60 configured — only 90%. The whole amount must still be distributed.
    const r = allocate(90_000, [pct('a', 3000), pct('b', 6000)]);
    expect(total(r.shares)).toBe(90_000);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('zero allocates zero to everybody rather than throwing', () => {
    const r = allocate(0, [pct('a', 5000), pct('b', 5000)]);
    expect(total(r.shares)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('fixed allocation', () => {
  it('takes a flat amount off the top and residual sweeps the rest', () => {
    const r = allocate(910_000_00, [fixed('surgeon', 500_000_00), residual('hospital')]);
    expect(total(r.shares)).toBe(910_000_00);
    expect(r.shares.find((s) => s.accountId === 'surgeon')?.amount).toBe(500_000_00);
    expect(r.shares.find((s) => s.accountId === 'hospital')?.amount).toBe(410_000_00);
  });

  it('is capped at what is available and reports the overclaim', () => {
    // A rule saying 100,000 against a 60,000 line pays 60,000 — never a
    // negative balance somewhere else.
    const r = allocate(60_000, [fixed('a', 100_000), residual('b')]);
    expect(total(r.shares)).toBe(60_000);
    expect(r.shares.find((s) => s.accountId === 'a')?.amount).toBe(60_000);
    expect(r.overclaimedBy).toBe(40_000);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('applies fixed before percentage', () => {
    // 100,000 fixed off 200,000, then 50/50 of the remaining 100,000.
    const r = allocate(200_000, [fixed('a', 100_000, 1), pct('b', 5000, 2), pct('c', 5000, 2)]);
    expect(total(r.shares)).toBe(200_000);
    expect(r.shares.find((s) => s.accountId === 'a')?.amount).toBe(100_000);
    expect(r.shares.find((s) => s.accountId === 'b')?.amount).toBe(50_000);
    expect(r.shares.find((s) => s.accountId === 'c')?.amount).toBe(50_000);
  });
});

// ---------------------------------------------------------------------------
describe('tiered allocation (§13)', () => {
  it('gives the first N kobo to the tier account and the rest to the next', () => {
    // "First 100,000 -> Account A, remaining -> Account B"
    const r = allocate(250_000, [tier('a', 100_000, 1), residual('b', 2)]);
    expect(r.shares.find((s) => s.accountId === 'a')?.amount).toBe(100_000);
    expect(r.shares.find((s) => s.accountId === 'b')?.amount).toBe(150_000);
    expect(total(r.shares)).toBe(250_000);
  });

  it('gives the tier account everything when the total is below the tier', () => {
    const r = allocate(40_000, [tier('a', 100_000, 1), residual('b', 2)]);
    expect(r.shares.find((s) => s.accountId === 'a')?.amount).toBe(40_000);
    expect(r.shares.find((s) => s.accountId === 'b')?.amount).toBe(0);
    expect(total(r.shares)).toBe(40_000);
  });

  it('stacks multiple tiers in priority order', () => {
    const r = allocate(500_000, [tier('a', 100_000, 1), tier('b', 200_000, 2), residual('c', 3)]);
    expect(r.shares.find((s) => s.accountId === 'a')?.amount).toBe(100_000);
    expect(r.shares.find((s) => s.accountId === 'b')?.amount).toBe(200_000);
    expect(r.shares.find((s) => s.accountId === 'c')?.amount).toBe(200_000);
    expect(total(r.shares)).toBe(500_000);
  });
});

// ---------------------------------------------------------------------------
describe('money is never stranded and never invented', () => {
  it('refuses rules that would leave money unallocated', () => {
    // Percentages summing under 100 WITH a residual is fine; with no residual
    // and no way to place the rest it must refuse rather than lose it.
    expect(() => allocate(100_000, [fixed('a', 10_000)])).toThrow(/unallocated/i);
  });

  it('refuses to allocate at all with no rules', () => {
    expect(() => allocate(100_000, [])).toThrow(/no allocation rules/i);
  });

  it('mirrors a negative total for a reversal', () => {
    // A refund unwinds a distribution using the same algorithm, so the two can
    // never disagree.
    const forward = allocate(910_000_00, [pct('a', 3333), pct('b', 3333), pct('c', 3334)]);
    const back = allocate(-910_000_00, [pct('a', 3333), pct('b', 3333), pct('c', 3334)]);
    expect(total(back.shares)).toBe(-910_000_00);
    forward.shares.forEach((f) => {
      const mirror = back.shares.find((b) => b.accountId === f.accountId);
      expect(mirror?.amount).toBe(-f.amount);
    });
  });

  it('rejects a fractional amount rather than rounding it silently', () => {
    expect(() => allocate(100.5, [pct('a', 10000)])).toThrow(/whole number of kobo/i);
  });
});

// ---------------------------------------------------------------------------
describe('the §54 acceptance case', () => {
  // Patient MR X, one bill of 910,000.00, allocated to five accounts.
  const lines = [
    { lineId: 'l1', chargeKind: 'PROFESSIONAL_SURGEON', lineTotal: 500_000_00 },
    { lineId: 'l2', chargeKind: 'PROFESSIONAL_ANAESTHETIST', lineTotal: 100_000_00 },
    { lineId: 'l3', chargeKind: 'ANAESTHESIA_DRUG', lineTotal: 75_000_00 },
    { lineId: 'l4', chargeKind: 'DRUG', lineTotal: 40_000_00 },
    { lineId: 'l5', chargeKind: 'IV_FLUID', lineTotal: 15_000_00 },
    { lineId: 'l6', chargeKind: 'CONSUMABLE', lineTotal: 80_000_00 },
    { lineId: 'l7', chargeKind: 'ADMISSION_DEPOSIT', lineTotal: 100_000_00 },
  ];

  const rules: Record<string, AllocationRule[]> = {
    PROFESSIONAL_SURGEON: [residual('acct-surgery')],
    PROFESSIONAL_ANAESTHETIST: [residual('acct-anaesthesia')],
    ANAESTHESIA_DRUG: [residual('acct-pharmacy')],
    DRUG: [residual('acct-pharmacy')],
    IV_FLUID: [residual('acct-pharmacy')],
    CONSUMABLE: [residual('acct-consumables')],
    ADMISSION_DEPOSIT: [residual('acct-admission')],
  };

  it('allocates exactly 910,000.00 and nothing else', () => {
    const r = allocateInvoice({ lines, rulesByChargeKind: rules, fallbackAccountId: 'acct-hospital' });
    expect(r.allocated).toBe(910_000_00);
  });

  it('produces the five destinations §54 specifies', () => {
    const r = allocateInvoice({ lines, rulesByChargeKind: rules, fallbackAccountId: 'acct-hospital' });
    const byAccount = new Map<string, number>();
    for (const s of r.rolledUp) byAccount.set(s.accountId, (byAccount.get(s.accountId) ?? 0) + s.amount);

    expect(byAccount.get('acct-surgery')).toBe(500_000_00);
    expect(byAccount.get('acct-anaesthesia')).toBe(100_000_00);
    // 75,000 anaesthetic + 40,000 procedure + 15,000 IV = 130,000 to pharmacy.
    //
    // NOTE ON THE SPEC. §54 states ₦115,000 here, but its own line items sum to
    // ₦130,000, and its five destinations then total ₦895,000 against a bill of
    // ₦910,000 — ₦15,000 unaccounted for. §16's worked example of the same case
    // says ₦130,000 and totals exactly ₦910,000. §16 is therefore the correct
    // figure and §54 contains an arithmetic slip.
    //
    // This is not a footnote. Reproducing §54 literally would mean building an
    // engine that loses ₦15,000 of a patient's money on this very invoice, and
    // allocate() refuses to do that by design — it was this test that surfaced
    // the discrepancy.
    expect(byAccount.get('acct-pharmacy')).toBe(130_000_00);
    expect(byAccount.get('acct-consumables')).toBe(80_000_00);
    expect(byAccount.get('acct-admission')).toBe(100_000_00);
  });

  it('allocates the bill exactly, which §54 as written does not', () => {
    const r = allocateInvoice({ lines, rulesByChargeKind: rules, fallbackAccountId: 'acct-hospital' });
    const destinations = total(r.rolledUp);
    expect(destinations).toBe(910_000_00);
    // The figures printed in §54 sum to 895,000.00. Asserted here so that if
    // anyone later "corrects" the engine to match the spec, this fails loudly.
    expect(destinations).not.toBe(895_000_00);
  });

  it('keeps every allocated kobo traceable to the line that caused it (§30)', () => {
    const r = allocateInvoice({ lines, rulesByChargeKind: rules, fallbackAccountId: 'acct-hospital' });
    expect(r.perLine).toHaveLength(7);
    for (const la of r.perLine) {
      const line = lines.find((l) => l.lineId === la.lineId)!;
      expect(total(la.shares)).toBe(line.lineTotal);
    }
  });
});

// ---------------------------------------------------------------------------
describe('the consumables development levy', () => {
  // Institutional policy: 15% of consumables revenue goes to the hospital
  // development account, 85% to theatre consumables. Configured as data in
  // prisma/seed.ts, not compiled in — these tests prove the ENGINE splits it
  // exactly, which is what makes the policy safe to change.
  const CONSUMABLE_RULES = [
    pct('acct-hospital-development', 1500, 1),
    pct('acct-consumables', 8500, 1),
  ];

  it('takes exactly 15% of the §54 consumables charge', () => {
    // 80,000.00 -> 12,000.00 development, 68,000.00 consumables.
    const r = allocate(80_000_00, CONSUMABLE_RULES);
    expect(r.shares.find((s) => s.accountId === 'acct-hospital-development')?.amount).toBe(12_000_00);
    expect(r.shares.find((s) => s.accountId === 'acct-consumables')?.amount).toBe(68_000_00);
    expect(total(r.shares)).toBe(80_000_00);
  });

  it('loses nothing on an amount that does not divide by 15%', () => {
    // 1,000.01 -> 15% is 150.0015. Somebody must get the odd kobo.
    const r = allocate(100_001, CONSUMABLE_RULES);
    expect(total(r.shares)).toBe(100_001);
  });

  it('sums exactly across a thousand consecutive consumables totals', () => {
    for (let amount = 0; amount <= 1000; amount++) {
      expect(total(allocate(amount, CONSUMABLE_RULES).shares)).toBe(amount);
    }
  });

  it('never gives the development fund more than the levy', () => {
    // A rounding scheme that over-credits the levy would quietly tax the
    // theatre. The development share must never exceed 15% rounded up by more
    // than the single kobo largest-remainder can hand it.
    for (const amount of [1, 7, 13, 99, 1_001, 33_333, 999_999]) {
      const dev = allocate(amount, CONSUMABLE_RULES).shares
        .find((s) => s.accountId === 'acct-hospital-development')!.amount;
      expect(dev).toBeLessThanOrEqual(Math.ceil((amount * 1500) / 10_000));
      expect(dev).toBeGreaterThanOrEqual(Math.floor((amount * 1500) / 10_000));
    }
  });

  it('validates as a complete 100% rule set', () => {
    expect(validateRuleSet(CONSUMABLE_RULES).valid).toBe(true);
  });

  it('applies across a whole invoice of many consumable lines', () => {
    const lines = Array.from({ length: 12 }, (_, i) => ({
      lineId: `c${i}`, chargeKind: 'CONSUMABLE', lineTotal: 1_777 * (i + 1),
    }));
    const billed = lines.reduce((s, l) => s + l.lineTotal, 0);
    const r = allocateInvoice({
      lines, rulesByChargeKind: { CONSUMABLE: CONSUMABLE_RULES }, fallbackAccountId: 'acct-hospital',
    });
    expect(r.allocated).toBe(billed);
    const dev = r.rolledUp.find((s) => s.accountId === 'acct-hospital-development')!.amount;
    const cons = r.rolledUp.find((s) => s.accountId === 'acct-consumables')!.amount;
    expect(dev + cons).toBe(billed);
  });

  it('levies a vendor line under a SIGNED supply agreement', () => {
    // This is what the levy is FOR: the vendor took over supply of the
    // consumable, and agreed the hospital retains a share of the revenue.
    const r = allocateInvoice({
      lines: [
        {
          lineId: 'consigned',
          chargeKind: 'CONSUMABLE',
          lineTotal: 50_000_00,
          overrideAccountId: 'vendor-acme',
          vendorLevy: { accountId: 'acct-hospital-development', basisPoints: 1500, agreementRef: 'CTR/AGR/2026/000004' },
        },
      ],
      rulesByChargeKind: { CONSUMABLE: CONSUMABLE_RULES },
      fallbackAccountId: 'acct-hospital',
    });
    const by = new Map(r.rolledUp.map((s) => [s.accountId, s.amount]));
    expect(by.get('acct-hospital-development')).toBe(7_500_00);
    expect(by.get('vendor-acme')).toBe(42_500_00);
    expect(r.allocated).toBe(50_000_00);
  });

  it('pays a vendor IN FULL where no agreement has been signed', () => {
    // No signed agreement means no consent, and deducting an unagreed share of
    // a supplier's money is not a default. lib/agreements.ts decides this; the
    // engine simply receives no levy.
    const r = allocateInvoice({
      lines: [{ lineId: 'consigned', chargeKind: 'CONSUMABLE', lineTotal: 50_000_00, overrideAccountId: 'vendor-acme' }],
      rulesByChargeKind: { CONSUMABLE: CONSUMABLE_RULES },
      fallbackAccountId: 'acct-hospital',
    });
    expect(r.rolledUp.find((s) => s.accountId === 'vendor-acme')?.amount).toBe(50_000_00);
    expect(r.rolledUp.find((s) => s.accountId === 'acct-hospital-development')).toBeUndefined();
  });

  it('honours a different negotiated percentage per vendor', () => {
    // The share is a commercial term and differs between suppliers.
    const r = allocateInvoice({
      lines: [
        { lineId: 'a', chargeKind: 'CONSUMABLE', lineTotal: 100_000_00, overrideAccountId: 'vendor-a', vendorLevy: { accountId: 'dev', basisPoints: 1500 } },
        { lineId: 'b', chargeKind: 'CONSUMABLE', lineTotal: 100_000_00, overrideAccountId: 'vendor-b', vendorLevy: { accountId: 'dev', basisPoints: 2500 } },
      ],
      rulesByChargeKind: { CONSUMABLE: CONSUMABLE_RULES },
      fallbackAccountId: 'acct-hospital',
    });
    const by = new Map(r.rolledUp.map((s) => [s.accountId, s.amount]));
    expect(by.get('vendor-a')).toBe(85_000_00);
    expect(by.get('vendor-b')).toBe(75_000_00);
    expect(by.get('dev')).toBe(40_000_00); // 15,000 + 25,000
    expect(r.allocated).toBe(200_000_00);
  });

  it('splits a vendor levy exactly on awkward amounts', () => {
    for (let amount = 1; amount <= 1000; amount++) {
      const r = allocateInvoice({
        lines: [{ lineId: 'x', chargeKind: 'CONSUMABLE', lineTotal: amount, overrideAccountId: 'v', vendorLevy: { accountId: 'dev', basisPoints: 1500 } }],
        rulesByChargeKind: { CONSUMABLE: CONSUMABLE_RULES },
        fallbackAccountId: 'acct-hospital',
      });
      expect(r.allocated).toBe(amount);
    }
  });

  it('mixes hospital-owned and vendor consumables on one bill, exactly', () => {
    const r = allocateInvoice({
      lines: [
        { lineId: 'own', chargeKind: 'CONSUMABLE', lineTotal: 80_000_00 },
        { lineId: 'consigned', chargeKind: 'CONSUMABLE', lineTotal: 50_000_00, overrideAccountId: 'vendor-acme', vendorLevy: { accountId: 'acct-hospital-development', basisPoints: 1500 } },
      ],
      rulesByChargeKind: { CONSUMABLE: CONSUMABLE_RULES },
      fallbackAccountId: 'acct-hospital',
    });
    const by = new Map(r.rolledUp.map((s) => [s.accountId, s.amount]));
    // 12,000 from hospital stock + 7,500 from the vendor line.
    expect(by.get('acct-hospital-development')).toBe(19_500_00);
    expect(by.get('acct-consumables')).toBe(68_000_00);
    expect(by.get('vendor-acme')).toBe(42_500_00);
    expect(r.allocated).toBe(130_000_00);
  });

  it('a zero-percent agreement pays the vendor in full', () => {
    const r = allocateInvoice({
      lines: [{ lineId: 'x', chargeKind: 'CONSUMABLE', lineTotal: 50_000_00, overrideAccountId: 'v', vendorLevy: { accountId: 'dev', basisPoints: 0 } }],
      rulesByChargeKind: { CONSUMABLE: CONSUMABLE_RULES },
      fallbackAccountId: 'acct-hospital',
    });
    expect(r.rolledUp.find((s) => s.accountId === 'v')?.amount).toBe(50_000_00);
  });

  it('refuses a levy that is not a share between 0 and 100 per cent', () => {
    expect(() =>
      allocateInvoice({
        lines: [{ lineId: 'x', chargeKind: 'CONSUMABLE', lineTotal: 1000, overrideAccountId: 'v', vendorLevy: { accountId: 'dev', basisPoints: 12_000 } }],
        rulesByChargeKind: { CONSUMABLE: CONSUMABLE_RULES },
        fallbackAccountId: 'acct-hospital',
      })
    ).toThrow(/between 0% and 100%/);
  });
});

// ---------------------------------------------------------------------------
describe('whole-invoice allocation', () => {
  it('splits a shared professional fee three ways, exactly', () => {
    const r = allocateInvoice({
      lines: [{ lineId: 'l1', chargeKind: 'PROFESSIONAL_SURGEON', lineTotal: 500_000_01 }],
      rulesByChargeKind: {
        PROFESSIONAL_SURGEON: [pct('hospital', 6000), pct('surgeon', 3000), pct('department', 1000)],
      },
      fallbackAccountId: 'acct-hospital',
    });
    expect(r.allocated).toBe(500_000_01);
  });

  it('routes a consignment line to its own vendor, not the consumables rule', () => {
    const r = allocateInvoice({
      lines: [
        { lineId: 'l1', chargeKind: 'CONSUMABLE', lineTotal: 30_000 },
        { lineId: 'l2', chargeKind: 'CONSUMABLE', lineTotal: 50_000, overrideAccountId: 'vendor-acme' },
      ],
      rulesByChargeKind: { CONSUMABLE: [residual('acct-consumables')] },
      fallbackAccountId: 'acct-hospital',
    });
    const byAccount = new Map<string, number>();
    for (const s of r.rolledUp) byAccount.set(s.accountId, (byAccount.get(s.accountId) ?? 0) + s.amount);
    expect(byAccount.get('vendor-acme')).toBe(50_000);
    expect(byAccount.get('acct-consumables')).toBe(30_000);
    expect(r.allocated).toBe(80_000);
  });

  it('sends unruled charges to the fallback and says so', () => {
    const r = allocateInvoice({
      lines: [{ lineId: 'l1', chargeKind: 'OXYGEN', lineTotal: 12_345 }],
      rulesByChargeKind: {},
      fallbackAccountId: 'acct-hospital',
    });
    expect(r.rolledUp[0].accountId).toBe('acct-hospital');
    expect(r.allocated).toBe(12_345);
    expect(r.warnings.join(' ')).toContain('OXYGEN');
  });

  it('drops zero lines rather than printing a puzzling zero', () => {
    const r = allocateInvoice({
      lines: [
        { lineId: 'l1', chargeKind: 'CONSUMABLE', lineTotal: 0 },
        { lineId: 'l2', chargeKind: 'CONSUMABLE', lineTotal: 500 },
      ],
      rulesByChargeKind: { CONSUMABLE: [residual('a')] },
      fallbackAccountId: 'acct-hospital',
    });
    expect(r.perLine).toHaveLength(1);
    expect(r.allocated).toBe(500);
  });

  it('stays exact over a forty-line invoice of awkward amounts', () => {
    const lines = Array.from({ length: 40 }, (_, i) => ({
      lineId: `l${i}`,
      chargeKind: i % 2 ? 'CONSUMABLE' : 'DRUG',
      lineTotal: 997 * (i + 1) + i,
    }));
    const billed = lines.reduce((s, l) => s + l.lineTotal, 0);
    const r = allocateInvoice({
      lines,
      rulesByChargeKind: {
        CONSUMABLE: [pct('a', 3333), pct('b', 6667)],
        DRUG: [pct('c', 1234), pct('d', 4383), pct('e', 4383)],
      },
      fallbackAccountId: 'acct-hospital',
    });
    expect(r.allocated).toBe(billed);
  });
});

// ---------------------------------------------------------------------------
describe('pro-rata part payments lose nothing (§20)', () => {
  const lines = [
    { lineId: 'a', lineTotal: 500_000_00 },
    { lineId: 'b', lineTotal: 100_000_00 },
    { lineId: 'c', lineTotal: 75_000_00 },
    { lineId: 'd', lineTotal: 40_000_00 },
    { lineId: 'e', lineTotal: 15_000_00 },
    { lineId: 'f', lineTotal: 80_000_00 },
  ];
  const invoiceTotal = lines.reduce((s, l) => s + l.lineTotal, 0); // 810,000.00

  const sumLines = (ls: { lineTotal: number }[]) => ls.reduce((s, l) => s + l.lineTotal, 0);

  it('returns the lines untouched when the payment settles the bill', () => {
    expect(proRataLines(lines, invoiceTotal, invoiceTotal)).toEqual(lines);
  });

  it('scales a part payment to exactly the amount paid', () => {
    const scaled = proRataLines(lines, 400_000_00, invoiceTotal);
    expect(sumLines(scaled)).toBe(400_000_00);
  });

  it('sums exactly across a thousand consecutive part payments', () => {
    // The property that matters: whatever the instalment, the scaled lines add
    // back to it precisely, so the allocation downstream is exact too.
    for (let paid = 1; paid <= 1000; paid++) {
      expect(sumLines(proRataLines(lines, paid, invoiceTotal))).toBe(paid);
    }
  });

  it('three instalments scale to exactly the whole invoice', () => {
    const instalments = [400_000_00, 300_000_00, 110_000_00];
    expect(instalments.reduce((a, b) => a + b, 0)).toBe(invoiceTotal);
    const allocated = instalments.reduce((s, amount) => s + sumLines(proRataLines(lines, amount, invoiceTotal)), 0);
    expect(allocated).toBe(invoiceTotal);
  });

  it('drops lines that scale to nothing rather than writing zero rows', () => {
    const scaled = proRataLines(lines, 1, invoiceTotal);
    expect(sumLines(scaled)).toBe(1);
    expect(scaled.every((l) => l.lineTotal > 0)).toBe(true);
  });

  it('is deterministic', () => {
    const first = JSON.stringify(proRataLines(lines, 12_345, invoiceTotal));
    for (let i = 0; i < 10; i++) {
      expect(JSON.stringify(proRataLines(lines, 12_345, invoiceTotal))).toEqual(first);
    }
  });

  it('refuses to allocate more than the lines are worth', () => {
    expect(() => proRataLines(lines, invoiceTotal + 1, invoiceTotal)).toThrow(/Cannot allocate/i);
  });

  it('feeds the allocation engine exactly, levy included', () => {
    // A part payment on a consumables-only bill still splits 15/85 exactly.
    const consumables = [{ lineId: 'x', chargeKind: 'CONSUMABLE', lineTotal: 80_000_00 }];
    const scaled = proRataLines(consumables, 33_333, 80_000_00);
    const r = allocateInvoice({
      lines: scaled,
      rulesByChargeKind: {
        CONSUMABLE: [pct('acct-hospital-development', 1500, 1), pct('acct-consumables', 8500, 1)],
      },
      fallbackAccountId: 'acct-hospital',
    });
    expect(r.allocated).toBe(33_333);
  });
});

// ---------------------------------------------------------------------------
describe('rule set validation is advice, not a gate', () => {
  it('accepts a complete 100% split', () => {
    expect(validateRuleSet([pct('a', 8000), pct('b', 2000)]).valid).toBe(true);
  });

  it('flags an incomplete split', () => {
    const v = validateRuleSet([pct('a', 8000), pct('b', 1000)]);
    expect(v.valid).toBe(false);
    expect(v.message).toContain('90.00%');
  });

  it('flags a split over 100%', () => {
    const v = validateRuleSet([pct('a', 8000), pct('b', 5000)]);
    expect(v.valid).toBe(false);
    expect(v.message).toContain('130.00%');
  });

  it('accepts percentages under 100 when a residual account exists', () => {
    expect(validateRuleSet([pct('a', 3000), residual('b')]).valid).toBe(true);
  });

  it('flags rules with neither a percentage nor a residual', () => {
    expect(validateRuleSet([fixed('a', 1000)]).valid).toBe(false);
  });
});

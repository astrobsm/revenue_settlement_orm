// ============================================================
// The revenue allocation engine (§12, §13)
// ------------------------------------------------------------
// One sentence governs this whole module: THE SHARES OF AN AMOUNT MUST SUM BACK
// TO THAT AMOUNT, EXACTLY, ALWAYS.
//
// Three accounts splitting 100.00 at a third each is 3,333.33 kobo apiece.
// Rounding each share independently gives 3,333 x 3 = 9,999 — a kobo short, on
// every invoice, for ever. Rounding up over-distributes instead. Either way the
// money collected and the money allocated disagree, and the reconciliation
// report grows a permanent unexplained line.
//
// So percentage shares are allocated by LARGEST REMAINDER: floor every share,
// then hand the leftover kobo out one at a time to whoever was rounded down
// hardest. The result sums exactly, and the account that lost most to rounding
// is compensated first, which is also the fairest reading.
//
// §13 asks for four allocation types, and they interact. The order below is the
// only one that is well defined, because each stage consumes from a shrinking
// remainder:
//
//   1. FIXED      a flat amount off the top          (₦100,000 -> Account A)
//   2. TIERED     the first N kobo                   (first ₦100,000 -> A, rest -> B)
//   3. PERCENTAGE proportional shares of what is left (10% / 90%)
//   4. RESIDUAL   whatever remains, exactly           (the sweep account)
//
// Fixed and tiered claims are CAPPED at what is actually available. A rule
// saying "₦100,000 to the surgeon" against a ₦60,000 line pays ₦60,000, not a
// negative balance elsewhere. Over-claiming is reported, never silently
// absorbed.
// ============================================================

import { assertKobo, BASIS_POINTS_TOTAL } from './money';

export type AllocationRuleType = 'FIXED' | 'TIERED' | 'PERCENTAGE' | 'RESIDUAL';

export interface AllocationRule {
  /** Destination. A RevenueAccount id. */
  accountId: string;
  type: AllocationRuleType;

  /** FIXED: kobo off the top. TIERED: the size of this account's tier, in kobo. */
  amount?: number;

  /** PERCENTAGE: share in basis points (1% = 100). */
  shareBasisPoints?: number;

  /**
   * Ties are broken on this, then on accountId, so the same input always
   * produces the same split — a split that varies run to run cannot be audited.
   */
  priority?: number;

  /** Carried through onto the resulting share so a distribution row can explain itself. */
  label?: string;
}

export interface AllocationShare {
  accountId: string;
  /** Kobo. */
  amount: number;
  /** Which rule produced this share, so the figure can be re-derived later. */
  ruleType: AllocationRuleType;
  shareBasisPoints: number | null;
  label?: string;
}

export interface AllocationResult {
  shares: AllocationShare[];
  /** Always equals the amount passed in. Asserted before returning. */
  allocated: number;
  /**
   * Set when fixed/tiered rules claimed more than was available. The allocation
   * is still exact; this says the CONFIGURATION is wrong and by how much.
   */
  overclaimedBy: number;
  /** Human-readable notes for the finance administrator. Never swallowed. */
  warnings: string[];
}

export class AllocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AllocationError';
  }
}

/**
 * Split `total` kobo across `rules`, exactly.
 *
 * `total` may be negative — a reversal allocates the same shares with the sign
 * flipped, which is how a refund unwinds a distribution without a second
 * algorithm that could disagree with this one.
 */
export function allocate(total: number, rules: AllocationRule[]): AllocationResult {
  assertKobo(total, 'amount to allocate');

  const warnings: string[] = [];
  if (rules.length === 0) {
    if (total !== 0) {
      throw new AllocationError(
        'There are no allocation rules for this amount, so it cannot be distributed. Configure a residual account rather than leaving money unallocated.'
      );
    }
    return { shares: [], allocated: 0, overclaimedBy: 0, warnings };
  }

  // Work in magnitude and re-apply the sign at the end, so a reversal is the
  // mirror image of the original allocation rather than a separate code path.
  const negative = total < 0;
  const magnitude = Math.abs(total);

  const ordered = [...rules].sort(compareRules);
  const shares: AllocationShare[] = [];
  let remaining = magnitude;
  let overclaimedBy = 0;

  // --- 1. FIXED: flat amounts off the top ---------------------------------
  for (const rule of ordered.filter((r) => r.type === 'FIXED')) {
    const want = requireRuleAmount(rule, 'FIXED');
    const available = remaining;
    const give = Math.min(want, available);
    if (give < want) {
      overclaimedBy += want - give;
      warnings.push(
        `A fixed allocation of ${want} kobo to account ${rule.accountId} exceeded the ${available} kobo still available; ${give} was allocated.`
      );
    }
    remaining -= give;
    shares.push({ accountId: rule.accountId, amount: give, ruleType: 'FIXED', shareBasisPoints: null, label: rule.label });
  }

  // --- 2. TIERED: the first N kobo, in priority order ---------------------
  for (const rule of ordered.filter((r) => r.type === 'TIERED')) {
    const tier = requireRuleAmount(rule, 'TIERED');
    const give = Math.min(tier, remaining);
    remaining -= give;
    shares.push({ accountId: rule.accountId, amount: give, ruleType: 'TIERED', shareBasisPoints: null, label: rule.label });
  }

  // --- 3. PERCENTAGE: largest remainder over what is left ----------------
  const percentageRules = ordered.filter((r) => r.type === 'PERCENTAGE');
  const residualRules = ordered.filter((r) => r.type === 'RESIDUAL');

  if (percentageRules.length > 0) {
    // When residual rules exist, percentages take their stated share of the
    // remainder and the residual sweeps the rest. When they do not, the
    // percentages are treated as proportions of whatever they sum to, so a
    // half-configured split still distributes the whole amount rather than
    // stranding money — and says so.
    const statedBp = percentageRules.reduce((s, r) => s + requireBasisPoints(r), 0);
    const divisorBp = residualRules.length > 0 ? BASIS_POINTS_TOTAL : statedBp;

    if (residualRules.length === 0 && statedBp !== BASIS_POINTS_TOTAL) {
      warnings.push(
        `Percentage shares for this charge total ${(statedBp / 100).toFixed(2)}%, not 100%. The whole amount has still been distributed in proportion, but the configuration is probably incomplete.`
      );
    }
    if (divisorBp <= 0) {
      throw new AllocationError('Percentage allocation rules sum to zero, so they cannot divide anything.');
    }

    const percentageBase = residualRules.length > 0
      ? Math.min(remaining, Math.floor((remaining * statedBp) / BASIS_POINTS_TOTAL))
      : remaining;

    const split = largestRemainder(
      percentageBase,
      percentageRules.map((r) => ({ weight: requireBasisPoints(r), key: rule_key(r) }))
    );

    percentageRules.forEach((rule, i) => {
      shares.push({
        accountId: rule.accountId,
        amount: split[i],
        ruleType: 'PERCENTAGE',
        shareBasisPoints: requireBasisPoints(rule),
        label: rule.label,
      });
    });

    remaining -= percentageBase;
  }

  // --- 4. RESIDUAL: everything still unallocated --------------------------
  if (remaining > 0) {
    if (residualRules.length === 0) {
      throw new AllocationError(
        `${remaining} kobo would be left unallocated by these rules and there is no residual account to receive it. Money must never be left with no destination.`
      );
    }
    const split = largestRemainder(
      remaining,
      residualRules.map((r) => ({ weight: 1, key: rule_key(r) }))
    );
    residualRules.forEach((rule, i) => {
      shares.push({ accountId: rule.accountId, amount: split[i], ruleType: 'RESIDUAL', shareBasisPoints: null, label: rule.label });
    });
    remaining = 0;
  } else {
    // A residual account with nothing left still gets an explicit zero, so the
    // distribution shows that it was considered rather than forgotten.
    for (const rule of residualRules) {
      shares.push({ accountId: rule.accountId, amount: 0, ruleType: 'RESIDUAL', shareBasisPoints: null, label: rule.label });
    }
  }

  const signed = negative ? shares.map((s) => ({ ...s, amount: -s.amount })) : shares;
  const allocated = signed.reduce((s, x) => s + x.amount, 0);

  // The invariant, asserted rather than assumed. If this ever throws, the bug
  // is here and no money has moved — which is the right place to fail.
  if (allocated !== total) {
    throw new AllocationError(
      `Allocation is not exact: ${total} kobo in, ${allocated} kobo out. This is a bug in the allocation engine and no distribution has been written.`
    );
  }

  return { shares: signed, allocated, overclaimedBy, warnings };
}

/**
 * Distribute `weights` proportionally over `total`, exactly, by largest
 * remainder. Returns amounts positionally matching `weights`.
 */
function largestRemainder(total: number, weights: { weight: number; key: string }[]): number[] {
  if (weights.length === 0) return [];
  const totalWeight = weights.reduce((s, w) => s + w.weight, 0);
  if (totalWeight <= 0) return weights.map(() => 0);
  if (total === 0) return weights.map(() => 0);

  const provisional = weights.map((w, index) => {
    const exact = (total * w.weight) / totalWeight;
    const floored = Math.floor(exact);
    return { index, key: w.key, amount: floored, remainder: exact - floored };
  });

  let leftover = total - provisional.reduce((s, p) => s + p.amount, 0);

  // Largest remainder first; ties broken on a stable key so the same invoice
  // always splits the same way.
  const order = [...provisional].sort((a, b) => {
    if (b.remainder !== a.remainder) return b.remainder - a.remainder;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });

  let i = 0;
  while (leftover > 0) {
    order[i % order.length].amount += 1;
    leftover -= 1;
    i += 1;
  }

  const out = new Array<number>(weights.length).fill(0);
  for (const p of provisional) out[p.index] = p.amount;
  return out;
}

function compareRules(a: AllocationRule, b: AllocationRule): number {
  const pa = a.priority ?? 0;
  const pb = b.priority ?? 0;
  if (pa !== pb) return pa - pb;
  return a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0;
}

function rule_key(r: AllocationRule): string {
  return `${r.priority ?? 0}:${r.accountId}`;
}

function requireRuleAmount(rule: AllocationRule, type: string): number {
  if (rule.amount == null) {
    throw new AllocationError(`A ${type} allocation rule for account ${rule.accountId} has no amount set.`);
  }
  assertKobo(rule.amount, `${type} allocation amount`);
  if (rule.amount < 0) {
    throw new AllocationError(`A ${type} allocation rule for account ${rule.accountId} has a negative amount.`);
  }
  return rule.amount;
}

function requireBasisPoints(rule: AllocationRule): number {
  if (rule.shareBasisPoints == null) {
    throw new AllocationError(`A PERCENTAGE allocation rule for account ${rule.accountId} has no shareBasisPoints set.`);
  }
  if (!Number.isInteger(rule.shareBasisPoints) || rule.shareBasisPoints < 0) {
    throw new AllocationError(`Share basis points must be a non-negative integer, got ${rule.shareBasisPoints}.`);
  }
  return rule.shareBasisPoints;
}

// ---------------------------------------------------------------------------
// Whole-invoice allocation
// ---------------------------------------------------------------------------

export interface LineToAllocate {
  /** The invoice line's id, so each share can be traced to the charge that caused it. */
  lineId: string;
  /** Charge kind — selects which rule set applies. */
  chargeKind: string;
  /** Kobo actually charged for this line. */
  lineTotal: number;
  /**
   * Set when this line bills consignment stock or a named beneficiary account
   * that overrides the generic rule for its charge kind. Ownership of a
   * consumable transfers at the moment it is used, so the vendor that supplied
   * that specific line is owed for it — not whoever the consumables rule names.
   */
  overrideAccountId?: string | null;
}

export interface LineAllocation {
  lineId: string;
  chargeKind: string;
  shares: AllocationShare[];
}

export interface InvoiceAllocationResult {
  perLine: LineAllocation[];
  /** One row per account per charge kind — what actually gets written. */
  rolledUp: (AllocationShare & { chargeKind: string })[];
  allocated: number;
  warnings: string[];
}

/**
 * Allocate a whole invoice, LINE BY LINE.
 *
 * Allocating per line rather than per charge-kind subtotal is deliberate: it is
 * what makes §30's requirement — every allocated naira traceable back to the
 * charge that produced it — actually true. Rolling up first would leave a
 * consumables total that no longer knows which vendor supplied which item.
 *
 * Each line's allocation is exact in itself, so the invoice total is exact too.
 */
export function allocateInvoice(params: {
  lines: LineToAllocate[];
  /** Allocation rules keyed by charge kind. */
  rulesByChargeKind: Record<string, AllocationRule[]>;
  /**
   * Where a charge kind with no configured rule goes. Without this a
   * misconfiguration would strand money; with it, the money lands in the
   * hospital's own account and the warning says it needs configuring.
   */
  fallbackAccountId: string;
}): InvoiceAllocationResult {
  const { lines, rulesByChargeKind, fallbackAccountId } = params;

  const perLine: LineAllocation[] = [];
  const warnings: string[] = [];
  const seenUnruled = new Set<string>();

  for (const line of lines) {
    assertKobo(line.lineTotal, `line ${line.lineId}`);
    if (line.lineTotal === 0) continue; // a zero line invites "why am I charged for this?"

    let rules: AllocationRule[];

    if (line.overrideAccountId) {
      rules = [{ accountId: line.overrideAccountId, type: 'RESIDUAL', label: 'named beneficiary' }];
    } else {
      const configured = rulesByChargeKind[line.chargeKind];
      if (configured && configured.length > 0) {
        rules = configured;
      } else {
        rules = [{ accountId: fallbackAccountId, type: 'RESIDUAL', label: 'unallocated — fallback' }];
        if (!seenUnruled.has(line.chargeKind)) {
          seenUnruled.add(line.chargeKind);
          warnings.push(
            `No allocation rule is configured for ${line.chargeKind}. Those charges have gone to the fallback hospital account; configure a rule so this is a decision rather than a default.`
          );
        }
      }
    }

    const result = allocate(line.lineTotal, rules);
    warnings.push(...result.warnings);
    perLine.push({ lineId: line.lineId, chargeKind: line.chargeKind, shares: result.shares });
  }

  // Roll up for writing: one row per account per charge kind. The same account
  // appearing twice for one kind reads as a duplicate to anyone checking.
  const merged = new Map<string, AllocationShare & { chargeKind: string }>();
  for (const la of perLine) {
    for (const s of la.shares) {
      const key = `${s.accountId}::${la.chargeKind}::${s.ruleType}`;
      const existing = merged.get(key);
      if (existing) existing.amount += s.amount;
      else merged.set(key, { ...s, chargeKind: la.chargeKind });
    }
  }

  const rolledUp = Array.from(merged.values()).filter((s) => s.amount !== 0);
  const allocated = rolledUp.reduce((s, x) => s + x.amount, 0);
  const billed = lines.reduce((s, l) => s + l.lineTotal, 0);

  if (allocated !== billed) {
    throw new AllocationError(
      `Invoice allocation is not exact: ${billed} kobo billed, ${allocated} kobo allocated. No distribution has been written.`
    );
  }

  return { perLine, rolledUp, allocated, warnings };
}

/**
 * Scale a set of lines down to a part payment, without losing a kobo (§20).
 *
 * Under PRO_RATA an instalment covers only part of the bill, so every line
 * contributes its proportion. The obvious implementation — multiply each line by
 * `target / total` and round — loses or invents kobo exactly as independent
 * rounding does everywhere else, so this uses largest remainder too and the
 * scaled amounts sum to `target` EXACTLY.
 *
 * Scaling the LINES rather than the resulting shares is deliberate: it keeps the
 * per-line traceability §30 requires, so a part payment still allocates through
 * the same rules and still names the charge behind every naira.
 */
export function proRataLines<T extends { lineId: string; lineTotal: number }>(lines: T[], target: number, total: number): T[] {
  assertKobo(target, 'amount to allocate');
  assertKobo(total, 'invoice total');

  if (target === total) return lines;
  if (target <= 0 || total <= 0) return [];
  if (target > total) {
    throw new AllocationError(`Cannot allocate ${target} kobo across lines totalling ${total} kobo.`);
  }

  const provisional = lines.map((l, index) => {
    const exact = (target * l.lineTotal) / total;
    const floored = Math.floor(exact);
    return { index, key: l.lineId, amount: floored, remainder: exact - floored };
  });

  let leftover = target - provisional.reduce((s, p) => s + p.amount, 0);
  const order = [...provisional].sort((a, b) => {
    if (b.remainder !== a.remainder) return b.remainder - a.remainder;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });

  let i = 0;
  while (leftover > 0) {
    order[i % order.length].amount += 1;
    leftover -= 1;
    i += 1;
  }

  const scaled = new Map(provisional.map((p) => [p.key, p.amount]));
  return lines
    .map((l) => ({ ...l, lineTotal: scaled.get(l.lineId) ?? 0 }))
    .filter((l) => l.lineTotal > 0);
}

// ---------------------------------------------------------------------------
// Configuration validation — for the settings screen, not the payment path
// ---------------------------------------------------------------------------

export interface RuleSetValidation {
  valid: boolean;
  totalBasisPoints: number;
  message?: string;
}

/**
 * Do the percentage rules for one charge kind add up to 100%?
 *
 * Deliberately a WARNING rather than a hard error at allocation time: a split
 * adding to 90% must still pay out the whole invoice, and refusing to allocate
 * would strand a patient's money over a configuration mistake. This is what the
 * settings screen shows, so the gap is closed on purpose rather than discovered
 * during a settlement run.
 */
export function validateRuleSet(rules: AllocationRule[]): RuleSetValidation {
  const percentage = rules.filter((r) => r.type === 'PERCENTAGE');
  const hasResidual = rules.some((r) => r.type === 'RESIDUAL');
  const total = percentage.reduce((s, r) => s + (r.shareBasisPoints ?? 0), 0);

  if (percentage.length === 0) {
    return hasResidual
      ? { valid: true, totalBasisPoints: 0 }
      : {
          valid: false,
          totalBasisPoints: 0,
          message: 'These rules have no percentage share and no residual account, so an amount could be left with nowhere to go.',
        };
  }
  if (hasResidual) return { valid: true, totalBasisPoints: total };
  if (total === BASIS_POINTS_TOTAL) return { valid: true, totalBasisPoints: total };

  const pct = (total / 100).toFixed(2);
  return {
    valid: false,
    totalBasisPoints: total,
    message:
      total < BASIS_POINTS_TOTAL
        ? `These shares total ${pct}%, not 100%. The remainder would still be distributed in proportion, but the split is probably incomplete — add a residual account or correct the shares.`
        : `These shares total ${pct}%, more than 100%. Each account would receive proportionally less than its stated share.`,
  };
}

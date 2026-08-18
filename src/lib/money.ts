// ============================================================
// Money
// ------------------------------------------------------------
// Every amount in this application is an INTEGER NUMBER OF KOBO. Never a float,
// never a Decimal, never naira.
//
// The reason is not taste. A surgical invoice here carries forty or more lines;
// float addition over forty lines drifts, and a 7.5% tax on a naira figure with
// two decimal places has no exact binary representation at all. One drifting
// kobo per invoice is a ledger that will not reconcile and nobody can say why.
//
// Kobo also makes the allocation engine's central guarantee expressible: the
// shares of an integer can be made to sum back to that integer exactly. That is
// not true of floats.
//
// Naira exists ONLY at the edges — a printed bill, a screen, an export. It is
// produced by formatNaira() and never fed back into arithmetic.
// ============================================================

/** 100 kobo to the naira. */
export const KOBO_PER_NAIRA = 100;

/** Basis points: 1% = 100bp, 100% = 10,000bp. Integers, for the same reason. */
export const BASIS_POINTS_TOTAL = 10_000;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/**
 * Assert an amount is a usable quantity of kobo.
 *
 * Rejects floats loudly rather than rounding them silently. A float reaching
 * this layer means someone multiplied naira somewhere upstream, and rounding it
 * here would hide the bug that produced it.
 */
export function assertKobo(amount: number, label = 'amount'): number {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new MoneyError(`${label} must be a finite number of kobo, got ${String(amount)}.`);
  }
  if (!Number.isInteger(amount)) {
    throw new MoneyError(
      `${label} must be a whole number of kobo, got ${amount}. Amounts are kobo — a fractional kobo means naira leaked into the arithmetic.`
    );
  }
  if (!Number.isSafeInteger(amount)) {
    throw new MoneyError(`${label} is too large to be exact (${amount}).`);
  }
  return amount;
}

/** Assert an amount is kobo and not negative. Charges and payments are positive. */
export function assertPositiveKobo(amount: number, label = 'amount'): number {
  assertKobo(amount, label);
  if (amount <= 0) {
    throw new MoneyError(`${label} must be greater than zero, got ${amount}.`);
  }
  return amount;
}

/** Naira (possibly fractional, from a form) to exact kobo. */
export function nairaToKobo(naira: number): number {
  if (typeof naira !== 'number' || !Number.isFinite(naira)) {
    throw new MoneyError(`Cannot convert ${String(naira)} naira to kobo.`);
  }
  // Round rather than truncate: 1234.565 entered by a clerk should become
  // 123457 kobo, not 123456. The rounding happens here, once, at the boundary.
  const kobo = Math.round(naira * KOBO_PER_NAIRA);
  return assertKobo(kobo, 'converted amount');
}

/** Kobo to naira as a number. For display and export only — never arithmetic. */
export function koboToNaira(kobo: number): number {
  assertKobo(kobo);
  return kobo / KOBO_PER_NAIRA;
}

/**
 * Kobo as a naira string for a bill, a receipt or a screen.
 *
 * Always two decimal places, always grouped, always with the naira sign, so an
 * amount cannot be misread as a different order of magnitude on a printed bill.
 */
export function formatNaira(kobo: number, options: { sign?: boolean } = {}): string {
  assertKobo(kobo);
  const negative = kobo < 0;
  const body = (Math.abs(kobo) / KOBO_PER_NAIRA).toLocaleString('en-NG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const prefix = negative ? '-' : options.sign ? '+' : '';
  return `${prefix}₦${body}`;
}

/** Sum kobo exactly. Asserts each term, so one bad line fails loudly. */
export function sumKobo(amounts: number[], label = 'amount'): number {
  let total = 0;
  for (const a of amounts) total += assertKobo(a, label);
  return assertKobo(total, 'total');
}

/**
 * Apply a basis-point rate to an amount, exactly once.
 *
 * Used for tax and for a single percentage share. Rounds half away from zero,
 * which is what a finance officer checking the figure by hand will do. Anywhere
 * several shares must sum back to a total, use the allocation engine instead —
 * rounding each share independently is precisely what loses the kobo.
 */
export function applyBasisPoints(amount: number, basisPoints: number): number {
  assertKobo(amount);
  if (!Number.isInteger(basisPoints)) {
    throw new MoneyError(`Basis points must be an integer, got ${basisPoints}.`);
  }
  const exact = (Math.abs(amount) * basisPoints) / BASIS_POINTS_TOTAL;
  const rounded = Math.round(exact);
  return amount < 0 ? -rounded : rounded;
}

export function basisPointsToPercent(bp: number): number {
  return Math.round((bp / 100) * 100) / 100;
}

export function percentToBasisPoints(percent: number): number {
  return Math.round(percent * 100);
}

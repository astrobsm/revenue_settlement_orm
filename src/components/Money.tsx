import { formatNaira } from '@/lib/money';

/**
 * An amount, rendered so it can be checked against a printed bill.
 *
 * Tabular figures, so digits line up down a column — that is what lets somebody
 * scan a bill and see that the total is right. `title` carries the exact kobo
 * value, because a rounding question at a desk is settled by the kobo, not by
 * what the naira display rounded to.
 */
export function Money({
  kobo,
  className = '',
  emphasis = false,
}: {
  kobo: number;
  className?: string;
  emphasis?: boolean;
}) {
  return (
    <span
      className={`figure ${emphasis ? 'font-semibold' : ''} ${className}`}
      title={`${kobo.toLocaleString('en-NG')} kobo`}
    >
      {formatNaira(kobo)}
    </span>
  );
}

/** Naira typed by a clerk, converted to kobo at the boundary and nowhere else. */
export function nairaInputToKobo(value: string): number | null {
  const cleaned = value.replace(/[₦,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

import { formatNaira } from '@/lib/money';

/**
 * A signed change — money in, or money out.
 *
 * THE ARROW AND THE WORD ARE NOT DECORATION AND NOT OPTIONAL. Green versus red
 * is the worst pair in colour-vision terms: measured on this app's own palette,
 * the naive steps sat at ΔE 7.2 under protanopia and 2.3 under deuteranopia —
 * the second is indistinguishable. Roughly one man in twelve reads this screen
 * that way.
 *
 * So this component cannot render a colour without also rendering a glyph and a
 * label. There is no prop to turn them off, which is the only way a rule like
 * this survives contact with a deadline.
 */
export function Delta({
  kobo,
  /** What the direction MEANS here, in words. "received", "refunded", "owed". */
  label,
  /**
   * Whether a rise is good. Collections rising is good; refunds rising is not,
   * and colouring both green because both went up would be actively misleading.
   */
  upIsGood = true,
  showAmount = true,
}: {
  kobo: number;
  label: string;
  upIsGood?: boolean;
  showAmount?: boolean;
}) {
  const rising = kobo >= 0;
  const good = rising === upIsGood;

  return (
    <span
      className="inline-flex items-baseline gap-1 text-sm font-medium"
      style={{ color: good ? 'var(--money-in)' : 'var(--money-out)' }}
    >
      {/* aria-hidden: the direction is already in the label text for a screen
          reader, and a lone arrow character read aloud is noise. */}
      <span aria-hidden className="text-xs">
        {rising ? '▲' : '▼'}
      </span>
      {showAmount && <span className="figure">{formatNaira(Math.abs(kobo))}</span>}
      <span className="font-normal">{label}</span>
    </span>
  );
}

/**
 * A status pill. Same rule: an icon and a word, always.
 *
 * Status colours are reserved and never reused as a series colour — a pill that
 * looks like a chart series teaches the reader the wrong thing about both.
 */
export function StatusPill({
  tone,
  children,
}: {
  tone: 'good' | 'warn' | 'critical' | 'neutral';
  children: React.ReactNode;
}) {
  const map = {
    good: { fg: 'var(--status-good)', bg: 'var(--status-good-bg)', glyph: '✓' },
    warn: { fg: 'var(--status-warn)', bg: 'var(--status-warn-bg)', glyph: '!' },
    critical: { fg: 'var(--status-critical)', bg: 'var(--status-critical-bg)', glyph: '✕' },
    neutral: { fg: 'var(--ink-secondary)', bg: 'var(--surface-sunken)', glyph: '·' },
  }[tone];

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium"
      style={{ color: map.fg, background: map.bg }}
    >
      <span aria-hidden className="font-mono">
        {map.glyph}
      </span>
      {children}
    </span>
  );
}

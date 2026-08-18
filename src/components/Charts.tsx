'use client';

// ============================================================
// The chart pieces
// ------------------------------------------------------------
// Plain HTML and inline SVG — no chart library. Three forms, each chosen because
// of what its data's JOB is rather than because it looks like a dashboard:
//
//   SettlementChain   ordered stages of one amount  -> ORDINAL, one-hue ramp
//   RankedBars        magnitude across departments  -> one series, one hue
//   CollectionTrend   change over time              -> line, with a crosshair
//
// The chain is deliberately NOT four differently-coloured segments. Its stages
// are ordered — collected, then allocated, then settled — so the colour carries
// the order, which is what an ordinal ramp is for. Giving each stage its own hue
// would spend the identity channel re-encoding a sequence the layout already
// shows.
//
// Every form here carries a hover layer, because an HTML chart IS interactive
// and a figure you cannot interrogate is a figure you have to take on trust.
// ============================================================

import { useState } from 'react';
import { formatNaira } from '@/lib/money';

const RAMP = ['var(--ramp-1)', 'var(--ramp-2)', 'var(--ramp-3)', 'var(--ramp-4)'];

// ---------------------------------------------------------------------------
// The §30 chain
// ---------------------------------------------------------------------------

export interface Stage {
  label: string;
  kobo: number;
  /** What this stage means, shown on hover. */
  meaning: string;
}

export function SettlementChain({ stages }: { stages: Stage[] }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const max = Math.max(...stages.map((s) => s.kobo), 1);

  return (
    <div>
      <ol className="space-y-2.5">
        {stages.map((stage, i) => {
          const pct = (stage.kobo / max) * 100;
          const active = hovered === i;

          return (
            <li
              key={stage.label}
              // The hit target is the whole row, not the bar: a 12px-tall mark is
              // not something to ask somebody to hit with a mouse.
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}
              onFocus={() => setHovered(i)}
              onBlur={() => setHovered(null)}
              tabIndex={0}
              className="group relative cursor-default rounded outline-none focus-visible:ring-2"
              style={{ ...(active ? { background: 'var(--surface-sunken)' } : {}) }}
            >
              <div className="flex items-baseline justify-between gap-4 px-2 pt-1.5">
                <span className="text-sm" style={{ color: 'var(--ink-secondary)' }}>
                  {stage.label}
                </span>
                {/* Direct label on every stage: there are only four, so a legend
                    would be a lookup table for something that fits inline. */}
                <span className="figure text-sm font-semibold">{formatNaira(stage.kobo)}</span>
              </div>

              <div className="px-2 pb-2 pt-1">
                <div className="h-2.5 w-full overflow-hidden rounded" style={{ background: 'var(--surface-sunken)' }}>
                  <div
                    className="bar-fill h-full"
                    style={{ width: `${pct}%`, background: RAMP[Math.min(i, RAMP.length - 1)] }}
                  />
                </div>
              </div>

              {active && (
                <div
                  role="tooltip"
                  className="absolute left-2 top-full z-10 mt-1 max-w-xs rounded px-3 py-2 text-xs shadow-lg"
                  style={{ background: 'var(--ink)', color: 'var(--plane)' }}
                >
                  {stage.meaning}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ranked bars — one series, one hue
// ---------------------------------------------------------------------------

export interface RankedItem {
  label: string;
  kobo: number;
  sub?: string;
}

export function RankedBars({ items, emptyNote }: { items: RankedItem[]; emptyNote: string }) {
  const [hovered, setHovered] = useState<string | null>(null);

  if (items.length === 0) {
    return (
      <p className="rounded p-4 text-sm" style={{ background: 'var(--surface-sunken)', color: 'var(--ink-secondary)' }}>
        {emptyNote}
      </p>
    );
  }

  const max = Math.max(...items.map((i) => i.kobo), 1);
  const total = items.reduce((s, i) => s + i.kobo, 0);

  return (
    <ul className="space-y-1">
      {items.map((item) => {
        const pct = (item.kobo / max) * 100;
        const share = total > 0 ? (item.kobo / total) * 100 : 0;
        const active = hovered === item.label;

        return (
          <li
            key={item.label}
            onMouseEnter={() => setHovered(item.label)}
            onMouseLeave={() => setHovered(null)}
            onFocus={() => setHovered(item.label)}
            onBlur={() => setHovered(null)}
            tabIndex={0}
            className="relative rounded px-2 py-1.5 outline-none focus-visible:ring-2"
            style={active ? { background: 'var(--surface-sunken)' } : undefined}
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="truncate text-sm">{item.label}</span>
              <span className="figure shrink-0 text-sm font-medium">{formatNaira(item.kobo)}</span>
            </div>
            <div className="mt-1 h-2 w-full overflow-hidden rounded" style={{ background: 'var(--surface-sunken)' }}>
              {/* ONE series, so ONE colour for every bar. Colouring bars by their
                  own value would re-encode what the length already says. */}
              <div className="bar-fill h-full" style={{ width: `${pct}%`, background: 'var(--brand)' }} />
            </div>

            {active && (
              <div
                role="tooltip"
                className="absolute right-2 top-full z-10 mt-1 rounded px-3 py-2 text-xs shadow-lg"
                style={{ background: 'var(--ink)', color: 'var(--plane)' }}
              >
                <span className="figure">{share.toFixed(1)}%</span> of the total
                {item.sub && <> · {item.sub}</>}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Collections over time — a line with a crosshair
// ---------------------------------------------------------------------------

export interface TrendPoint {
  label: string;
  kobo: number;
}

export function CollectionTrend({ points }: { points: TrendPoint[] }) {
  const [index, setIndex] = useState<number | null>(null);

  if (points.length < 2) {
    return (
      <p className="rounded p-4 text-sm" style={{ background: 'var(--surface-sunken)', color: 'var(--ink-secondary)' }}>
        Not enough days of collection yet to draw a trend. It appears once there are two.
      </p>
    );
  }

  const W = 640;
  const H = 140;
  const PAD = 8;
  const max = Math.max(...points.map((p) => p.kobo), 1);

  const x = (i: number) => PAD + (i / (points.length - 1)) * (W - PAD * 2);
  const y = (kobo: number) => H - PAD - (kobo / max) * (H - PAD * 2);

  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(p.kobo).toFixed(1)}`).join(' ');
  const area = `${path} L ${x(points.length - 1).toFixed(1)} ${H - PAD} L ${x(0).toFixed(1)} ${H - PAD} Z`;

  const active = index !== null ? points[index] : null;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label={`Collections over the last ${points.length} days`}
        onMouseLeave={() => setIndex(null)}
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const ratio = (event.clientX - rect.left) / rect.width;
          const i = Math.round(ratio * (points.length - 1));
          setIndex(Math.max(0, Math.min(points.length - 1, i)));
        }}
      >
        {/* A recessive baseline, and no gridlines: at this size a grid is chrome
            competing with a line that has only one job. */}
        <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="var(--axis)" strokeWidth="1" />

        <path d={area} fill="var(--brand)" opacity="0.10" />
        {/* 2px line, per the mark spec. */}
        <path d={path} fill="none" stroke="var(--brand)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

        {active && index !== null && (
          <>
            <line x1={x(index)} y1={PAD} x2={x(index)} y2={H - PAD} stroke="var(--axis)" strokeWidth="1" strokeDasharray="3 3" />
            {/* A 2px surface ring, so the marker reads on top of the line rather
                than merging with it. */}
            <circle cx={x(index)} cy={y(active.kobo)} r="5" fill="var(--brand)" stroke="var(--surface)" strokeWidth="2" />
          </>
        )}
      </svg>

      <div className="mt-1 flex justify-between px-1 text-xs" style={{ color: 'var(--ink-muted)' }}>
        <span>{points[0].label}</span>
        <span>{points[points.length - 1].label}</span>
      </div>

      {active && (
        <div
          role="tooltip"
          className="pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 rounded px-3 py-1.5 text-xs shadow-lg"
          style={{ background: 'var(--ink)', color: 'var(--plane)' }}
        >
          <span className="font-medium">{active.label}</span> ·{' '}
          <span className="figure">{formatNaira(active.kobo)}</span>
        </div>
      )}
    </div>
  );
}

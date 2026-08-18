// ============================================================
// Overview (§29, §30)
// ------------------------------------------------------------
// EXACTLY ONE HERO FIGURE — today's collection. A dashboard with four 48px
// numbers has no headline, and a reader's eye has nowhere to land.
//
// EVERY FIGURE IS DERIVED FROM THE LEDGER POSTINGS, never read from a stored
// counter. Four counters kept in step by hand are four counters that will
// eventually disagree with one another; a figure computed from the postings
// cannot drift from them.
//
// "ATTESTED, NOT YET BANKED" SITS BESIDE THE COLLECTED FIGURE ON PURPOSE. A
// screen showing only what was collected invites the reading that all of it has
// arrived somewhere, and that is precisely the impression §51 forbids.
// ============================================================

import Link from 'next/link';
import prisma from '@/lib/prisma';
import { formatNaira } from '@/lib/money';
import { Delta, StatusPill } from '@/components/Delta';
import { CollectionTrend, RankedBars, SettlementChain } from '@/components/Charts';

export const dynamic = 'force-dynamic';

function startOfDay(offsetDays = 0): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return d;
}

export default async function OverviewPage() {
  const today = startOfDay();
  const yesterday = startOfDay(-1);
  const fourteenDaysAgo = startOfDay(-13);

  const [
    entries,
    todayPayments,
    yesterdayPayments,
    outstanding,
    attested,
    exceptions,
    deposits,
    recentPayments,
    byAccount,
    accounts,
  ] = await Promise.all([
    prisma.ledgerEntry.groupBy({ by: ['eventType'], _sum: { amount: true } }),
    prisma.payment.aggregate({ where: { confirmedAt: { gte: today }, reversedAt: null }, _sum: { amount: true }, _count: true }),
    prisma.payment.aggregate({
      where: { confirmedAt: { gte: yesterday, lt: today }, reversedAt: null },
      _sum: { amount: true },
    }),
    prisma.invoice.findMany({
      where: { status: { in: ['ISSUED', 'PARTIALLY_PAID'] } },
      select: { total: true, amountPaid: true },
    }),
    prisma.payment.aggregate({
      where: { trustBasis: 'ATTESTED', reversedAt: null, bankReference: null },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.reconciliationException.count({ where: { status: { in: ['OPEN', 'INVESTIGATING'] } } }),
    prisma.deposit.findMany({ where: { closedAt: null }, select: { amount: true, amountApplied: true, amountRefunded: true } }),
    prisma.payment.findMany({
      where: { confirmedAt: { gte: fourteenDaysAgo }, reversedAt: null },
      select: { amount: true, confirmedAt: true },
    }),
    prisma.distribution.groupBy({
      by: ['accountId'],
      where: { status: { notIn: ['CANCELLED', 'REVERSED'] } },
      _sum: { amount: true },
    }),
    prisma.revenueAccount.findMany({ select: { id: true, name: true, beneficiaryType: true } }),
  ]);

  const sumOf = (t: string) => entries.find((e) => e.eventType === t)?._sum.amount ?? 0;

  const collectedAllTime = sumOf('PAYMENT_RECEIVED');
  const allocated = sumOf('REVENUE_ALLOCATED');
  const settled = sumOf('SETTLEMENT_CONFIRMED');

  const collectedToday = todayPayments._sum.amount ?? 0;
  const collectedYesterday = yesterdayPayments._sum.amount ?? 0;
  const outstandingTotal = outstanding.reduce((s, i) => s + Math.max(0, i.total - i.amountPaid), 0);
  const heldForPatients = deposits.reduce((s, d) => s + (d.amount - d.amountApplied - d.amountRefunded), 0);
  const attestedTotal = attested._sum.amount ?? 0;

  // --- Trend: one point per day, zero-filled ------------------------------
  // Zero-filled deliberately. Skipping days with no collection would compress
  // the axis and make a quiet week look like a busy one.
  const byDay = new Map<string, number>();
  for (let i = 0; i < 14; i++) {
    byDay.set(startOfDay(-13 + i).toISOString().slice(0, 10), 0);
  }
  for (const p of recentPayments) {
    if (!p.confirmedAt) continue;
    const key = p.confirmedAt.toISOString().slice(0, 10);
    if (byDay.has(key)) byDay.set(key, (byDay.get(key) ?? 0) + p.amount);
  }
  const trend = Array.from(byDay.entries()).map(([date, kobo]) => ({
    label: new Date(date).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' }),
    kobo,
  }));

  // --- Where allocated revenue went ---------------------------------------
  const accountName = new Map(accounts.map((a) => [a.id, a]));
  const ranked = byAccount
    .map((row) => ({
      label: accountName.get(row.accountId)?.name ?? 'Unknown account',
      kobo: row._sum.amount ?? 0,
      sub: accountName.get(row.accountId)?.beneficiaryType.toLowerCase().replace(/_/g, ' '),
    }))
    .filter((r) => r.kobo > 0)
    .sort((a, b) => b.kobo - a.kobo)
    .slice(0, 8);

  return (
    <div className="space-y-7">
      {/* --- The headline ------------------------------------------------- */}
      <section className="card p-6">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div>
            <p className="text-xs uppercase tracking-wider" style={{ color: 'var(--ink-muted)' }}>
              Collected today
            </p>
            <p className="hero-figure mt-1 text-5xl font-semibold" style={{ color: 'var(--brand)' }}>
              {formatNaira(collectedToday)}
            </p>
            <p className="mt-2 flex flex-wrap items-center gap-3 text-sm">
              <Delta kobo={collectedToday - collectedYesterday} label="vs yesterday" />
              <span style={{ color: 'var(--ink-muted)' }}>
                {todayPayments._count} payment{todayPayments._count === 1 ? '' : 's'}
              </span>
            </p>
          </div>

          <div className="text-right">
            <p className="text-xs uppercase tracking-wider" style={{ color: 'var(--ink-muted)' }}>
              Outstanding
            </p>
            <p className="figure mt-1 text-2xl font-semibold">{formatNaira(outstandingTotal)}</p>
            <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
              across {outstanding.length} unpaid bill{outstanding.length === 1 ? '' : 's'}
            </p>
          </div>
        </div>
      </section>

      {/* --- KPI row ------------------------------------------------------ */}
      <section>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Tile
            label="Held for patients"
            value={heldForPatients}
            note="unspent deposits — a liability, not revenue"
          />
          <Tile
            label="Attested, not yet banked"
            value={attestedTotal}
            note={`${attested._count} desk payment${attested._count === 1 ? '' : 's'} awaiting a bank match`}
            tone={attestedTotal > 0 ? 'warn' : undefined}
          />
          <Tile label="Allocated to beneficiaries" value={allocated} note="assigned, awaiting or already settled" />
          <div className="card p-4">
            <p className="text-xs uppercase tracking-wider" style={{ color: 'var(--ink-muted)' }}>
              Reconciliation
            </p>
            <p className="hero-figure mt-1 text-2xl font-semibold">{exceptions}</p>
            <p className="mt-1 text-xs" style={{ color: 'var(--ink-secondary)' }}>
              {exceptions === 0 ? 'nothing unexplained' : 'exceptions awaiting explanation'}
            </p>
            <div className="mt-2">
              {exceptions === 0 ? (
                <StatusPill tone="good">Clean</StatusPill>
              ) : (
                <StatusPill tone="warn">Needs review</StatusPill>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* --- Chain and departments --------------------------------------- */}
      <div className="grid gap-3 lg:grid-cols-2">
        <section className="card p-5">
          <h2 className="text-sm font-semibold">Where the money is</h2>
          <p className="mb-4 mt-0.5 text-xs" style={{ color: 'var(--ink-secondary)' }}>
            Collected, then allocated, then settled — the stages are ordered, so the shade carries the order.
          </p>
          <SettlementChain
            stages={[
              {
                label: 'Collected',
                kobo: collectedAllTime,
                meaning: 'Money the hospital has received and holds.',
              },
              {
                label: 'Allocated',
                kobo: allocated,
                meaning:
                  'Assigned to the accounts that earned it. Lower than collected by whatever is held as patient deposits — a deposit is not revenue until the service is consumed.',
              },
              {
                label: 'Settlement pending',
                kobo: Math.max(0, allocated - settled),
                meaning: 'Owed to a beneficiary and not yet paid out. Instructing a transfer moves nothing.',
              },
              {
                label: 'Settled',
                kobo: settled,
                meaning: 'Confirmed by a bank, with the reference that proves it. Only this has actually left.',
              },
            ]}
          />
        </section>

        <section className="card p-5">
          <h2 className="text-sm font-semibold">Allocated by account</h2>
          <p className="mb-4 mt-0.5 text-xs" style={{ color: 'var(--ink-secondary)' }}>
            Every naira here names the charge that produced it.
          </p>
          <RankedBars
            items={ranked}
            emptyNote="Nothing has been allocated yet. Allocation happens the moment a bill is settled."
          />
        </section>
      </div>

      {/* --- Trend -------------------------------------------------------- */}
      <section className="card p-5">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">Collections, last fourteen days</h2>
            <p className="mt-0.5 text-xs" style={{ color: 'var(--ink-secondary)' }}>
              Days with no collection are shown as zero rather than skipped.
            </p>
          </div>
          <Link href="/dashboard/desk" className="text-xs underline" style={{ color: 'var(--brand)' }}>
            Go to the revenue desk
          </Link>
        </div>
        <CollectionTrend points={trend} />
      </section>
    </div>
  );
}

function Tile({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: number;
  note: string;
  tone?: 'warn';
}) {
  return (
    <div
      className="card p-4"
      style={tone === 'warn' ? { background: 'var(--status-warn-bg)', borderColor: 'var(--status-warn)' } : undefined}
    >
      <p className="text-xs uppercase tracking-wider" style={{ color: 'var(--ink-muted)' }}>
        {label}
      </p>
      <p className="hero-figure mt-1 text-2xl font-semibold">{formatNaira(value)}</p>
      <p className="mt-1 text-xs" style={{ color: 'var(--ink-secondary)' }}>
        {note}
      </p>
    </div>
  );
}

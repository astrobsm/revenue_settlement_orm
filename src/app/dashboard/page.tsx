// ============================================================
// Overview (§29, §30)
// ------------------------------------------------------------
// The §30 chain, on one screen:
//
//   COLLECTED -> ALLOCATED -> SETTLEMENT PENDING -> SETTLED
//
// Every figure is DERIVED FROM THE LEDGER POSTINGS rather than read from a status
// column. Four counters that code must remember to keep in step are four
// counters that will eventually disagree with each other; a figure computed from
// the postings cannot drift from them.
//
// The unreconciled figure is shown next to the collected one deliberately. A
// dashboard that shows only what was collected invites the reading that all of
// it has arrived somewhere, and that is precisely the impression §51 forbids.
// ============================================================

import Link from 'next/link';
import prisma from '@/lib/prisma';
import { Money } from '@/components/Money';

export const dynamic = 'force-dynamic';

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export default async function OverviewPage() {
  const today = startOfToday();

  const [
    entries,
    invoicedToday,
    collectedToday,
    outstanding,
    attestedUnreconciled,
    openExceptions,
    depositsHeld,
  ] = await Promise.all([
    // The chain, from the postings.
    prisma.ledgerEntry.groupBy({ by: ['eventType'], _sum: { amount: true } }),
    prisma.invoice.aggregate({ where: { issuedAt: { gte: today } }, _sum: { total: true }, _count: true }),
    prisma.payment.aggregate({
      where: { confirmedAt: { gte: today }, reversedAt: null },
      _sum: { amount: true },
      _count: true,
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
  ]);

  const sumOf = (eventType: string) => entries.find((e) => e.eventType === eventType)?._sum.amount ?? 0;

  const collected = sumOf('PAYMENT_RECEIVED');
  const allocated = sumOf('REVENUE_ALLOCATED');
  const settled = sumOf('SETTLEMENT_CONFIRMED');
  const settlementPending = allocated - settled;

  const outstandingTotal = outstanding.reduce((s, i) => s + Math.max(0, i.total - i.amountPaid), 0);
  const heldForPatients = depositsHeld.reduce((s, d) => s + (d.amount - d.amountApplied - d.amountRefunded), 0);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Overview</h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Every figure below is derived from the ledger postings, not from a stored counter.
        </p>
      </header>

      {/* --- Today --------------------------------------------------------- */}
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Today</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <Tile label="Billed" kobo={invoicedToday._sum.total ?? 0} sub={`${invoicedToday._count} invoice(s) issued`} />
          <Tile label="Collected" kobo={collectedToday._sum.amount ?? 0} sub={`${collectedToday._count} payment(s)`} />
          <Tile label="Outstanding" kobo={outstandingTotal} sub={`${outstanding.length} unpaid invoice(s)`} />
        </div>
      </section>

      {/* --- The §30 chain -------------------------------------------------- */}
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Where the money is, all time
        </h2>
        <div className="grid gap-3 sm:grid-cols-4">
          <Tile label="Collected" kobo={collected} sub="received by the hospital" />
          <Tile label="Allocated" kobo={allocated} sub="assigned to beneficiaries" />
          <Tile label="Settlement pending" kobo={settlementPending} sub="owed, not yet paid out" />
          <Tile label="Settled" kobo={settled} sub="confirmed by a bank" />
        </div>
        <p className="mt-2 text-xs text-slate-500">
          Allocated is lower than collected by whatever is held as patient deposits — a deposit is not revenue until
          the service is consumed.
        </p>
      </section>

      {/* --- What needs attention ------------------------------------------ */}
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Needs attention</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <Tile
            label="Held for patients"
            kobo={heldForPatients}
            sub="unspent deposits — a liability, not revenue"
          />
          <Tile
            label="Attested, not yet banked"
            kobo={attestedUnreconciled._sum.amount ?? 0}
            sub={`${attestedUnreconciled._count} desk payment(s) awaiting a bank match`}
            warn={(attestedUnreconciled._sum.amount ?? 0) > 0}
          />
          <div
            className={`rounded border p-4 ${
              openExceptions > 0
                ? 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950'
                : 'border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900'
            }`}
          >
            <p className="text-xs uppercase tracking-wide text-slate-500">Reconciliation exceptions</p>
            <p className="figure mt-1 text-2xl font-semibold">{openExceptions}</p>
            <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
              {openExceptions === 0 ? 'nothing unexplained' : 'awaiting explanation'}
            </p>
            {openExceptions > 0 && (
              <Link href="/dashboard/reconciliation" className="mt-2 inline-block text-xs underline">
                Review them
              </Link>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function Tile({ label, kobo, sub, warn = false }: { label: string; kobo: number; sub: string; warn?: boolean }) {
  return (
    <div
      className={`rounded border p-4 ${
        warn
          ? 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950'
          : 'border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900'
      }`}
    >
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-2xl">
        <Money kobo={kobo} emphasis />
      </p>
      <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">{sub}</p>
    </div>
  );
}

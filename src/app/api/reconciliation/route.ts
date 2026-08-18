// ============================================================
// /api/reconciliation — the daily comparison (§31, §32)
// ------------------------------------------------------------
// GET   the runs and their open exceptions
// POST  run a reconciliation for a period
// PATCH resolve an exception
//
// The run compares invoices, payments, gateway records, bank credits, the
// distribution ledger and the double-entry ledger against one another and
// records what disagrees.
//
// IT CORRECTS NOTHING. Not one figure is adjusted here. An exception is a
// question for a person, and software that silently reconciles a difference
// destroys the evidence of whatever caused it. The only write is the finding
// itself.
//
// AN EXCEPTION IS NEVER DELETED EITHER. Resolving one records who resolved it
// and how; it does not remove the row. "This difference was investigated and
// explained" and "this difference never existed" must not look the same.
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { guard, readJson } from '@/lib/apiGuard';
import { Permission } from '@/lib/rbac';
import { recordAudit } from '@/lib/audit';
import { reconcile, summarise } from '@/lib/reconciliation';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------
export async function GET(request: NextRequest) {
  const g = await guard(request, { permission: Permission.RECONCILIATION_VIEW });
  if (!g.ok) return g.response;

  const sp = request.nextUrl.searchParams;
  const openOnly = sp.get('open') !== 'false';

  const [runs, openExceptions] = await Promise.all([
    prisma.reconciliationRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: 30,
      select: {
        id: true, periodStart: true, periodEnd: true, status: true,
        totalInvoiced: true, totalCollected: true, totalAllocated: true,
        totalSettled: true, totalBankCredits: true, exceptionsFound: true,
        startedAt: true, finishedAt: true, isScheduled: true,
      },
    }),
    prisma.reconciliationException.findMany({
      where: openOnly ? { status: { in: ['OPEN', 'INVESTIGATING'] } } : {},
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: {
        id: true, runId: true, type: true, status: true, detail: true,
        expectedAmount: true, actualAmount: true, difference: true,
        invoiceId: true, paymentId: true, settlementId: true,
        providerReference: true, createdAt: true,
      },
    }),
  ]);

  return NextResponse.json({
    runs,
    exceptions: openExceptions,
    // The number a finance officer actually wants on a dashboard tile: how many
    // unexplained differences are outstanding right now.
    openExceptionCount: openExceptions.length,
  });
}

// ---------------------------------------------------------------------------
// POST — run it
// ---------------------------------------------------------------------------
interface RunBody {
  periodStart?: string;
  periodEnd?: string;
  /** Imported bank statement credits for the period, if any are available. */
  bankCredits?: { reference: string; amount: number; valueDate: string }[];
  attestedGraceHours?: number;
}

export async function POST(request: NextRequest) {
  const parsed = await readJson<RunBody>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const g = await guard(request, { permission: Permission.RECONCILIATION_RUN });
  if (!g.ok) return g.response;
  const { actor, audit } = g;

  // Default to yesterday: the natural daily run, after the previous day's
  // banking has settled.
  const periodEnd = body.periodEnd ? new Date(body.periodEnd) : startOfToday();
  const periodStart = body.periodStart ? new Date(body.periodStart) : addDays(periodEnd, -1);

  if (periodStart >= periodEnd) {
    return NextResponse.json({ error: 'The period start must be before its end.', code: 'BAD_PERIOD' }, { status: 400 });
  }

  const run = await prisma.reconciliationRun.create({
    data: { periodStart, periodEnd, status: 'RUNNING', runById: actor.userId, isScheduled: false },
  });

  try {
    const window = { gte: periodStart, lt: periodEnd };

    const [invoices, payments, distributions, settlementRows, postings, providerTxns] = await Promise.all([
      prisma.invoice.findMany({
        where: { createdAt: window },
        select: { id: true, invoiceNumber: true, status: true, total: true, amountPaid: true },
      }),
      prisma.payment.findMany({
        where: { createdAt: window },
        select: {
          id: true, paymentNumber: true, invoiceId: true, amount: true, currency: true,
          status: true, trustBasis: true, providerTransactionId: true, bankReference: true,
          confirmedAt: true, reversedAt: true,
        },
      }),
      prisma.distribution.findMany({
        where: { createdAt: window },
        select: { id: true, invoiceId: true, paymentId: true, amount: true, status: true },
      }),
      prisma.settlement.findMany({
        where: { createdAt: window },
        include: { items: { select: { amount: true } } },
      }),
      // The trial balance is computed over ALL postings, not just this period:
      // a ledger that balances within one day but not overall is still broken,
      // and slicing the check by date would hide exactly that.
      prisma.ledgerPosting.groupBy({ by: ['side'], _sum: { amount: true } }),
      prisma.paymentTransaction.findMany({
        where: { occurredAt: window, operation: 'VERIFY', signatureValid: true },
        select: { providerReference: true, providerAmount: true, providerStatus: true },
      }),
    ]);

    const debits = postings.find((p) => p.side === 'DEBIT')?._sum.amount ?? 0;
    const credits = postings.find((p) => p.side === 'CREDIT')?._sum.amount ?? 0;

    const result = reconcile({
      periodStart,
      periodEnd,
      invoices,
      payments,
      gateway: providerTxns
        .filter((t) => t.providerReference)
        .map((t) => ({
          providerReference: t.providerReference as string,
          providerTransactionId: null,
          amount: t.providerAmount ?? 0,
          currency: 'NGN',
          status: t.providerStatus ?? 'unknown',
        })),
      bankCredits: (body.bankCredits ?? []).map((b) => ({
        reference: b.reference,
        amount: b.amount,
        valueDate: new Date(b.valueDate),
      })),
      distributions,
      settlements: settlementRows.map((s) => ({
        id: s.id,
        settlementNumber: s.settlementNumber,
        accountId: s.accountId,
        amount: s.amount,
        status: s.status,
        bankReference: s.bankReference,
        claimedDistributionTotal: s.items.reduce((sum, i) => sum + i.amount, 0),
      })),
      ledger: { debits, credits },
      attestedGraceHours: body.attestedGraceHours,
    });

    await prisma.$transaction(async (tx) => {
      if (result.exceptions.length > 0) {
        await tx.reconciliationException.createMany({
          data: result.exceptions.map((e) => ({
            runId: run.id,
            type: e.type as never,
            status: 'OPEN' as never,
            detail: e.detail,
            expectedAmount: e.expectedAmount ?? null,
            actualAmount: e.actualAmount ?? null,
            difference: e.difference ?? null,
            invoiceId: e.invoiceId ?? null,
            paymentId: e.paymentId ?? null,
            settlementId: e.settlementId ?? null,
            providerReference: e.providerReference ?? null,
          })),
        });
      }

      await tx.reconciliationRun.update({
        where: { id: run.id },
        data: {
          status: 'COMPLETED',
          finishedAt: new Date(),
          totalInvoiced: result.totals.invoiced,
          totalCollected: result.totals.collected,
          totalAllocated: result.totals.allocated,
          totalSettled: result.totals.settled,
          totalBankCredits: body.bankCredits ? result.totals.bankCredits : null,
          exceptionsFound: result.exceptions.length,
        },
      });

      await recordAudit(tx, audit, {
        action: 'reconciliation.run',
        entity: 'reconciliation-run',
        entityId: run.id,
        newValue: {
          period: { from: periodStart, to: periodEnd },
          totals: result.totals,
          exceptions: result.exceptions.length,
          critical: result.counts.critical,
        },
      });
    });

    return NextResponse.json({
      success: true,
      runId: run.id,
      summary: summarise(result),
      totals: result.totals,
      counts: result.counts,
      exceptions: result.exceptions,
      // Stated rather than implied: a clean run means these records agree with
      // each other, not that no bank statement was needed.
      note: body.bankCredits
        ? undefined
        : 'No bank statement was supplied, so nothing was checked against the bank. Import one to catch money that never arrived.',
    });
  } catch (err) {
    await prisma.reconciliationRun
      .update({ where: { id: run.id }, data: { status: 'FAILED', finishedAt: new Date() } })
      .catch(() => undefined);

    console.error('[reconciliation] run failed:', err);
    return NextResponse.json({ error: 'The reconciliation run failed.', code: 'RUN_FAILED', runId: run.id }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// PATCH — resolve an exception
// ---------------------------------------------------------------------------
export async function PATCH(request: NextRequest) {
  const parsed = await readJson<{ id?: string; status?: string; resolution?: string }>(request);
  if (!parsed.ok) return parsed.response;
  const { id, status, resolution } = parsed.body;

  if (!id || !status) {
    return NextResponse.json({ error: 'An exception and a status are required.', code: 'INCOMPLETE' }, { status: 400 });
  }
  if (!['INVESTIGATING', 'RESOLVED', 'WRITTEN_OFF'].includes(status)) {
    return NextResponse.json({ error: `${status} is not a valid exception status.`, code: 'BAD_STATUS' }, { status: 400 });
  }

  // Closing a difference REQUIRES an explanation. An exception marked resolved
  // with no account of what it was is indistinguishable from one dismissed to
  // clear a screen — and a written-off difference is money, so it needs more
  // than a click.
  if ((status === 'RESOLVED' || status === 'WRITTEN_OFF') && (resolution?.trim().length ?? 0) < 10) {
    return NextResponse.json(
      {
        error: 'Closing a reconciliation exception needs an explanation of what the difference turned out to be.',
        code: 'RESOLUTION_REQUIRED',
      },
      { status: 400 }
    );
  }

  const g = await guard(request, {
    permission: Permission.RECONCILIATION_RESOLVE,
    entity: 'reconciliation-exception',
    entityId: id,
  });
  if (!g.ok) return g.response;

  const existing = await prisma.reconciliationException.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: 'Exception not found.', code: 'NOT_FOUND' }, { status: 404 });

  await prisma.$transaction(async (tx) => {
    await tx.reconciliationException.update({
      where: { id },
      data: {
        status: status as never,
        resolution: resolution?.trim() ?? null,
        ...(status === 'RESOLVED' || status === 'WRITTEN_OFF'
          ? { resolvedById: g.actor.userId, resolvedAt: new Date() }
          : {}),
      },
    });

    await recordAudit(tx, g.audit, {
      action: 'reconciliation.resolve',
      entity: 'reconciliation-exception',
      entityId: id,
      invoiceId: existing.invoiceId,
      paymentId: existing.paymentId,
      previousValue: { status: existing.status },
      newValue: { status, resolution: resolution?.trim() },
      reason: resolution?.trim() ?? null,
    });
  });

  return NextResponse.json({ success: true, status });
}

// ---------------------------------------------------------------------------

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

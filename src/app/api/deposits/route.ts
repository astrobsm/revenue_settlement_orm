// ============================================================
// /api/deposits — money the hospital holds, not money it has earned (§21)
// ------------------------------------------------------------
// GET    deposits and their balances
// POST   apply a deposit against charges on a bill
// PATCH  close a deposit at discharge, returning anything unused
//
// This is the route where a LIABILITY becomes REVENUE, and it is the only one
// that may do so. Everywhere else, deposit money is the patient's.
//
// Booking a deposit as income on receipt overstates revenue by whatever is still
// unspent and understates liabilities by the same amount. At a hospital taking
// deposits on every admission that is not a rounding difference — it is a
// materially wrong set of accounts, which is why §21 calls the distinction
// critical.
//
// THE BALANCE IS ALWAYS THE PATIENT'S. It cannot be drawn beyond what remains,
// cannot be applied to another patient's bill, and whatever is left at discharge
// goes back rather than quietly ageing into the hospital's income.
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { guard, readJson } from '@/lib/apiGuard';
import { Permission } from '@/lib/rbac';
import { recordAudit } from '@/lib/audit';
import {
  canApplyDeposit,
  depositBalance,
  depositEarned,
  planDepositApplication,
  settlementAtDischarge,
} from '@/lib/deposits';
import { entryDepositApplied } from '@/lib/ledger';
import { formatNaira } from '@/lib/money';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------
export async function GET(request: NextRequest) {
  const g = await guard(request, { permission: Permission.DEPOSIT_VIEW });
  if (!g.ok) return g.response;

  const sp = request.nextUrl.searchParams;

  const deposits = await prisma.deposit.findMany({
    where: {
      ...(sp.get('patientId') ? { patientId: sp.get('patientId') as string } : {}),
      ...(sp.get('encounterId') ? { encounterId: sp.get('encounterId') as string } : {}),
      ...(sp.get('open') === 'true' ? { closedAt: null } : {}),
    },
    orderBy: { receivedAt: 'desc' },
    take: 200,
    include: {
      patient: { select: { id: true, fullName: true, hospitalNumber: true } },
      applications: {
        select: { id: true, amount: true, kind: true, appliedAt: true, invoiceId: true },
        orderBy: { appliedAt: 'asc' },
      },
    },
  });

  const rows = deposits.map((d) => ({
    id: d.id,
    depositNumber: d.depositNumber,
    patient: d.patient,
    encounterId: d.encounterId,
    amount: d.amount,
    amountApplied: d.amountApplied,
    amountRefunded: d.amountRefunded,
    // Named without ambiguity, because these two figures are the whole point.
    balanceStillPatients: depositBalance(d),
    earnedByHospital: depositEarned(d),
    closedAt: d.closedAt,
    applications: d.applications,
  }));

  return NextResponse.json({
    deposits: rows,
    totals: {
      // What the hospital owes patients right now. This is a LIABILITY figure and
      // should never appear in a revenue report.
      heldOnBehalfOfPatients: rows.filter((r) => !r.closedAt).reduce((s, r) => s + r.balanceStillPatients, 0),
      earnedToDate: rows.reduce((s, r) => s + r.earnedByHospital, 0),
    },
  });
}

// ---------------------------------------------------------------------------
// POST — draw a deposit down against charges
// ---------------------------------------------------------------------------
interface ApplyBody {
  depositId?: string;
  invoiceId?: string;
  /** Specific lines to settle. Omit to apply against every unpaid line in order. */
  lineIds?: string[];
  /** Cap the draw-down. Omit to apply as much as the charges need. */
  maxAmount?: number;
}

export async function POST(request: NextRequest) {
  const parsed = await readJson<ApplyBody>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  if (!body.depositId || !body.invoiceId) {
    return NextResponse.json({ error: 'A deposit and an invoice are required.', code: 'INCOMPLETE' }, { status: 400 });
  }

  const g = await guard(request, { permission: Permission.DEPOSIT_APPLY });
  if (!g.ok) return g.response;
  const { actor, audit } = g;

  const [deposit, invoice] = await Promise.all([
    prisma.deposit.findUnique({ where: { id: body.depositId } }),
    prisma.invoice.findUnique({
      where: { id: body.invoiceId },
      include: {
        lines: {
          // A deposit pays for services consumed. It does not pay for itself:
          // applying a deposit to a deposit line would double-count the money.
          where: { isDeposit: false, ...(body.lineIds?.length ? { id: { in: body.lineIds } } : {}) },
          orderBy: { createdAt: 'asc' },
          select: { id: true, kind: true, lineTotal: true, description: true },
        },
      },
    }),
  ]);

  if (!deposit) return NextResponse.json({ error: 'Deposit not found.', code: 'NOT_FOUND' }, { status: 404 });
  if (!invoice) return NextResponse.json({ error: 'Invoice not found.', code: 'NOT_FOUND' }, { status: 404 });

  if (invoice.lines.length === 0) {
    return NextResponse.json(
      { error: 'There are no service charges on this invoice for the deposit to pay for.', code: 'NO_CHARGES' },
      { status: 409 }
    );
  }

  // A deposit belongs to one patient and one episode of care. This check is the
  // reason the encounter is carried on the deposit at all.
  const eligibility = canApplyDeposit({
    deposit,
    amount: 1, // probing eligibility; the real amount is decided by the plan
    depositEncounterId: deposit.encounterId ?? '',
    invoiceEncounterId: invoice.encounterId,
  });
  if (!eligibility.allowed) {
    return NextResponse.json({ error: eligibility.message, code: eligibility.code }, { status: 409 });
  }

  // Charges already settled by earlier draw-downs must not be paid twice.
  const priorByLine = await prisma.depositApplication.groupBy({
    by: ['depositId'],
    where: { invoiceId: invoice.id },
    _sum: { amount: true },
  });
  const alreadyApplied = priorByLine.reduce((s, r) => s + (r._sum.amount ?? 0), 0);

  const outstandingCharges = invoice.lines.map((l) => ({
    lineId: l.id,
    chargeKind: l.kind as string,
    amount: l.lineTotal,
  }));
  const chargeTotal = outstandingCharges.reduce((s, c) => s + c.amount, 0);
  const stillOwed = Math.max(0, chargeTotal - alreadyApplied);

  if (stillOwed === 0) {
    return NextResponse.json(
      { error: 'These charges have already been settled from this deposit.', code: 'ALREADY_APPLIED' },
      { status: 409 }
    );
  }

  const cap = body.maxAmount != null ? Math.min(body.maxAmount, stillOwed) : stillOwed;
  const plan = planDepositApplication({
    deposit,
    charges: capCharges(outstandingCharges, cap),
  });

  if (plan.totalApplied === 0) {
    return NextResponse.json(
      { error: 'This deposit has no balance left to apply.', code: 'DEPOSIT_EXHAUSTED', balance: depositBalance(deposit) },
      { status: 409 }
    );
  }

  const result = await prisma.$transaction(async (tx) => {
    for (const application of plan.applications) {
      await tx.depositApplication.create({
        data: {
          depositId: deposit.id,
          invoiceId: invoice.id,
          amount: application.amount,
          kind: application.chargeKind as never,
          appliedById: actor.userId,
        },
      });

      // Liability becomes revenue, here and only here (§21).
      const entry = entryDepositApplied({
        depositId: deposit.id,
        invoiceId: invoice.id,
        amount: application.amount,
        chargeKind: application.chargeKind,
        createdByUserId: actor.userId,
      });

      await tx.ledgerEntry.create({
        data: {
          eventType: entry.eventType as never,
          amount: entry.amount,
          depositId: deposit.id,
          invoiceId: invoice.id,
          memo: `Deposit applied to ${application.chargeKind}`,
          occurredAt: entry.occurredAt,
          createdByUserId: actor.userId,
          postings: {
            create: entry.postings.map((p) => ({
              account: p.account as never,
              side: p.side,
              amount: p.amount,
              chargeKind: (p.chargeKind ?? null) as never,
              memo: p.memo ?? null,
            })),
          },
        },
      });
    }

    const updated = await tx.deposit.update({
      where: { id: deposit.id },
      data: { amountApplied: { increment: plan.totalApplied } },
    });

    await recordAudit(tx, audit, {
      action: 'deposit.apply',
      entity: 'deposit',
      entityId: deposit.id,
      invoiceId: invoice.id,
      patientId: deposit.patientId,
      previousValue: { amountApplied: deposit.amountApplied, balance: depositBalance(deposit) },
      newValue: {
        amountApplied: updated.amountApplied,
        balance: depositBalance(updated),
        applications: plan.applications,
      },
    });

    return updated;
  });

  return NextResponse.json({
    success: true,
    applied: plan.totalApplied,
    appliedFormatted: formatNaira(plan.totalApplied),
    // Each draw-down names the service that consumed it. "₦120,000 of the
    // deposit was used" is not something a patient can check.
    applications: plan.applications,
    deposit: {
      id: result.id,
      depositNumber: result.depositNumber,
      balanceStillPatients: depositBalance(result),
      earnedByHospital: depositEarned(result),
    },
    shortfall: plan.shortfall,
    summary: plan.summary,
  });
}

// ---------------------------------------------------------------------------
// PATCH — close a deposit at discharge
// ---------------------------------------------------------------------------
export async function PATCH(request: NextRequest) {
  const parsed = await readJson<{ id?: string; confirmRefunded?: boolean; reason?: string }>(request);
  if (!parsed.ok) return parsed.response;
  const { id, confirmRefunded, reason } = parsed.body;

  if (!id) return NextResponse.json({ error: 'Which deposit?', code: 'DEPOSIT_REQUIRED' }, { status: 400 });

  const g = await guard(request, { permission: Permission.DEPOSIT_APPLY });
  if (!g.ok) return g.response;

  const deposit = await prisma.deposit.findUnique({ where: { id } });
  if (!deposit) return NextResponse.json({ error: 'Deposit not found.', code: 'NOT_FOUND' }, { status: 404 });

  const discharge = settlementAtDischarge(deposit);

  if (discharge.action === 'ALREADY_CLOSED') {
    return NextResponse.json({ success: true, alreadyClosed: true, message: discharge.message });
  }

  // A deposit with an unused balance CANNOT simply be closed. That balance is
  // the patient's money, and closing over it is how an unused deposit quietly
  // becomes hospital income. Returning it is a refund, with its own approval.
  if (discharge.action === 'REFUND_BALANCE' && !confirmRefunded) {
    return NextResponse.json(
      {
        error: discharge.message,
        code: 'BALANCE_MUST_BE_RETURNED',
        balance: discharge.amount,
        balanceFormatted: formatNaira(discharge.amount),
        nextStep: 'Raise a refund for the unused balance, then close this deposit once the money has gone back.',
      },
      { status: 409 }
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.deposit.update({ where: { id }, data: { closedAt: new Date() } });
    await recordAudit(tx, g.audit, {
      action: 'deposit.close',
      entity: 'deposit',
      entityId: id,
      patientId: deposit.patientId,
      previousValue: { balance: depositBalance(deposit), closedAt: null },
      newValue: { closedAt: new Date(), returnedToPatient: discharge.amount },
      reason: reason?.trim() ?? discharge.message,
    });
  });

  return NextResponse.json({ success: true, closed: true, message: discharge.message });
}

// ---------------------------------------------------------------------------

/** Trim a charge list so it totals no more than `cap`, in order. */
function capCharges(
  charges: { lineId: string; chargeKind: string; amount: number }[],
  cap: number
): { lineId: string; chargeKind: string; amount: number }[] {
  const out: typeof charges = [];
  let remaining = cap;
  for (const c of charges) {
    if (remaining <= 0) break;
    const amount = Math.min(c.amount, remaining);
    out.push({ ...c, amount });
    remaining -= amount;
  }
  return out;
}

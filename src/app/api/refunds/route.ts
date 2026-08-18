// ============================================================
// /api/refunds — money going back out (§19, §25, §44)
// ------------------------------------------------------------
// GET   refunds and what each would require
// POST  request one
// PATCH review, approve, reject, mark processing, mark paid
//
// A refund never edits the original payment. It is its own transaction running
// in the opposite direction, and the payment it relates to stands untouched for
// ever — otherwise the day's takings, the cashier's till and the bank statement
// would disagree with the system and nobody could say why.
//
// THE SEPARATION THAT MATTERS: whoever REQUESTS a refund may not APPROVE it.
// That is §25's clearest case, and it is enforced against the audit trail rather
// than by hoping the roles differ. The guard reads what this user already did to
// this refund and refuses.
//
// AND THE HONESTY THAT MATTERS: approving a refund does NOT pull money back from
// a pharmacy or a vendor that has already been settled. The response says so, in
// those words, every time it is true.
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { guard, readJson } from '@/lib/apiGuard';
import { Permission } from '@/lib/rbac';
import { Duty, recordAudit } from '@/lib/audit';
import { nextNumber, Series } from '@/lib/numbering';
import {
  canRequestRefund,
  canTransitionRefund,
  checkRefundApproval,
  planRecovery,
  RefundStatus,
  refundIsFull,
} from '@/lib/refunds';
import { entryRefundApproved, entryRefundPaid } from '@/lib/ledger';
import { formatNaira } from '@/lib/money';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------
export async function GET(request: NextRequest) {
  const g = await guard(request, { permission: Permission.PAYMENT_VIEW });
  if (!g.ok) return g.response;

  const status = request.nextUrl.searchParams.get('status');

  const refunds = await prisma.refund.findMany({
    where: status ? { status: status as never } : {},
    orderBy: { requestedAt: 'desc' },
    take: 200,
    select: {
      id: true, refundNumber: true, invoiceId: true, paymentId: true,
      amount: true, reason: true, status: true, requiresRecovery: true,
      requestedById: true, requestedAt: true, approvedById: true, approvedAt: true,
      paidAt: true, bankReference: true,
      invoice: { select: { invoiceNumber: true, patientName: true } },
    },
  });

  return NextResponse.json({
    refunds,
    // The two figures a finance officer wants at a glance.
    awaitingApproval: refunds.filter((r) => r.status === 'REQUESTED' || r.status === 'UNDER_REVIEW').length,
    awaitingRecovery: refunds.filter((r) => r.requiresRecovery && r.status !== 'REJECTED').length,
  });
}

// ---------------------------------------------------------------------------
// POST — request a refund
// ---------------------------------------------------------------------------
interface RequestBody {
  paymentId?: string;
  amount?: number;
  reason?: string;
}

export async function POST(request: NextRequest) {
  const parsed = await readJson<RequestBody>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  if (!body.paymentId) {
    return NextResponse.json({ error: 'Which payment is being refunded?', code: 'PAYMENT_REQUIRED' }, { status: 400 });
  }

  const payment = await prisma.payment.findUnique({
    where: { id: body.paymentId },
    select: {
      id: true, paymentNumber: true, invoiceId: true, amount: true, status: true, reversedAt: true,
      invoice: { select: { id: true, invoiceNumber: true, patientId: true } },
    },
  });
  if (!payment) return NextResponse.json({ error: 'Payment not found.', code: 'NOT_FOUND' }, { status: 404 });

  const g = await guard(request, {
    permission: Permission.REFUND_REQUEST,
    duty: Duty.REFUND_REQUESTED,
    entity: 'payment',
    entityId: payment.id,
    invoiceId: payment.invoiceId,
  });
  if (!g.ok) return g.response;
  const { actor, audit, sodOverridden } = g;

  // Everything not rejected counts against the ceiling — including refunds still
  // awaiting approval. Two people handling one complaint must not each be told
  // the full amount is available.
  const priorRefunds = await prisma.refund.aggregate({
    where: { paymentId: payment.id, status: { not: 'REJECTED' } },
    _sum: { amount: true },
  });
  const alreadyRefunded = priorRefunds._sum.amount ?? 0;

  const check = canRequestRefund({
    paymentAmount: payment.amount,
    paymentStatus: payment.status,
    paymentReversed: Boolean(payment.reversedAt),
    alreadyRefunded,
    amount: body.amount ?? 0,
    reason: body.reason ?? '',
  });
  if (!check.allowed) {
    return NextResponse.json({ error: check.message, code: check.code }, { status: 409 });
  }

  const amount = body.amount as number;

  // What would have to come back, and from where — computed at REQUEST time so
  // the approver can see it before deciding, not afterwards.
  const distributions = await prisma.distribution.findMany({
    where: { paymentId: payment.id },
    select: { id: true, accountId: true, amount: true, status: true, kind: true },
  });
  const plan = planRecovery({
    refundAmount: amount,
    distributions: distributions.map((d) => ({
      id: d.id, accountId: d.accountId, amount: d.amount, status: d.status, chargeKind: d.kind,
    })),
  });

  const created = await prisma.$transaction(async (tx) => {
    const refundNumber = await nextNumber(tx, Series.REFUND);

    const refund = await tx.refund.create({
      data: {
        refundNumber,
        invoiceId: payment.invoice.id,
        paymentId: payment.id,
        amount,
        reason: (body.reason as string).trim(),
        status: 'REQUESTED',
        requestedById: actor.userId,
        requiresRecovery: plan.requiresRecovery,
      },
    });

    await recordAudit(tx, audit, {
      duty: Duty.REFUND_REQUESTED,
      action: 'refund.request',
      entity: 'refund',
      entityId: refund.id,
      invoiceId: payment.invoice.id,
      paymentId: payment.id,
      patientId: payment.invoice.patientId,
      newValue: {
        refundNumber, amount,
        requiresRecovery: plan.requiresRecovery,
        recoverable: plan.recoverable,
      },
      reason: (body.reason as string).trim(),
      sodOverridden,
    });

    return refund;
  });

  return NextResponse.json(
    {
      success: true,
      refund: { id: created.id, refundNumber: created.refundNumber, amount, status: created.status },
      recovery: {
        summary: plan.summary,
        cancellable: plan.cancellable,
        recoverable: plan.recoverable,
        requiresRecovery: plan.requiresRecovery,
        lines: plan.lines,
      },
      // §25, stated up front rather than discovered on refusal.
      note: `This refund must be approved by somebody other than ${actor.fullName}.`,
    },
    { status: 201 }
  );
}

// ---------------------------------------------------------------------------
// PATCH — move a refund along
// ---------------------------------------------------------------------------
interface PatchBody {
  id?: string;
  action?: 'REVIEW' | 'APPROVE' | 'REJECT' | 'PROCESS' | 'MARK_PAID' | 'MARK_FAILED';
  reason?: string;
  /** Required for MARK_PAID — proof the money actually went back (§51). */
  bankReference?: string;
  providerRefundId?: string;
}

const ACTION_TO_STATUS: Record<string, RefundStatus> = {
  REVIEW: 'UNDER_REVIEW',
  APPROVE: 'APPROVED',
  REJECT: 'REJECTED',
  PROCESS: 'PROCESSING',
  MARK_PAID: 'REFUNDED',
  MARK_FAILED: 'FAILED',
};

export async function PATCH(request: NextRequest) {
  const parsed = await readJson<PatchBody>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  if (!body.id || !body.action) {
    return NextResponse.json({ error: 'A refund and an action are required.', code: 'INCOMPLETE' }, { status: 400 });
  }
  const target = ACTION_TO_STATUS[body.action];
  if (!target) {
    return NextResponse.json({ error: `Unknown action ${body.action}.`, code: 'BAD_ACTION' }, { status: 400 });
  }

  const refund = await prisma.refund.findUnique({
    where: { id: body.id },
    include: { invoice: { select: { id: true, patientId: true } }, payment: { select: { id: true, amount: true } } },
  });
  if (!refund) return NextResponse.json({ error: 'Refund not found.', code: 'NOT_FOUND' }, { status: 404 });

  // Approving is the controlled act. The guard reads this refund's own history,
  // so the person who requested it cannot approve it however senior they are.
  const isApproval = body.action === 'APPROVE';
  const g = await guard(request, {
    permission: isApproval ? Permission.REFUND_APPROVE : Permission.REFUND_REQUEST,
    duty: isApproval ? Duty.REFUND_APPROVED : undefined,
    entity: isApproval ? 'refund' : undefined,
    entityId: isApproval ? refund.id : undefined,
    invoiceId: refund.invoiceId,
  });
  if (!g.ok) return g.response;
  const { actor, audit, sodOverridden } = g;

  const move = canTransitionRefund(refund.status as RefundStatus, target);
  if (!move.allowed) {
    return NextResponse.json({ error: move.message, code: move.code }, { status: 409 });
  }

  // Paying a refund needs proof, exactly as a settlement does (§51).
  if (target === 'REFUNDED' && !body.bankReference?.trim()) {
    return NextResponse.json(
      {
        error:
          'A refund cannot be marked paid without the reference that proves the money left. "Refunded, no reference" looks settled and cannot be checked.',
        code: 'REFERENCE_REQUIRED',
      },
      { status: 400 }
    );
  }
  if ((target === 'REJECTED' || target === 'FAILED') && (body.reason?.trim().length ?? 0) < 10) {
    return NextResponse.json({ error: 'Give a reason.', code: 'REASON_REQUIRED' }, { status: 400 });
  }

  const distributions = await prisma.distribution.findMany({
    where: { paymentId: refund.paymentId },
    select: { id: true, accountId: true, amount: true, status: true, kind: true },
  });
  const plan = planRecovery({
    refundAmount: refund.amount,
    distributions: distributions.map((d) => ({
      id: d.id, accountId: d.accountId, amount: d.amount, status: d.status, chargeKind: d.kind,
    })),
  });

  if (isApproval) {
    const approval = checkRefundApproval({
      status: refund.status as RefundStatus,
      amount: refund.amount,
      seniorApprovalThreshold: await seniorThreshold(),
      requiresRecovery: plan.requiresRecovery,
    });
    if (!approval.allowed) {
      return NextResponse.json({ error: approval.message, code: approval.code }, { status: 409 });
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.refund.update({
      where: { id: refund.id },
      data: {
        status: target as never,
        requiresRecovery: plan.requiresRecovery,
        ...(target === 'UNDER_REVIEW' ? { reviewedById: actor.userId } : {}),
        ...(target === 'APPROVED' ? { approvedById: actor.userId, approvedAt: new Date() } : {}),
        ...(target === 'REJECTED' ? { rejectedById: actor.userId, rejectionReason: body.reason?.trim() ?? null } : {}),
        ...(target === 'REFUNDED'
          ? { paidAt: new Date(), bankReference: body.bankReference?.trim(), providerRefundId: body.providerRefundId ?? null }
          : {}),
        ...(target === 'FAILED' ? { failedAt: new Date(), failureReason: body.reason?.trim() ?? null } : {}),
      },
    });

    // --- On approval: unwind what can be unwound ---------------------------
    if (target === 'APPROVED') {
      // PENDING money is simply cancelled — it never left, so nothing is
      // recovered and nothing is pretended.
      const cancellable = plan.lines.filter((l) => l.method === 'CANCEL_PENDING').flatMap((l) => l.distributionIds);
      if (cancellable.length > 0) {
        await tx.distribution.updateMany({
          where: { id: { in: cancellable } },
          data: { status: 'REVERSED', reversedAt: new Date(), reversalReason: `Refund ${refund.refundNumber}` },
        });
      }

      // SETTLED money is NOT touched. It has genuinely gone, and marking it
      // reversed here would say the hospital has it back when it does not.
      // The refund carries requiresRecovery and the plan names who owes what.

      const entry = entryRefundApproved({
        refundId: refund.id,
        invoiceId: refund.invoiceId,
        amount: refund.amount,
        createdByUserId: actor.userId,
      });
      await writeEntry(tx, entry, { refundId: refund.id, invoiceId: refund.invoiceId });
    }

    // --- On payment: the money actually leaves the bank --------------------
    if (target === 'REFUNDED') {
      const entry = entryRefundPaid({
        refundId: refund.id,
        amount: refund.amount,
        bankReference: body.bankReference as string,
        createdByUserId: actor.userId,
      });
      await writeEntry(tx, entry, { refundId: refund.id });

      // The payment's own status follows: fully refunded, or partly.
      const priorPaid = await tx.refund.aggregate({
        where: { paymentId: refund.paymentId, status: 'REFUNDED' },
        _sum: { amount: true },
      });
      const full = refundIsFull({
        paymentAmount: refund.payment.amount,
        alreadyRefunded: (priorPaid._sum.amount ?? 0) - refund.amount,
        amount: refund.amount,
      });
      await tx.payment.update({
        where: { id: refund.paymentId },
        data: { status: (full ? 'REFUNDED' : 'PARTIALLY_REFUNDED') as never },
      });
    }

    await recordAudit(tx, audit, {
      duty: isApproval ? Duty.REFUND_APPROVED : undefined,
      action: `refund.${body.action!.toLowerCase()}`,
      entity: 'refund',
      entityId: refund.id,
      invoiceId: refund.invoiceId,
      paymentId: refund.paymentId,
      patientId: refund.invoice.patientId,
      previousValue: { status: refund.status },
      newValue: { status: target, bankReference: body.bankReference ?? null, requiresRecovery: plan.requiresRecovery },
      reason: body.reason?.trim() ?? null,
      sodOverridden,
    });
  });

  return NextResponse.json({
    success: true,
    status: target,
    recovery: target === 'APPROVED' ? plan : undefined,
    // The honest sentence, every time it applies.
    note:
      target === 'APPROVED' && plan.requiresRecovery
        ? `${formatNaira(plan.recoverable)} of this refund has ALREADY been settled to other accounts. Approving it has not taken that money back — it must be recovered from them, and this refund stays flagged until it is.`
        : undefined,
  });
}

// ---------------------------------------------------------------------------

async function seniorThreshold(): Promise<number> {
  const setting = await prisma.organisationSetting.findUnique({ where: { key: 'REFUND_SENIOR_APPROVAL_THRESHOLD' } });
  // A conservative default: without an explicit institutional figure, treat
  // anything over ₦100,000 as needing a second pair of eyes.
  return Number(setting?.value ?? 100_000_00);
}

/** Persist a ledger entry and its postings. */
async function writeEntry(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  entry: ReturnType<typeof entryRefundApproved>,
  refs: { refundId?: string; invoiceId?: string }
): Promise<void> {
  await tx.ledgerEntry.create({
    data: {
      eventType: entry.eventType as never,
      amount: entry.amount,
      refundId: refs.refundId ?? null,
      invoiceId: refs.invoiceId ?? null,
      memo: entry.memo ?? null,
      occurredAt: entry.occurredAt,
      createdByUserId: entry.createdByUserId,
      postings: {
        create: entry.postings.map((p) => ({
          account: p.account as never,
          side: p.side,
          amount: p.amount,
          revenueAccountId: p.revenueAccountId ?? null,
          chargeKind: (p.chargeKind ?? null) as never,
          memo: p.memo ?? null,
        })),
      },
    },
  });
}

// ============================================================
// POST /api/payments — confirming that money was received
// ------------------------------------------------------------
// This is the most dangerous route in the application. Everything downstream —
// allocation, settlement instructions, receipts, the patient being told they may
// go to theatre — hangs off what happens here.
//
// SEVEN THINGS MUST ALL HOLD, OR NOTHING IS WRITTEN.
//
//   1. The caller may confirm payments at all              (permission)
//   2. The caller is not confirming their own invoice work (separation of duties)
//   3. This exact request has not already been processed   (idempotency)
//   4. The invoice can accept this amount                  (§11 steps 2-5)
//   5. The status transition is legal AND evidenced        (§10, §2)
//   6. The allocation sums back to the money exactly       (§12)
//   7. The ledger entries balance                          (§18)
//
// All of it happens inside ONE database transaction, including the audit write
// and the idempotency key. That is not tidiness. If money moves and the audit
// row does not, the next separation-of-duties check is blind to what just
// happened; if money moves and the idempotency key does not, a retry moves it
// twice. They must succeed together or fail together.
//
// §20's allocation timing decides how much is allocated now — nothing until the
// invoice is settled by default, or each instalment as it arrives under
// PRO_RATA. Both are exact.
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { guard, readJson } from '@/lib/apiGuard';
import { Permission } from '@/lib/rbac';
import { Duty, recordAudit } from '@/lib/audit';
import { idempotencyKeyFrom, replayIfSeen, rememberResult } from '@/lib/idempotency';
import { nextNumber, Series } from '@/lib/numbering';
import { allocateInvoice, AllocationRule, proRataLines } from '@/lib/allocation';
import { entryPaymentReceived, entryRevenueAllocated, LedgerEntry } from '@/lib/ledger';
import {
  amountToAllocate,
  AllocationTiming,
  canAcceptPayment,
  InvoiceStatus,
  statusAfterPayment,
} from '@/lib/invoice';
import { canTransition, PaymentStatus, TrustBasis } from '@/lib/payments/states';
import { AgreementSnapshot, levyInForce } from '@/lib/agreements';

export const dynamic = 'force-dynamic';

const SCOPE = 'payments.confirm';

interface Body {
  invoiceId?: string;
  /** Kobo. */
  amount?: number;
  channel?: string;
  trustBasis?: TrustBasis;
  providerCode?: string;
  providerTransactionId?: string;
  bankReference?: string;
  /** Teller slip or POS receipt reference, for an ATTESTED desk payment. */
  evidenceRef?: string;
  notes?: string;
}

export async function POST(request: NextRequest) {
  const parsed = await readJson<Body>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  if (!body.invoiceId) {
    return NextResponse.json({ error: 'Which invoice is being paid?', code: 'INVOICE_REQUIRED' }, { status: 400 });
  }

  // --- 1 and 2. Permission, then separation of duties on THIS invoice ------
  // The invoice id is passed so the check sees what was done to the BILL, not
  // merely to the payment row that does not exist yet. Without that, the person
  // who overrode the price could confirm the payment, because the price change
  // was recorded against a different record.
  const g = await guard(request, {
    permission: Permission.PAYMENT_CONFIRM,
    duty: Duty.PAYMENT_CONFIRMED,
    entity: 'invoice',
    entityId: body.invoiceId,
    invoiceId: body.invoiceId,
  });
  if (!g.ok) return g.response;
  const { actor, audit, sodOverridden } = g;

  // --- 3. Idempotency ------------------------------------------------------
  const key = idempotencyKeyFrom(request, body, actor.userId);
  const replay = await replayIfSeen(key, SCOPE);
  if (replay) return replay;

  const invoice = await prisma.invoice.findUnique({
    where: { id: body.invoiceId },
    include: {
      lines: { select: { id: true, kind: true, lineTotal: true, overrideAccountId: true, isDeposit: true } },
    },
  });
  if (!invoice) return NextResponse.json({ error: 'Invoice not found.', code: 'NOT_FOUND' }, { status: 404 });

  // --- 4. May this invoice accept this amount? (§11) -----------------------
  const amount = body.amount ?? 0;
  const acceptance = canAcceptPayment({
    status: invoice.status as InvoiceStatus,
    total: invoice.total,
    amountPaid: invoice.amountPaid,
    payment: amount,
  });
  if (!acceptance.allowed) {
    return NextResponse.json({ error: acceptance.message, code: acceptance.code }, { status: 409 });
  }

  // --- 5. Is the transition legal, and is it EVIDENCED? (§2, §10) ----------
  const trustBasis = body.trustBasis;
  const transitionCheck = canTransition('PENDING', 'SUCCESSFUL', {
    trustBasis,
    providerTransactionId: body.providerTransactionId ?? null,
    bankReference: body.bankReference ?? null,
    // A desk payment is attested by the person making this request, under their
    // own user id. It cannot be attributed to somebody else.
    attestedByUserId: trustBasis === 'ATTESTED' ? actor.userId : null,
    evidenceRef: body.evidenceRef ?? null,
  });
  if (!transitionCheck.allowed) {
    return NextResponse.json({ error: transitionCheck.message, code: transitionCheck.code }, { status: 422 });
  }

  // A gateway-verified payment is NOT taken on the client's word that it was
  // verified. The claim is checked against this application's own record of the
  // server-to-server verification, which only the verify route can write.
  if (trustBasis === 'GATEWAY_VERIFIED') {
    const verified = await prisma.paymentTransaction.findFirst({
      where: {
        operation: 'VERIFY',
        providerReference: body.providerTransactionId,
        providerStatus: 'success',
        signatureValid: true,
      },
      select: { id: true, providerAmount: true },
    });
    if (!verified) {
      return NextResponse.json(
        {
          error:
            'There is no server-side verification on record for that provider transaction. A payment is not confirmed because a client says the gateway approved it — the gateway must be asked directly.',
          code: 'NO_SERVER_VERIFICATION',
        },
        { status: 422 }
      );
    }
    // §11 step 3: verify the AMOUNT, not merely that a transaction exists.
    if (verified.providerAmount != null && verified.providerAmount !== amount) {
      return NextResponse.json(
        {
          error: `The gateway reports ${verified.providerAmount} kobo for that transaction but ${amount} kobo is being recorded. The figures must agree.`,
          code: 'AMOUNT_MISMATCH',
        },
        { status: 409 }
      );
    }
  }

  const provider = body.providerCode
    ? await prisma.paymentProvider.findUnique({ where: { code: body.providerCode } })
    : await prisma.paymentProvider.findUnique({ where: { code: 'DESK' } });

  if (!provider || !provider.isActive) {
    return NextResponse.json(
      { error: 'That payment provider is not configured or not enabled.', code: 'PROVIDER_UNAVAILABLE' },
      { status: 409 }
    );
  }

  // --- 6. How much is allocated now? (§20) --------------------------------
  const amountPaidAfter = invoice.amountPaid + amount;
  const nextInvoiceStatus = statusAfterPayment({
    current: invoice.status as InvoiceStatus,
    total: invoice.total,
    amountPaid: amountPaidAfter,
  });

  const timingSetting = await prisma.organisationSetting.findUnique({ where: { key: 'ALLOCATION_TIMING' } });
  const timing = (timingSetting?.value as AllocationTiming) ?? 'ON_FULL_PAYMENT';

  const allocateNow = amountToAllocate({
    timing,
    paymentAmount: amount,
    totalPaidAfter: amountPaidAfter,
    invoiceTotal: invoice.total,
  });

  // A DEPOSIT line is not revenue and is never allocated to a revenue account
  // (§21). It is held as a liability and drawn down as services are consumed.
  const revenueLines = invoice.lines.filter((l) => !l.isDeposit);
  const depositLines = invoice.lines.filter((l) => l.isDeposit);
  const depositTotal = depositLines.reduce((s, l) => s + l.lineTotal, 0);

  let allocation: ReturnType<typeof allocateInvoice> | null = null;

  if (allocateNow > 0 && revenueLines.length > 0) {
    const rules = await loadAllocationRules();
    const fallback = await prisma.revenueAccount.findFirst({
      where: { code: 'ACCT-HOSPITAL', isActive: true },
      select: { id: true },
    });
    if (!fallback) {
      return NextResponse.json(
        {
          error:
            'No fallback hospital revenue account is configured, so this payment cannot be allocated. Set one up before taking payments — allocating to nowhere is not an option.',
          code: 'NO_FALLBACK_ACCOUNT',
        },
        { status: 409 }
      );
    }

    // Under PRO_RATA the instalment covers only part of the bill, so each line
    // contributes its proportion. Scaling the LINES rather than the shares keeps
    // the per-line traceability §30 requires, and the engine still guarantees
    // the total is exact.
    const revenueTotal = revenueLines.reduce((s, l) => s + l.lineTotal, 0);
    const allocatableRevenue = Math.min(allocateNow, revenueTotal);

    // A vendor line carries a levy ONLY where a supply agreement, signed by both
    // the hospital and the vendor at this exact percentage, is in force today.
    // Anything else — unsigned, suspended, expired, out of scope, or signed at a
    // percentage that has since moved — yields no levy and the vendor is paid in
    // full. lib/agreements.ts makes that decision; nothing is inferred here.
    const levies = await resolveVendorLevies(revenueLines);

    const scaled = proRataLines(
      revenueLines.map((l) => ({
        lineId: l.id,
        chargeKind: l.kind as string,
        lineTotal: l.lineTotal,
        overrideAccountId: l.overrideAccountId,
        vendorLevy: l.overrideAccountId ? (levies.get(`${l.overrideAccountId}::${l.kind}`) ?? null) : null,
      })),
      allocatableRevenue,
      revenueTotal
    );

    allocation = allocateInvoice({
      lines: scaled,
      rulesByChargeKind: rules,
      fallbackAccountId: fallback.id,
    });
  }

  // --- 7. Write it all, or none of it -------------------------------------
  try {
    const result = await prisma.$transaction(async (tx) => {
      const paymentNumber = await nextNumber(tx, Series.PAYMENT);

      const payment = await tx.payment.create({
        data: {
          invoiceId: invoice.id,
          paymentNumber,
          amount,
          status: 'SUCCESSFUL' as PaymentStatus,
          channel: (body.channel as never) ?? 'CASH',
          trustBasis: trustBasis as never,
          providerId: provider.id,
          providerTransactionId: body.providerTransactionId ?? null,
          bankReference: body.bankReference ?? null,
          attestedByUserId: trustBasis === 'ATTESTED' ? actor.userId : null,
          attestedByName: trustBasis === 'ATTESTED' ? actor.fullName : null,
          evidenceRef: body.evidenceRef ?? null,
          confirmedAt: new Date(),
          notes: body.notes ?? null,
          createdById: actor.userId,
        },
      });

      const updatedInvoice = await tx.invoice.update({
        where: { id: invoice.id },
        data: {
          amountPaid: { increment: amount },
          status: nextInvoiceStatus as never,
          ...(nextInvoiceStatus === 'PAID' || nextInvoiceStatus === 'OVERPAID' ? { paidAt: new Date() } : {}),
          version: { increment: 1 },
        },
      });

      // --- The ledger (§18) ------------------------------------------------
      const entries: LedgerEntry[] = [
        entryPaymentReceived({
          invoiceId: invoice.id,
          paymentId: payment.id,
          amount,
          createdByUserId: actor.userId,
          memo: `${payment.paymentNumber} via ${provider.code}`,
        }),
      ];

      if (allocation && allocation.rolledUp.length > 0) {
        entries.push(
          entryRevenueAllocated({
            invoiceId: invoice.id,
            paymentId: payment.id,
            shares: allocation.rolledUp.map((s) => ({
              revenueAccountId: s.accountId,
              amount: s.amount,
              chargeKind: s.chargeKind,
            })),
            createdByUserId: actor.userId,
          })
        );
      }

      for (const entry of entries) {
        await tx.ledgerEntry.create({
          data: {
            eventType: entry.eventType as never,
            amount: entry.amount,
            invoiceId: entry.refs.invoiceId ?? null,
            paymentId: entry.refs.paymentId ?? null,
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

      // --- Distributions, one row per line per account (§30) --------------
      if (allocation) {
        for (const la of allocation.perLine) {
          for (const share of la.shares) {
            if (share.amount === 0) continue;
            await tx.distribution.create({
              data: {
                invoiceId: invoice.id,
                paymentId: payment.id,
                invoiceLineId: la.lineId,
                accountId: share.accountId,
                kind: la.chargeKind as never,
                amount: share.amount,
                ruleType: share.ruleType as never,
                shareBasisPoints: share.shareBasisPoints,
              },
            });
          }
        }
      }

      // --- Deposits are a liability, not revenue (§21) ---------------------
      if (depositTotal > 0 && (nextInvoiceStatus === 'PAID' || nextInvoiceStatus === 'OVERPAID')) {
        const existing = await tx.deposit.findFirst({ where: { encounterId: invoice.encounterId } });
        if (!existing) {
          await tx.deposit.create({
            data: {
              patientId: invoice.patientId,
              encounterId: invoice.encounterId,
              depositNumber: await nextNumber(tx, Series.DEPOSIT),
              amount: depositTotal,
              paymentId: payment.id,
              createdById: actor.userId,
              notes: 'Admission deposit — held against services not yet consumed.',
            },
          });
        }
      }

      // --- The audit row, in the SAME transaction (§33) --------------------
      await recordAudit(tx, audit, {
        duty: Duty.PAYMENT_CONFIRMED,
        action: 'payment.confirm',
        entity: 'payment',
        entityId: payment.id,
        invoiceId: invoice.id,
        paymentId: payment.id,
        patientId: invoice.patientId,
        previousValue: { invoiceStatus: invoice.status, amountPaid: invoice.amountPaid },
        newValue: {
          invoiceStatus: nextInvoiceStatus,
          amountPaid: amountPaidAfter,
          amount,
          trustBasis,
          provider: provider.code,
          allocated: allocation?.allocated ?? 0,
        },
        reason: body.notes ?? null,
        sodOverridden,
      });

      const payload = {
        success: true,
        payment: {
          id: payment.id,
          paymentNumber: payment.paymentNumber,
          amount: payment.amount,
          status: payment.status,
          trustBasis: payment.trustBasis,
          confirmedAt: payment.confirmedAt,
        },
        invoice: {
          id: updatedInvoice.id,
          invoiceNumber: updatedInvoice.invoiceNumber,
          status: updatedInvoice.status,
          total: updatedInvoice.total,
          amountPaid: updatedInvoice.amountPaid,
          balance: Math.max(0, updatedInvoice.total - updatedInvoice.amountPaid),
        },
        allocation: allocation
          ? {
              timing,
              allocated: allocation.allocated,
              shares: allocation.rolledUp.length,
              // Stated in the response so a caller never has to take it on
              // trust: what was allocated equals what was allocatable.
              matchesAmountAllocatable: allocation.allocated === Math.min(allocateNow, revenueLines.reduce((s, l) => s + l.lineTotal, 0)),
              warnings: allocation.warnings,
            }
          : { timing, allocated: 0, shares: 0, note: 'Nothing allocated yet — this invoice is not fully paid.' },
        deposit: depositTotal > 0 ? { heldAsLiability: depositTotal } : null,
        // §51: an attested payment says so, plainly, in its own response.
        reconciliation:
          trustBasis === 'ATTESTED'
            ? { status: 'AWAITING_BANK_CONFIRMATION', note: 'This payment was attested at the desk and appears in the exceptions report until a bank statement confirms it.' }
            : { status: 'VERIFIED' },
      };

      await rememberResult({ key, scope: SCOPE, httpStatus: 201, body: payload, paymentId: payment.id, tx });

      return payload;
    });

    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    // An allocation or ledger imbalance throws, and throwing is correct: it
    // means no money and no record were written, which is the safe outcome.
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[payments] confirm failed:', err);

    if (/not exact|does not balance|append-only/i.test(message)) {
      return NextResponse.json(
        { error: `This payment was refused to protect the ledger: ${message}`, code: 'LEDGER_REFUSED' },
        { status: 500 }
      );
    }
    return NextResponse.json({ error: 'The payment could not be recorded.', code: 'PAYMENT_FAILED' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------

/**
 * The supply-agreement levy for each vendor line on this invoice.
 *
 * Keyed by `revenueAccountId::chargeKind`, because one vendor may supply two
 * kinds under agreements of different scope. Lines whose vendor has no live,
 * fully signed agreement are simply absent from the map, and the allocation
 * engine then pays that vendor in full — the safe default, and the only honest
 * one: an unagreed deduction from a supplier's money is not a configuration
 * default, it is a deduction nobody consented to.
 */
async function resolveVendorLevies(
  lines: { kind: string; overrideAccountId: string | null }[]
): Promise<Map<string, { accountId: string; basisPoints: number; agreementRef: string }>> {
  const out = new Map<string, { accountId: string; basisPoints: number; agreementRef: string }>();

  const vendorAccountIds = Array.from(new Set(lines.map((l) => l.overrideAccountId).filter((x): x is string => Boolean(x))));
  if (vendorAccountIds.length === 0) return out;

  const vendors = await prisma.vendor.findMany({
    where: { revenueAccountId: { in: vendorAccountIds } },
    select: {
      revenueAccountId: true,
      agreements: {
        where: { status: 'ACTIVE' },
        include: { signatures: true },
      },
    },
  });

  const now = new Date();

  for (const vendor of vendors) {
    if (!vendor.revenueAccountId) continue;

    for (const agreement of vendor.agreements) {
      const snapshot: AgreementSnapshot = {
        id: agreement.id,
        levyBasisPoints: agreement.levyBasisPoints,
        status: agreement.status as AgreementSnapshot['status'],
        effectiveFrom: agreement.effectiveFrom,
        effectiveTo: agreement.effectiveTo,
        coveredKinds: agreement.coveredKinds as string[],
        signatures: agreement.signatures.map((s) => ({
          party: s.party as 'HOSPITAL' | 'VENDOR' | 'WITNESS',
          consentGiven: s.consentGiven,
          agreedLevyBasisPoints: s.agreedLevyBasisPoints,
          signedAt: s.signedAt,
          revokedAt: s.revokedAt,
        })),
      };

      for (const kind of new Set(lines.filter((l) => l.overrideAccountId === vendor.revenueAccountId).map((l) => l.kind))) {
        const verdict = levyInForce({ agreement: snapshot, chargeKind: kind, asOf: now });
        if (verdict.basisPoints > 0) {
          out.set(`${vendor.revenueAccountId}::${kind}`, {
            accountId: agreement.levyAccountId,
            basisPoints: verdict.basisPoints,
            agreementRef: agreement.agreementNumber,
          });
        }
      }
    }
  }

  return out;
}

/** Rules in force today, keyed by charge kind (§41). */
async function loadAllocationRules(): Promise<Record<string, AllocationRule[]>> {
  const today = new Date();
  const rows = await prisma.allocationRule.findMany({
    where: {
      effectiveFrom: { lte: today },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }],
      account: { isActive: true },
    },
    select: {
      kind: true, accountId: true, type: true, amount: true,
      shareBasisPoints: true, priority: true, label: true,
    },
  });

  const byKind: Record<string, AllocationRule[]> = {};
  for (const r of rows) {
    (byKind[r.kind] ??= []).push({
      accountId: r.accountId,
      type: r.type as AllocationRule['type'],
      amount: r.amount ?? undefined,
      shareBasisPoints: r.shareBasisPoints ?? undefined,
      priority: r.priority,
      label: r.label ?? undefined,
    });
  }
  return byKind;
}

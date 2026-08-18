// ============================================================
// /api/invoices — assembling the one consolidated bill (§4, §7, §39)
// ------------------------------------------------------------
// GET   list invoices
// POST  build one bill from every approved charge on an encounter
//
// §1's whole point: a surgical patient must not queue seven times. Theatre,
// surgeon, anaesthetist, drugs, fluids, consumables and admission arrive as
// separate charges from separate departments and leave here as ONE invoice with
// ONE total.
//
// TWO SAFEGUARDS ARE STRUCTURAL RATHER THAN ADVISORY.
//
// A bill is assembled from charges that are APPROVED. A surgeon can add a
// consumable to an encounter; that does not make it payable. §39 requires review
// before a bill becomes payable, and the charge status is where that lives.
//
// An issued invoice is LOCKED (§23, §44). Once money has touched it, correcting
// it is an adjustment or a credit note — a new financial record — never an edit
// to the original. isLocked() decides, and the route refuses rather than
// quietly writing.
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { guard, readJson } from '@/lib/apiGuard';
import { Permission } from '@/lib/rbac';
import { Duty, recordAudit } from '@/lib/audit';
import { nextNumber, Series } from '@/lib/numbering';
import { buildInvoice, ChargeRequest, InvoiceStatus, isLocked } from '@/lib/invoice';
import { entryInvoiceIssued } from '@/lib/ledger';
import { randomUUID } from 'crypto';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------
export async function GET(request: NextRequest) {
  const g = await guard(request, { permission: Permission.INVOICE_VIEW });
  if (!g.ok) return g.response;

  const sp = request.nextUrl.searchParams;
  const status = sp.get('status');
  const patientId = sp.get('patientId');

  const invoices = await prisma.invoice.findMany({
    where: {
      ...(status ? { status: status as never } : {}),
      ...(patientId ? { patientId } : {}),
    },
    select: {
      id: true, invoiceNumber: true, patientName: true, status: true,
      total: true, amountPaid: true, depositComponent: true,
      issuedAt: true, createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Number(sp.get('limit') ?? 100), 500),
  });

  return NextResponse.json({
    invoices: invoices.map((i) => ({ ...i, balance: Math.max(0, i.total - i.amountPaid) })),
    count: invoices.length,
  });
}

// ---------------------------------------------------------------------------
// POST — assemble the bill
// ---------------------------------------------------------------------------
interface Body {
  encounterId?: string;
  /** Kobo. Requires DISCOUNT_APPROVE above the configured threshold (§22). */
  discount?: number;
  discountReason?: string;
  /** Issue immediately, rather than leaving it as a reviewable draft. */
  issueNow?: boolean;
  notes?: string;
}

export async function POST(request: NextRequest) {
  const parsed = await readJson<Body>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  if (!body.encounterId) {
    return NextResponse.json({ error: 'Which encounter is being billed?', code: 'ENCOUNTER_REQUIRED' }, { status: 400 });
  }

  const g = await guard(request, {
    permission: Permission.INVOICE_CREATE,
    duty: Duty.INVOICE_CREATED,
    entity: 'encounter',
    entityId: body.encounterId,
  });
  if (!g.ok) return g.response;
  const { actor, audit, sodOverridden } = g;

  const encounter = await prisma.encounter.findUnique({
    where: { id: body.encounterId },
    include: {
      patient: { select: { id: true, fullName: true } },
      charges: {
        where: { status: 'APPROVED' },
        orderBy: { requestedAt: 'asc' },
      },
      invoices: { select: { id: true, invoiceNumber: true, status: true } },
    },
  });

  if (!encounter) {
    return NextResponse.json({ error: 'Encounter not found.', code: 'NOT_FOUND' }, { status: 404 });
  }

  // A second bill for the same episode is almost always a mistake, and a patient
  // receiving two invoices for one operation is exactly what §1 exists to
  // prevent. An existing live invoice must be cancelled deliberately first.
  const live = encounter.invoices.find((i) => !['CANCELLED', 'REFUNDED'].includes(i.status));
  if (live) {
    return NextResponse.json(
      {
        error: `This encounter already has invoice ${live.invoiceNumber}. Add charges to it, or cancel it before raising another — a patient should receive one bill, not two.`,
        code: 'INVOICE_EXISTS',
        invoiceId: live.id,
      },
      { status: 409 }
    );
  }

  if (encounter.charges.length === 0) {
    return NextResponse.json(
      {
        error: 'There are no approved charges on this encounter yet, so there is nothing to bill. Charges must be approved before they become payable (§39).',
        code: 'NO_APPROVED_CHARGES',
      },
      { status: 409 }
    );
  }

  // --- Discount authority (§22) -------------------------------------------
  const discount = body.discount ?? 0;
  if (discount > 0) {
    if (!body.discountReason || body.discountReason.trim().length < 10) {
      return NextResponse.json(
        { error: 'A discount needs a reason that will still make sense to an auditor next year.', code: 'REASON_REQUIRED' },
        { status: 400 }
      );
    }
    // Applying a discount and approving it are different duties (§25). This
    // route only APPLIES; anything beyond the threshold is left awaiting
    // approval rather than taking effect on the applier's own authority.
  }

  const taxSetting = await prisma.organisationSetting.findUnique({ where: { key: 'DEFAULT_TAX_BASIS_POINTS' } });
  const taxBasisPoints = Number(taxSetting?.value ?? 0);

  // --- Assemble ------------------------------------------------------------
  const charges: ChargeRequest[] = encounter.charges.map((c) => ({
    sourceRef: c.sourceRef,
    sourceKind: c.sourceKind,
    kind: c.kind as ChargeRequest['kind'],
    description: c.description,
    quantity: c.quantity,
    unitPrice: c.unitPrice,
    tariffId: c.tariffId,
    overrideAccountId: c.overrideAccountId,
  }));

  let draft: ReturnType<typeof buildInvoice>;
  try {
    draft = buildInvoice({ charges, discount, taxBasisPoints });
  } catch (err) {
    // A bad charge is refused with the reason, not swallowed into a 500: the
    // clerk can usually fix it in the charge that caused it.
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'This bill could not be assembled.', code: 'INVALID_CHARGE' },
      { status: 422 }
    );
  }

  const status: InvoiceStatus = body.issueNow ? 'ISSUED' : 'DRAFT';

  try {
    const created = await prisma.$transaction(async (tx) => {
      const invoiceNumber = await nextNumber(tx, Series.INVOICE);

      const invoice = await tx.invoice.create({
        data: {
          invoiceNumber,
          patientId: encounter.patient.id,
          patientName: encounter.patient.fullName,
          encounterId: encounter.id,
          status: status as never,
          subtotal: draft.subtotal,
          discount: draft.discount,
          tax: draft.tax,
          total: draft.total,
          depositComponent: draft.depositComponent,
          discountReason: body.discountReason ?? null,
          notes: body.notes ?? null,
          createdById: actor.userId,
          ...(body.issueNow ? { issuedAt: new Date(), issuedById: actor.userId } : {}),
          // The token behind the payment link and QR code (§28). Unguessable, so
          // one patient cannot read another's bill by changing a number.
          paymentToken: randomUUID(),
          lines: {
            create: draft.lines.map((l) => {
              const charge = encounter.charges.find((c) => c.sourceRef === l.sourceRef);
              return {
                chargeId: charge?.id ?? null,
                serviceId: charge?.serviceId ?? null,
                kind: l.kind as never,
                description: l.description,
                quantity: l.quantity,
                unitPrice: l.unitPrice,
                lineTotal: l.lineTotal,
                tariffId: l.tariffId,
                isDeposit: l.isDeposit,
                overrideAccountId: l.overrideAccountId,
                sourceKind: l.sourceKind,
                sourceRef: l.sourceRef,
              };
            }),
          },
        },
        include: { lines: true },
      });

      await tx.charge.updateMany({
        where: { id: { in: encounter.charges.map((c) => c.id) } },
        data: { status: 'BILLED' },
      });

      // The ledger records the debt only when the bill is ISSUED. A draft is not
      // a claim on anybody, and posting one would overstate receivables.
      if (body.issueNow) {
        const entry = entryInvoiceIssued({
          invoiceId: invoice.id,
          grossServiceAmount: draft.subtotal - draft.depositComponent,
          taxAmount: draft.tax,
          discountAmount: draft.discount,
          depositAmount: draft.depositComponent,
          createdByUserId: actor.userId,
        });

        await tx.ledgerEntry.create({
          data: {
            eventType: entry.eventType as never,
            amount: entry.amount,
            invoiceId: invoice.id,
            memo: `Invoice ${invoiceNumber} issued`,
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

      await recordAudit(tx, audit, {
        duty: body.issueNow ? Duty.INVOICE_ISSUED : Duty.INVOICE_CREATED,
        action: body.issueNow ? 'invoice.issue' : 'invoice.create',
        entity: 'invoice',
        entityId: invoice.id,
        invoiceId: invoice.id,
        patientId: encounter.patient.id,
        newValue: {
          invoiceNumber,
          total: draft.total,
          lines: draft.lines.length,
          discount: draft.discount,
          depositComponent: draft.depositComponent,
        },
        reason: body.discountReason ?? null,
        sodOverridden,
      });

      return invoice;
    });

    return NextResponse.json(
      {
        success: true,
        invoice: {
          id: created.id,
          invoiceNumber: created.invoiceNumber,
          status: created.status,
          patientName: created.patientName,
          subtotal: created.subtotal,
          discount: created.discount,
          tax: created.tax,
          total: created.total,
          depositComponent: created.depositComponent,
          balance: created.total,
        },
        sections: draft.sections.map((s) => ({
          label: s.label,
          subtotal: s.subtotal,
          lines: s.lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, lineTotal: l.lineTotal })),
        })),
        // Named plainly so nobody mistakes the deposit for earned revenue (§21).
        note: draft.depositComponent > 0
          ? `${draft.depositComponent} kobo of this bill is a deposit, held against services not yet consumed rather than earned revenue.`
          : undefined,
      },
      { status: 201 }
    );
  } catch (err) {
    console.error('[invoices] create failed:', err);
    return NextResponse.json({ error: 'The invoice could not be created.', code: 'INVOICE_FAILED' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// PATCH — cancel, the only edit an issued invoice permits (§23)
// ---------------------------------------------------------------------------
export async function PATCH(request: NextRequest) {
  const parsed = await readJson<{ id?: string; reason?: string }>(request);
  if (!parsed.ok) return parsed.response;
  const { id, reason } = parsed.body;

  if (!id || !reason || reason.trim().length < 10) {
    return NextResponse.json(
      { error: 'An invoice and a reason for cancelling it are required.', code: 'REASON_REQUIRED' },
      { status: 400 }
    );
  }

  const g = await guard(request, {
    permission: Permission.INVOICE_CANCEL,
    duty: Duty.INVOICE_CANCELLED,
    entity: 'invoice',
    entityId: id,
    invoiceId: id,
  });
  if (!g.ok) return g.response;

  const invoice = await prisma.invoice.findUnique({ where: { id } });
  if (!invoice) return NextResponse.json({ error: 'Invoice not found.', code: 'NOT_FOUND' }, { status: 404 });

  // Money has touched it: cancelling would erase a paid bill. The correction is
  // a refund and a credit note, both of which leave the original standing.
  if (isLocked(invoice.status as InvoiceStatus) && invoice.amountPaid > 0) {
    return NextResponse.json(
      {
        error:
          'Money has already been received against this invoice, so it cannot be cancelled. Raise a refund and a credit note instead — the original record stays as it is (§23).',
        code: 'INVOICE_LOCKED',
      },
      { status: 409 }
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.invoice.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason.trim(), version: { increment: 1 } },
    });
    await recordAudit(tx, g.audit, {
      duty: Duty.INVOICE_CANCELLED,
      action: 'invoice.cancel',
      entity: 'invoice',
      entityId: id,
      invoiceId: id,
      patientId: invoice.patientId,
      previousValue: { status: invoice.status },
      newValue: { status: 'CANCELLED' },
      reason: reason.trim(),
      sodOverridden: g.sodOverridden,
    });
  });

  return NextResponse.json({ success: true, status: 'CANCELLED' });
}

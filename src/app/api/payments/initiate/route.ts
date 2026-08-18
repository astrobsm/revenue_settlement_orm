// ============================================================
// POST /api/payments/initiate — sending the patient to pay (§8, §28)
// ------------------------------------------------------------
// Produces the payment link a patient follows, or the QR code shown at the
// revenue desk. It moves no money and marks nothing paid; it opens a door.
//
// THE REFERENCE IS THE JOIN. We mint it, we send it to the provider, and the
// provider returns it on the webhook. That is how a payment landing hours later
// is matched to the right bill without believing anything the webhook says about
// which invoice it belongs to. The invoice's own paymentToken is used, so the
// mapping is a lookup against our record rather than a claim in a message.
//
// The token is a UUID rather than the invoice number, and that matters for
// privacy: the number is sequential, so a patient given a payment link with
// CTR/INV/2026/000124 in it could reach 000125 by editing the URL.
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { guard, readJson } from '@/lib/apiGuard';
import { Permission } from '@/lib/rbac';
import { recordAudit } from '@/lib/audit';
import { adapterFor, ProviderError } from '@/lib/payments/providers';
import { canAcceptPayment, InvoiceStatus } from '@/lib/invoice';
import { formatNaira } from '@/lib/money';

export const dynamic = 'force-dynamic';

interface Body {
  invoiceId?: string;
  providerCode?: string;
  /** Kobo. Defaults to the whole outstanding balance. */
  amount?: number;
  email?: string;
  callbackUrl?: string;
}

export async function POST(request: NextRequest) {
  const parsed = await readJson<Body>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  if (!body.invoiceId) {
    return NextResponse.json({ error: 'Which invoice?', code: 'INVOICE_REQUIRED' }, { status: 400 });
  }

  // Initiating is not confirming, so it needs no separation-of-duties check:
  // sending a patient to a payment page moves nothing and grants nothing. The
  // dangerous act is confirming, and that is guarded in /api/payments.
  const g = await guard(request, { permission: Permission.PAYMENT_INITIATE });
  if (!g.ok) return g.response;
  const { actor, audit } = g;

  const invoice = await prisma.invoice.findUnique({
    where: { id: body.invoiceId },
    select: {
      id: true, invoiceNumber: true, status: true, total: true, amountPaid: true,
      paymentToken: true, patientName: true,
      patient: { select: { id: true, email: true, phone: true } },
    },
  });
  if (!invoice) return NextResponse.json({ error: 'Invoice not found.', code: 'NOT_FOUND' }, { status: 404 });

  const outstanding = Math.max(0, invoice.total - invoice.amountPaid);
  const amount = body.amount ?? outstanding;

  // The same acceptance rules the confirmation path uses. Checking here as well
  // is not redundant: it stops a patient being sent to a payment page for a bill
  // that cannot accept the money, which is a far worse experience than a refusal
  // at the desk.
  const acceptance = canAcceptPayment({
    status: invoice.status as InvoiceStatus,
    total: invoice.total,
    amountPaid: invoice.amountPaid,
    payment: amount,
  });
  if (!acceptance.allowed) {
    return NextResponse.json({ error: acceptance.message, code: acceptance.code }, { status: 409 });
  }

  const providerCode = (body.providerCode ?? 'PAYSTACK').toUpperCase();
  const adapter = adapterFor(providerCode);
  if (!adapter) {
    return NextResponse.json(
      { error: `${providerCode} is not a payment provider this application supports.`, code: 'UNKNOWN_PROVIDER' },
      { status: 400 }
    );
  }

  const providerRow = await prisma.paymentProvider.findUnique({ where: { code: providerCode } });
  if (!providerRow?.isActive) {
    return NextResponse.json(
      { error: `${providerCode} is not enabled. A finance administrator must enable it first.`, code: 'PROVIDER_DISABLED' },
      { status: 409 }
    );
  }
  if (!adapter.isConfigured()) {
    // Distinguished from "disabled" deliberately: one is a decision, the other
    // is a missing secret, and they need different people to fix them.
    return NextResponse.json(
      { error: `${providerCode} is enabled but has no credentials configured. Set its secret key.`, code: 'PROVIDER_NOT_CONFIGURED' },
      { status: 503 }
    );
  }

  const email = body.email ?? invoice.patient.email;
  if (!email) {
    // Every Nigerian gateway requires an email for the receipt. Refusing here
    // with a clear reason beats a provider error the clerk cannot interpret.
    return NextResponse.json(
      { error: 'This patient has no email address on record, and the payment gateway requires one. Add one, or take the payment at the desk.', code: 'EMAIL_REQUIRED' },
      { status: 400 }
    );
  }

  const reference = invoice.paymentToken;
  if (!reference) {
    return NextResponse.json({ error: 'This invoice has no payment token.', code: 'NO_TOKEN' }, { status: 409 });
  }

  try {
    const result = await adapter.initiate({
      reference,
      amount,
      currency: 'NGN',
      email,
      callbackUrl: body.callbackUrl ?? `${process.env.NEXTAUTH_URL ?? ''}/pay/${reference}/complete`,
      metadata: {
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        // Deliberately no patient name, diagnosis or procedure. A third-party
        // processor needs to know what to charge, not who is ill.
        initiatedBy: actor.userId,
      },
    });

    await prisma.paymentTransaction.create({
      data: {
        providerId: providerRow.id,
        operation: 'INITIALISE',
        providerStatus: 'initiated',
        providerReference: reference,
        providerAmount: amount,
        httpStatus: 200,
        requestPayload: { reference, amount, currency: 'NGN' } as never,
        responsePayload: result.raw as never,
      },
    });

    await recordAudit(prisma, audit, {
      action: 'payment.initiate',
      entity: 'invoice',
      entityId: invoice.id,
      invoiceId: invoice.id,
      patientId: invoice.patient.id,
      newValue: { provider: providerCode, amount, reference },
    });

    return NextResponse.json({
      success: true,
      authorizationUrl: result.authorizationUrl,
      reference,
      amount,
      amountFormatted: formatNaira(amount),
      provider: providerCode,
      // Stated so no caller mistakes a payment page for a payment.
      note: 'This opens a payment page. Nothing is paid until the gateway confirms it and the confirmation is verified server-side.',
    });
  } catch (err) {
    const message = err instanceof ProviderError ? err.message : 'The payment could not be started.';
    const code = err instanceof ProviderError ? err.code : 'INITIATE_FAILED';

    await prisma.paymentTransaction
      .create({
        data: {
          providerId: providerRow.id,
          operation: 'INITIALISE',
          providerStatus: 'failed',
          providerReference: reference,
          providerAmount: amount,
          requestPayload: { reference, amount } as never,
          responsePayload: { error: message, code } as never,
        },
      })
      .catch(() => undefined);

    console.error('[payments] initiate failed:', err);
    return NextResponse.json({ error: message, code }, { status: 502 });
  }
}

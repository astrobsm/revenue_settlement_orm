// ============================================================
// /api/settings/revenue-accounts — where the money actually goes (§14, §48)
// ------------------------------------------------------------
// These rows are the destinations of automatic distribution. Changing an account
// number here redirects real money, which makes this one of the two or three
// most sensitive endpoints in the application. Four controls apply, and none of
// them is optional:
//
//   PERMISSION      account:manage, held only by the finance administrator
//   MFA             §42 — enforced by the guard for that role
//   SEPARATION      whoever changes a destination may not confirm a settlement
//                   to it (§25); the guard reads the account's own history
//   AUDIT           both the old and new masked numbers are recorded
//
// ACCOUNT NUMBERS ARE NEVER RETURNED IN FULL. GET responds with the last four
// digits, for every caller, without exception — §14 is explicit that complete
// account numbers must not be exposed to users who do not need them, and a
// settlement screen does not need them. The full number is decrypted only when a
// transfer instruction is actually generated.
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { guard, readJson } from '@/lib/apiGuard';
import { Permission } from '@/lib/rbac';
import { Duty, recordAudit } from '@/lib/audit';
import { encryptField, encryptionAvailable, isPlausibleNuban, lastFour, maskAccountNumber } from '@/lib/crypto';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// GET — the distribution destinations, masked
// ---------------------------------------------------------------------------
export async function GET(request: NextRequest) {
  const g = await guard(request, { permission: Permission.ACCOUNT_VIEW });
  if (!g.ok) return g.response;

  const accounts = await prisma.revenueAccount.findMany({
    orderBy: [{ beneficiaryType: 'asc' }, { name: 'asc' }],
    select: {
      id: true, code: true, name: true, beneficiaryType: true,
      departmentName: true, costCentre: true, currency: true,
      bankName: true, accountName: true, accountNumberLast4: true,
      accountNumberEncrypted: true,
      providerSubaccountCode: true, isActive: true,
      approvedById: true, approvedAt: true,
      effectiveFrom: true, effectiveTo: true,
    },
  });

  return NextResponse.json({
    encryptionConfigured: encryptionAvailable(),
    accounts: accounts.map((a) => {
      const { accountNumberEncrypted, ...rest } = a;
      return {
        ...rest,
        // The mask is built from the stored last four, never by decrypting.
        accountNumberMasked: a.accountNumberLast4 ? `••••••${a.accountNumberLast4}` : null,
        // Named plainly, because an account with no bank details cannot be paid
        // however clearly it is owed — and that is worth seeing on the screen.
        readyForSettlement: Boolean(accountNumberEncrypted && a.bankName && a.isActive),
      };
    }),
    // A count rather than a silent gap: these are the accounts that will accrue
    // money the hospital then cannot transfer.
    notReadyForSettlement: accounts.filter((a) => a.isActive && !a.accountNumberEncrypted).length,
  });
}

// ---------------------------------------------------------------------------
// PATCH — set or change the bank details
// ---------------------------------------------------------------------------
interface Body {
  id?: string;
  bankName?: string;
  accountName?: string;
  accountNumber?: string;
  providerSubaccountCode?: string;
  isActive?: boolean;
  reason?: string;
}

export async function PATCH(request: NextRequest) {
  const parsed = await readJson<Body>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  if (!body.id) {
    return NextResponse.json({ error: 'Which account?', code: 'ACCOUNT_REQUIRED' }, { status: 400 });
  }
  const reason = body.reason?.trim() ?? '';
  if (reason.length < 10) {
    return NextResponse.json(
      {
        error: 'Changing a payout destination needs a reason that will still make sense to an auditor next year.',
        code: 'REASON_REQUIRED',
      },
      { status: 400 }
    );
  }

  const g = await guard(request, {
    permission: Permission.ACCOUNT_MANAGE,
    duty: Duty.BENEFICIARY_CHANGED,
    entity: 'revenue-account',
    entityId: body.id,
  });
  if (!g.ok) return g.response;
  const { actor, audit, sodOverridden } = g;

  const account = await prisma.revenueAccount.findUnique({ where: { id: body.id } });
  if (!account) return NextResponse.json({ error: 'Account not found.', code: 'NOT_FOUND' }, { status: 404 });

  const data: Record<string, unknown> = {};
  let newLast4: string | null = account.accountNumberLast4;

  if (body.accountNumber != null) {
    const number = body.accountNumber.replace(/\s/g, '');

    if (!encryptionAvailable()) {
      return NextResponse.json(
        {
          error:
            'FIELD_ENCRYPTION_KEY is not configured, so a bank account number cannot be stored safely. Set it before entering bank details.',
          code: 'ENCRYPTION_UNAVAILABLE',
        },
        { status: 503 }
      );
    }
    if (!isPlausibleNuban(number)) {
      // A mistyped destination is one of the few errors the system cannot catch
      // afterwards: the money leaves, and reconciliation only shows that it did.
      return NextResponse.json(
        { error: 'A Nigerian account number is ten digits. Check it before saving — a mistyped destination sends money somewhere nobody intended.', code: 'INVALID_ACCOUNT_NUMBER' },
        { status: 400 }
      );
    }

    data.accountNumberEncrypted = encryptField(number);
    data.accountNumberLast4 = lastFour(number);
    newLast4 = lastFour(number);

    // A destination that has changed must be re-approved. Carrying the old
    // approval forward would let a change ride on somebody else's sign-off.
    data.approvedById = null;
    data.approvedAt = null;
  }

  if (body.bankName != null) data.bankName = body.bankName.trim();
  if (body.accountName != null) data.accountName = body.accountName.trim();
  if (body.providerSubaccountCode != null) data.providerSubaccountCode = body.providerSubaccountCode.trim() || null;
  if (body.isActive != null) data.isActive = body.isActive;

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: 'Nothing to change.', code: 'NO_CHANGE' }, { status: 400 });
  }

  await prisma.$transaction(async (tx) => {
    await tx.revenueAccount.update({ where: { id: account.id }, data });

    await recordAudit(tx, audit, {
      duty: Duty.BENEFICIARY_CHANGED,
      action: 'revenue-account.update',
      entity: 'revenue-account',
      entityId: account.id,
      // MASKED on both sides. An audit log that records full account numbers
      // simply moves the exposure from one table to another.
      previousValue: {
        bankName: account.bankName,
        accountName: account.accountName,
        accountNumberMasked: account.accountNumberLast4 ? `••••••${account.accountNumberLast4}` : null,
        isActive: account.isActive,
      },
      newValue: {
        bankName: data.bankName ?? account.bankName,
        accountName: data.accountName ?? account.accountName,
        accountNumberMasked: newLast4 ? `••••••${newLast4}` : null,
        isActive: data.isActive ?? account.isActive,
        requiresReapproval: body.accountNumber != null,
      },
      reason,
      sodOverridden,
    });
  });

  return NextResponse.json({
    success: true,
    account: {
      id: account.id,
      code: account.code,
      accountNumberMasked: newLast4 ? maskAccountNumber(`000000${newLast4}`) : null,
    },
    // Said plainly rather than left for someone to discover: a changed
    // destination is not usable until a second person approves it (§25).
    note: body.accountNumber != null
      ? 'The account number has changed, so this destination needs approval by another finance officer before it can be settled to.'
      : undefined,
    changedBy: actor.fullName,
  });
}

// ============================================================
// /api/auth/mfa — enrolling a second factor (§42)
// ------------------------------------------------------------
// GET     where this user stands
// POST    begin enrolment — issues a secret and a QR code
// PATCH   confirm enrolment with a code from the app, and issue backup codes
// DELETE  remove MFA, which is a controlled act
//
// §42 requires MFA for anyone who can change where money is sent or approve
// money leaving, and apiGuard already refuses them every configuration route
// until they have it. This is how they get it.
//
// THREE THINGS THIS ROUTE IS CAREFUL ABOUT.
//
// ENROLMENT IS NOT COMPLETE UNTIL A CODE IS PROVED. POST issues a secret but
// leaves mfaEnabled false. If enrolment finished at that point, a user who
// mis-scanned the QR code would be locked out of their own account with a secret
// only the database knows. PATCH requires a working code first.
//
// THE SECRET IS ENCRYPTED AT REST. A TOTP secret in plaintext is a second factor
// that anyone with database access can simply compute for themselves, which is
// no second factor at all. It uses the same AES-256-GCM key as bank details.
//
// BACKUP CODES ARE SHOWN EXACTLY ONCE. They are stored hashed, so this route
// cannot show them again — which is stated plainly in the response rather than
// discovered by a finance officer who has lost their phone.
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import QRCode from 'qrcode';
import prisma from '@/lib/prisma';
import { authOptions } from '@/lib/auth';
import { readJson } from '@/lib/apiGuard';
import { recordAudit, auditContextFrom } from '@/lib/audit';
import { decryptField, encryptField, encryptionAvailable } from '@/lib/crypto';
import {
  generateBackupCodes,
  generateSecret,
  hashBackupCode,
  mfaRequiredFor,
  otpauthUri,
  verifyBackupCode,
  verifyTotp,
} from '@/lib/mfa';

export const dynamic = 'force-dynamic';

const ISSUER = 'UNTH Central Theatre Revenue';

/** The signed-in user, with their roles. MFA routes guard themselves. */
async function currentUser() {
  const session = await getServerSession(authOptions);
  const id = (session?.user as { id?: string } | undefined)?.id;
  if (!id) return null;

  return prisma.user.findUnique({
    where: { id },
    select: {
      id: true, email: true, fullName: true, status: true,
      mfaEnabled: true, mfaSecret: true, mfaLastCounter: true,
      mfaBackupCodes: true, mfaEnrolledAt: true,
      roles: { where: { isActive: true }, select: { role: true } },
    },
  });
}

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------
export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: 'Sign in to continue.', code: 'NOT_AUTHENTICATED' }, { status: 401 });

  const roles = user.roles.map((r) => r.role);

  return NextResponse.json({
    enabled: user.mfaEnabled,
    enrolledAt: user.mfaEnrolledAt,
    required: mfaRequiredFor(roles),
    backupCodesRemaining: user.mfaBackupCodes.length,
    // Said plainly, because the consequence is otherwise discovered as a 403 on
    // a screen the user was told they could use.
    note:
      mfaRequiredFor(roles) && !user.mfaEnabled
        ? 'Your role requires multi-factor authentication. Until you enrol, every configuration route will refuse you — accounts, allocation rules, beneficiaries and prices are all closed.'
        : user.mfaEnabled && user.mfaBackupCodes.length === 0
          ? 'You have no backup codes left. If you lose your phone you will need an administrator to reset your access — generate new ones.'
          : undefined,
  });
}

// ---------------------------------------------------------------------------
// POST — begin enrolment
// ---------------------------------------------------------------------------
export async function POST(request: NextRequest) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: 'Sign in to continue.', code: 'NOT_AUTHENTICATED' }, { status: 401 });

  if (user.mfaEnabled) {
    return NextResponse.json(
      {
        error: 'Multi-factor authentication is already enabled on this account. Remove it first if you are moving to a new phone.',
        code: 'ALREADY_ENABLED',
      },
      { status: 409 }
    );
  }

  if (!encryptionAvailable()) {
    // Refused rather than storing a plaintext secret: a TOTP secret in the clear
    // is not a second factor.
    return NextResponse.json(
      {
        error: 'FIELD_ENCRYPTION_KEY is not configured, so a second factor cannot be stored safely. Set it before enrolling.',
        code: 'ENCRYPTION_UNAVAILABLE',
      },
      { status: 503 }
    );
  }

  const secret = generateSecret();
  const uri = otpauthUri({ secretBase32: secret, accountName: user.email, issuer: ISSUER });

  // The secret is stored NOW but MFA stays off until a code proves the app has
  // it. Storing it later would mean holding it in a browser between requests.
  await prisma.user.update({
    where: { id: user.id },
    data: { mfaSecret: encryptField(secret), mfaLastCounter: null },
  });

  const audit = auditContextFrom(request, {
    userId: user.id, fullName: user.fullName, roles: user.roles.map((r) => r.role),
  });
  await recordAudit(prisma, audit, {
    action: 'mfa.enrolment-started',
    entity: 'user',
    entityId: user.id,
  }).catch(() => undefined);

  return NextResponse.json({
    // A data URL, so the page needs no external request to render it — this
    // application ships nothing to a third party, least of all an MFA secret.
    qrCodeDataUrl: await QRCode.toDataURL(uri, { errorCorrectionLevel: 'M', margin: 1, width: 240 }),
    // For a phone that cannot scan, or a desktop authenticator.
    manualEntryKey: secret,
    issuer: ISSUER,
    account: user.email,
    nextStep:
      'Scan this with your authenticator app, then send the six-digit code it shows to confirm. Multi-factor authentication is not active until you do.',
  });
}

// ---------------------------------------------------------------------------
// PATCH — confirm enrolment, or regenerate backup codes
// ---------------------------------------------------------------------------
interface PatchBody {
  action?: 'CONFIRM' | 'REGENERATE_BACKUP_CODES';
  code?: string;
}

export async function PATCH(request: NextRequest) {
  const parsed = await readJson<PatchBody>(request);
  if (!parsed.ok) return parsed.response;
  const { action = 'CONFIRM', code } = parsed.body;

  const user = await currentUser();
  if (!user) return NextResponse.json({ error: 'Sign in to continue.', code: 'NOT_AUTHENTICATED' }, { status: 401 });

  if (!user.mfaSecret) {
    return NextResponse.json(
      { error: 'There is no enrolment in progress. Start one first.', code: 'NO_ENROLMENT' },
      { status: 409 }
    );
  }

  let secret: string;
  try {
    secret = decryptField(user.mfaSecret);
  } catch {
    return NextResponse.json(
      {
        error: 'Your stored second factor could not be read. It may have been altered, or the encryption key may have changed. Start enrolment again.',
        code: 'SECRET_UNREADABLE',
      },
      { status: 500 }
    );
  }

  const verdict = verifyTotp({
    secretBase32: secret,
    code: code ?? '',
    lastUsedCounter: user.mfaLastCounter,
  });

  if (!verdict.valid) {
    await recordAudit(
      prisma,
      auditContextFrom(request, { userId: user.id, fullName: user.fullName, roles: user.roles.map((r) => r.role) }),
      { action: 'mfa.code-rejected', entity: 'user', entityId: user.id, reason: verdict.message ?? 'Invalid code.' }
    ).catch(() => undefined);

    return NextResponse.json({ error: verdict.message, code: verdict.code }, { status: 422 });
  }

  const audit = auditContextFrom(request, {
    userId: user.id, fullName: user.fullName, roles: user.roles.map((r) => r.role),
  });

  // --- Regenerating codes for an already-enrolled user ---------------------
  if (action === 'REGENERATE_BACKUP_CODES') {
    if (!user.mfaEnabled) {
      return NextResponse.json({ error: 'Finish enrolling first.', code: 'NOT_ENABLED' }, { status: 409 });
    }
    const codes = generateBackupCodes();
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        // Replacing the list invalidates every previously issued code, which is
        // the point: regenerating is what you do when the old ones may be known.
        data: { mfaBackupCodes: codes.map(hashBackupCode), mfaLastCounter: verdict.counter },
      });
      await recordAudit(tx, audit, {
        action: 'mfa.backup-codes-regenerated',
        entity: 'user',
        entityId: user.id,
        newValue: { count: codes.length, previousCodesInvalidated: true },
      });
    });

    return NextResponse.json({
      backupCodes: codes,
      warning: 'These replace any codes issued before. Store them somewhere safe — they cannot be shown again.',
    });
  }

  // --- Confirming enrolment -----------------------------------------------
  const codes = generateBackupCodes();

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: {
        mfaEnabled: true,
        mfaEnrolledAt: new Date(),
        mfaLastCounter: verdict.counter,
        mfaBackupCodes: codes.map(hashBackupCode),
      },
    });
    await recordAudit(tx, audit, {
      action: 'mfa.enrolled',
      entity: 'user',
      entityId: user.id,
      previousValue: { mfaEnabled: false },
      newValue: { mfaEnabled: true, backupCodesIssued: codes.length },
    });
  });

  return NextResponse.json({
    success: true,
    enabled: true,
    backupCodes: codes,
    // Stated rather than left to be discovered by somebody who has lost a phone.
    warning:
      'These backup codes are shown ONCE and are stored only as hashes — this system cannot show them to you again. Print them and keep them somewhere safe. Each works once.',
    note: 'Configuration routes are now open to you.',
  });
}

// ---------------------------------------------------------------------------
// DELETE — remove MFA
// ---------------------------------------------------------------------------
export async function DELETE(request: NextRequest) {
  const parsed = await readJson<{ code?: string; backupCode?: string; reason?: string }>(request);
  if (!parsed.ok) return parsed.response;
  const { code, backupCode, reason } = parsed.body;

  const user = await currentUser();
  if (!user) return NextResponse.json({ error: 'Sign in to continue.', code: 'NOT_AUTHENTICATED' }, { status: 401 });
  if (!user.mfaEnabled || !user.mfaSecret) {
    return NextResponse.json({ error: 'Multi-factor authentication is not enabled.', code: 'NOT_ENABLED' }, { status: 409 });
  }

  if ((reason?.trim().length ?? 0) < 10) {
    return NextResponse.json(
      { error: 'Removing a second factor needs a reason — a new phone, a lost device.', code: 'REASON_REQUIRED' },
      { status: 400 }
    );
  }

  // Removing MFA requires proving you currently hold it. Otherwise anyone who
  // sat down at an unlocked terminal could strip the protection off in one call.
  let proved = false;
  if (code) {
    const secret = decryptField(user.mfaSecret);
    proved = verifyTotp({ secretBase32: secret, code, lastUsedCounter: user.mfaLastCounter }).valid;
  } else if (backupCode) {
    proved = verifyBackupCode({ code: backupCode, hashes: user.mfaBackupCodes }).valid;
  }

  if (!proved) {
    return NextResponse.json(
      { error: 'Removing multi-factor authentication requires a current code from your authenticator, or a backup code.', code: 'PROOF_REQUIRED' },
      { status: 422 }
    );
  }

  const roles = user.roles.map((r) => r.role);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { mfaEnabled: false, mfaSecret: null, mfaLastCounter: null, mfaBackupCodes: [], mfaEnrolledAt: null },
    });
    await recordAudit(
      tx,
      auditContextFrom(request, { userId: user.id, fullName: user.fullName, roles }),
      {
        action: 'mfa.removed',
        entity: 'user',
        entityId: user.id,
        previousValue: { mfaEnabled: true },
        newValue: { mfaEnabled: false },
        reason: reason?.trim(),
      }
    );
  });

  return NextResponse.json({
    success: true,
    enabled: false,
    // The consequence, immediately, rather than as a surprise 403 later.
    note: mfaRequiredFor(roles)
      ? 'Your role requires multi-factor authentication, so configuration routes are now closed to you until you enrol again.'
      : undefined,
  });
}

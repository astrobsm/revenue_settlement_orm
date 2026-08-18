// ============================================================
// /api/settings/vendor-agreements — the levy, and the consent behind it
// ------------------------------------------------------------
// GET    agreements and their signature state
// POST   raise a new agreement, or a new version of an existing one
// PATCH  edit a draft's percentage, sign, activate, suspend or terminate
//
// The percentage a vendor pays for taking over supply of a consumable is a
// negotiated commercial term, so it is EDITABLE. What it is not is unilateral.
// The rules enforced here, all from lib/agreements.ts:
//
//   - a levy applies ONLY when hospital and vendor have both signed
//   - a signature is against a SPECIFIC percentage; if the figure moves, the
//     signature is stale and the levy stops until both sign again
//   - a percentage that has gone out for signature cannot be edited in place —
//     amending raises a NEW VERSION, and the existing agreement stays in force
//     until the replacement is signed, so supply is never left ungoverned
//
// Signing is recorded per party with the exact wording that was consented to, so
// a printed agreement years later shows what each side actually agreed.
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { guard, readJson } from '@/lib/apiGuard';
import { Permission } from '@/lib/rbac';
import { recordAudit } from '@/lib/audit';
import { nextNumber, Series } from '@/lib/numbering';
import {
  AgreementSnapshot,
  canActivate,
  checkLevyChange,
  consentStatementFor,
  levyInForce,
  signatureStatus,
} from '@/lib/agreements';

export const dynamic = 'force-dynamic';

const DUTY_AGREEMENT_CHANGED = 'ALLOCATION_RULE_CHANGED';

function toSnapshot(a: {
  id: string; levyBasisPoints: number; status: string; effectiveFrom: Date; effectiveTo: Date | null;
  coveredKinds: string[];
  signatures: { party: string; consentGiven: boolean; agreedLevyBasisPoints: number; signedAt: Date | null; revokedAt: Date | null }[];
}): AgreementSnapshot {
  return {
    id: a.id,
    levyBasisPoints: a.levyBasisPoints,
    status: a.status as AgreementSnapshot['status'],
    effectiveFrom: a.effectiveFrom,
    effectiveTo: a.effectiveTo,
    coveredKinds: a.coveredKinds as string[],
    signatures: a.signatures.map((s) => ({
      party: s.party as 'HOSPITAL' | 'VENDOR' | 'WITNESS',
      consentGiven: s.consentGiven,
      agreedLevyBasisPoints: s.agreedLevyBasisPoints,
      signedAt: s.signedAt,
      revokedAt: s.revokedAt,
    })),
  };
}

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------
export async function GET(request: NextRequest) {
  const g = await guard(request, { permission: Permission.ALLOCATION_RULE_VIEW });
  if (!g.ok) return g.response;

  const vendorId = request.nextUrl.searchParams.get('vendorId');

  const agreements = await prisma.vendorAgreement.findMany({
    where: vendorId ? { vendorId } : {},
    include: {
      vendor: { select: { id: true, code: true, name: true } },
      signatures: {
        select: {
          id: true, party: true, signatoryName: true, signatoryDesignation: true,
          consentGiven: true, agreedLevyBasisPoints: true, signedAt: true,
          revokedAt: true, revokedReason: true,
        },
      },
    },
    orderBy: [{ createdAt: 'desc' }],
  });

  return NextResponse.json({
    agreements: agreements.map((a) => {
      const snapshot = toSnapshot(a);
      const sigs = signatureStatus(snapshot);
      const inForce = levyInForce({ agreement: snapshot, chargeKind: a.coveredKinds[0] ?? 'CONSUMABLE' });

      return {
        id: a.id,
        agreementNumber: a.agreementNumber,
        vendor: a.vendor,
        title: a.title,
        status: a.status,
        levyBasisPoints: a.levyBasisPoints,
        levyPercent: a.levyBasisPoints / 100,
        coveredKinds: a.coveredKinds,
        effectiveFrom: a.effectiveFrom,
        effectiveTo: a.effectiveTo,
        signatures: a.signatures,
        signatureStatus: sigs,
        // The figure that ACTUALLY applies today, which is zero unless every
        // condition is met. Shown so nobody has to infer it from the status.
        effectiveLevyBasisPoints: inForce.basisPoints,
        effectiveLevyExplanation: inForce.reason,
        supersedesAgreementId: a.supersedesAgreementId,
        supersededById: a.supersededById,
      };
    }),
  });
}

// ---------------------------------------------------------------------------
// POST — raise an agreement, or a new version of one
// ---------------------------------------------------------------------------
interface CreateBody {
  vendorId?: string;
  levyBasisPoints?: number;
  levyAccountId?: string;
  coveredKinds?: string[];
  effectiveFrom?: string;
  effectiveTo?: string | null;
  title?: string;
  termsText?: string;
  /** Set to raise a replacement for an existing agreement. */
  supersedesAgreementId?: string;
  reason?: string;
}

export async function POST(request: NextRequest) {
  const parsed = await readJson<CreateBody>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const g = await guard(request, {
    permission: Permission.ALLOCATION_RULE_MANAGE,
    duty: DUTY_AGREEMENT_CHANGED,
    entity: 'vendor-agreement',
    entityId: body.supersedesAgreementId ?? body.vendorId ?? 'new',
  });
  if (!g.ok) return g.response;
  const { actor, audit, sodOverridden } = g;

  if (!body.vendorId || !body.levyAccountId || body.levyBasisPoints == null) {
    return NextResponse.json(
      { error: 'A vendor, a levy percentage and the account the levy is paid into are all required.', code: 'INCOMPLETE' },
      { status: 400 }
    );
  }

  const check = checkLevyChange({
    status: 'DRAFT',
    currentBasisPoints: -1, // a new agreement has no previous figure
    newBasisPoints: body.levyBasisPoints,
    reason: body.reason ?? 'New supply agreement.',
  });
  if (!check.allowed && check.code === 'INVALID_SHARE') {
    return NextResponse.json({ error: check.message, code: check.code }, { status: 400 });
  }

  const vendor = await prisma.vendor.findUnique({ where: { id: body.vendorId } });
  if (!vendor) return NextResponse.json({ error: 'Vendor not found.', code: 'NOT_FOUND' }, { status: 404 });

  const created = await prisma.$transaction(async (tx) => {
    const agreementNumber = await nextNumber(tx, Series.AGREEMENT);

    const agreement = await tx.vendorAgreement.create({
      data: {
        agreementNumber,
        vendorId: vendor.id,
        levyBasisPoints: body.levyBasisPoints as number,
        levyAccountId: body.levyAccountId as string,
        coveredKinds: (body.coveredKinds ?? ['CONSUMABLE']) as never,
        title: body.title ?? `Supply agreement — ${vendor.name}`,
        termsText: body.termsText ?? null,
        effectiveFrom: body.effectiveFrom ? new Date(body.effectiveFrom) : new Date(),
        effectiveTo: body.effectiveTo ? new Date(body.effectiveTo) : null,
        supersedesAgreementId: body.supersedesAgreementId ?? null,
        status: 'DRAFT',
        createdById: actor.userId,
      },
    });

    // A replacement is LINKED to the old agreement but does NOT close it. The
    // existing terms stay in force until the new ones are signed — otherwise an
    // amendment would leave supply ungoverned in the gap, and a vendor could be
    // paid under no agreement at all while the paperwork went round.
    if (body.supersedesAgreementId) {
      await tx.vendorAgreement.update({
        where: { id: body.supersedesAgreementId },
        data: { supersededById: agreement.id },
      });
    }

    await recordAudit(tx, audit, {
      duty: DUTY_AGREEMENT_CHANGED,
      action: body.supersedesAgreementId ? 'vendor-agreement.supersede' : 'vendor-agreement.create',
      entity: 'vendor-agreement',
      entityId: agreement.id,
      newValue: {
        agreementNumber,
        vendor: vendor.name,
        levyBasisPoints: body.levyBasisPoints,
        coveredKinds: body.coveredKinds ?? ['CONSUMABLE'],
        supersedes: body.supersedesAgreementId ?? null,
      },
      reason: body.reason ?? null,
      sodOverridden,
    });

    return agreement;
  });

  return NextResponse.json(
    {
      success: true,
      agreement: {
        id: created.id,
        agreementNumber: created.agreementNumber,
        status: created.status,
        levyBasisPoints: created.levyBasisPoints,
        levyPercent: created.levyBasisPoints / 100,
      },
      consentStatements: {
        HOSPITAL: consentStatementFor({ party: 'HOSPITAL', vendorName: vendor.name, levyBasisPoints: created.levyBasisPoints, coveredKinds: created.coveredKinds as string[] }),
        VENDOR: consentStatementFor({ party: 'VENDOR', vendorName: vendor.name, levyBasisPoints: created.levyBasisPoints, coveredKinds: created.coveredKinds as string[] }),
      },
      note: 'No levy is taken until BOTH the hospital and the vendor have signed this agreement at this percentage.',
    },
    { status: 201 }
  );
}

// ---------------------------------------------------------------------------
// PATCH — edit a draft, sign, activate, suspend, terminate
// ---------------------------------------------------------------------------
interface PatchBody {
  id?: string;
  action?: 'SET_LEVY' | 'SEND_FOR_SIGNATURE' | 'SIGN' | 'ACTIVATE' | 'SUSPEND' | 'TERMINATE' | 'REVOKE_SIGNATURE';
  levyBasisPoints?: number;
  reason?: string;
  /** For SIGN. */
  party?: 'HOSPITAL' | 'VENDOR' | 'WITNESS';
  signatoryName?: string;
  signatoryDesignation?: string;
  signatoryEmail?: string;
  signatureDataUrl?: string;
  consentGiven?: boolean;
}

export async function PATCH(request: NextRequest) {
  const parsed = await readJson<PatchBody>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  if (!body.id || !body.action) {
    return NextResponse.json({ error: 'An agreement and an action are required.', code: 'INCOMPLETE' }, { status: 400 });
  }

  const g = await guard(request, {
    permission: Permission.ALLOCATION_RULE_MANAGE,
    duty: DUTY_AGREEMENT_CHANGED,
    entity: 'vendor-agreement',
    entityId: body.id,
  });
  if (!g.ok) return g.response;
  const { actor, audit, sodOverridden } = g;

  const agreement = await prisma.vendorAgreement.findUnique({
    where: { id: body.id },
    include: { vendor: true, signatures: true },
  });
  if (!agreement) return NextResponse.json({ error: 'Agreement not found.', code: 'NOT_FOUND' }, { status: 404 });

  const snapshot = toSnapshot(agreement);

  switch (body.action) {
    // --- Change the percentage -------------------------------------------
    case 'SET_LEVY': {
      if (body.levyBasisPoints == null) {
        return NextResponse.json({ error: 'What percentage?', code: 'LEVY_REQUIRED' }, { status: 400 });
      }
      const verdict = checkLevyChange({
        status: snapshot.status,
        currentBasisPoints: agreement.levyBasisPoints,
        newBasisPoints: body.levyBasisPoints,
        reason: body.reason,
      });
      if (!verdict.allowed) {
        return NextResponse.json({ error: verdict.message, code: verdict.code }, { status: 409 });
      }
      if (verdict.requiresNewVersion) {
        // Refused as an EDIT, with the correct route named. Changing a signed
        // figure in place would mean the vendor signed one number while another
        // is applied to their money.
        return NextResponse.json(
          {
            error: verdict.message,
            code: 'REQUIRES_NEW_VERSION',
            nextStep: {
              method: 'POST',
              path: '/api/settings/vendor-agreements',
              body: {
                vendorId: agreement.vendorId,
                levyBasisPoints: body.levyBasisPoints,
                levyAccountId: agreement.levyAccountId,
                coveredKinds: agreement.coveredKinds,
                supersedesAgreementId: agreement.id,
                reason: body.reason,
              },
            },
          },
          { status: 409 }
        );
      }

      await prisma.$transaction(async (tx) => {
        await tx.vendorAgreement.update({
          where: { id: agreement.id },
          data: { levyBasisPoints: body.levyBasisPoints as number },
        });
        await recordAudit(tx, audit, {
          duty: DUTY_AGREEMENT_CHANGED,
          action: 'vendor-agreement.set-levy',
          entity: 'vendor-agreement',
          entityId: agreement.id,
          previousValue: { levyBasisPoints: agreement.levyBasisPoints },
          newValue: { levyBasisPoints: body.levyBasisPoints },
          reason: body.reason ?? null,
          sodOverridden,
        });
      });

      return NextResponse.json({
        success: true,
        levyBasisPoints: body.levyBasisPoints,
        levyPercent: (body.levyBasisPoints as number) / 100,
        consentStatements: {
          HOSPITAL: consentStatementFor({ party: 'HOSPITAL', vendorName: agreement.vendor.name, levyBasisPoints: body.levyBasisPoints, coveredKinds: agreement.coveredKinds as string[] }),
          VENDOR: consentStatementFor({ party: 'VENDOR', vendorName: agreement.vendor.name, levyBasisPoints: body.levyBasisPoints, coveredKinds: agreement.coveredKinds as string[] }),
        },
      });
    }

    // --- Freeze the figure and collect signatures -------------------------
    case 'SEND_FOR_SIGNATURE': {
      if (agreement.status !== 'DRAFT') {
        return NextResponse.json({ error: 'Only a draft can be sent for signature.', code: 'BAD_STATUS' }, { status: 409 });
      }
      await prisma.$transaction(async (tx) => {
        await tx.vendorAgreement.update({ where: { id: agreement.id }, data: { status: 'AWAITING_SIGNATURES' } });
        await recordAudit(tx, audit, {
          duty: DUTY_AGREEMENT_CHANGED,
          action: 'vendor-agreement.send-for-signature',
          entity: 'vendor-agreement',
          entityId: agreement.id,
          newValue: { status: 'AWAITING_SIGNATURES', levyBasisPoints: agreement.levyBasisPoints },
          reason: body.reason ?? null,
          sodOverridden,
        });
      });
      return NextResponse.json({
        success: true,
        status: 'AWAITING_SIGNATURES',
        note: 'The percentage is now frozen. Changing it requires a new version that both parties sign.',
      });
    }

    // --- One party signs ---------------------------------------------------
    case 'SIGN': {
      if (!body.party || !body.signatoryName?.trim()) {
        return NextResponse.json({ error: 'Which party is signing, and who are they?', code: 'SIGNATORY_REQUIRED' }, { status: 400 });
      }
      if (body.consentGiven !== true) {
        // A signature image without explicit consent is not agreement. The two
        // are recorded separately on purpose: one proves who, the other proves
        // they were shown the terms and accepted them.
        return NextResponse.json(
          { error: 'Consent must be given explicitly. A signature without it does not record agreement to the terms.', code: 'CONSENT_REQUIRED' },
          { status: 400 }
        );
      }
      if (!['DRAFT', 'AWAITING_SIGNATURES'].includes(agreement.status)) {
        return NextResponse.json({ error: `A ${agreement.status.toLowerCase()} agreement cannot be signed.`, code: 'BAD_STATUS' }, { status: 409 });
      }

      const statement = consentStatementFor({
        party: body.party,
        vendorName: agreement.vendor.name,
        levyBasisPoints: agreement.levyBasisPoints,
        coveredKinds: agreement.coveredKinds as string[],
      });

      const forwarded = request.headers.get('x-forwarded-for');
      const ip = forwarded ? forwarded.split(',')[0].trim() : request.headers.get('x-real-ip');

      await prisma.$transaction(async (tx) => {
        await tx.agreementSignature.upsert({
          where: { agreementId_party: { agreementId: agreement.id, party: body.party as never } },
          update: {
            signatoryName: body.signatoryName as string,
            signatoryDesignation: body.signatoryDesignation ?? null,
            signatoryEmail: body.signatoryEmail ?? null,
            signatureDataUrl: body.signatureDataUrl ?? null,
            // Captured at the moment of signing, so an amendment later still
            // shows the figure THIS person consented to.
            agreedLevyBasisPoints: agreement.levyBasisPoints,
            consentStatement: statement,
            consentGiven: true,
            signedByUserId: body.party === 'HOSPITAL' ? actor.userId : null,
            signedAt: new Date(),
            revokedAt: null,
            revokedReason: null,
            ipAddress: ip,
          },
          create: {
            agreementId: agreement.id,
            party: body.party as never,
            signatoryName: body.signatoryName as string,
            signatoryDesignation: body.signatoryDesignation ?? null,
            signatoryEmail: body.signatoryEmail ?? null,
            signatureDataUrl: body.signatureDataUrl ?? null,
            agreedLevyBasisPoints: agreement.levyBasisPoints,
            consentStatement: statement,
            consentGiven: true,
            signedByUserId: body.party === 'HOSPITAL' ? actor.userId : null,
            ipAddress: ip,
          },
        });

        await recordAudit(tx, audit, {
          duty: DUTY_AGREEMENT_CHANGED,
          action: 'vendor-agreement.sign',
          entity: 'vendor-agreement',
          entityId: agreement.id,
          newValue: {
            party: body.party,
            signatory: body.signatoryName,
            agreedLevyBasisPoints: agreement.levyBasisPoints,
          },
          reason: body.reason ?? null,
          sodOverridden,
        });
      });

      const refreshed = await prisma.vendorAgreement.findUnique({
        where: { id: agreement.id },
        include: { signatures: true },
      });
      const status = signatureStatus(toSnapshot(refreshed as never));

      return NextResponse.json({
        success: true,
        signatureStatus: status,
        readyToActivate: status.complete,
        note: status.complete
          ? 'Both parties have signed. The agreement can now be activated, and the levy will apply from its effective date.'
          : status.message,
      });
    }

    // --- Bring it into force ----------------------------------------------
    case 'ACTIVATE': {
      const verdict = canActivate(snapshot);
      if (!verdict.allowed) {
        return NextResponse.json({ error: verdict.message, code: verdict.code }, { status: 409 });
      }

      await prisma.$transaction(async (tx) => {
        await tx.vendorAgreement.update({
          where: { id: agreement.id },
          data: { status: 'ACTIVE', activatedAt: new Date(), activatedById: actor.userId },
        });

        // Closing the agreement this one replaces, now that the replacement is
        // genuinely in force — never before.
        if (agreement.supersedesAgreementId) {
          await tx.vendorAgreement.update({
            where: { id: agreement.supersedesAgreementId },
            data: { status: 'SUPERSEDED', supersededAt: new Date(), effectiveTo: new Date() },
          });
        }

        await recordAudit(tx, audit, {
          duty: DUTY_AGREEMENT_CHANGED,
          action: 'vendor-agreement.activate',
          entity: 'vendor-agreement',
          entityId: agreement.id,
          previousValue: { status: agreement.status },
          newValue: { status: 'ACTIVE', levyBasisPoints: agreement.levyBasisPoints, supersededAgreement: agreement.supersedesAgreementId },
          reason: body.reason ?? null,
          sodOverridden,
        });
      });

      return NextResponse.json({
        success: true,
        status: 'ACTIVE',
        levyPercent: agreement.levyBasisPoints / 100,
        note: `A ${agreement.levyBasisPoints / 100}% levy now applies to this vendor's covered supplies, deducted as each payment is allocated.`,
      });
    }

    case 'SUSPEND':
    case 'TERMINATE': {
      const reason = body.reason?.trim() ?? '';
      if (reason.length < 10) {
        return NextResponse.json({ error: 'Give a reason.', code: 'REASON_REQUIRED' }, { status: 400 });
      }
      const isSuspend = body.action === 'SUSPEND';
      const status = isSuspend ? 'SUSPENDED' : 'TERMINATED';

      await prisma.$transaction(async (tx) => {
        await tx.vendorAgreement.update({
          where: { id: agreement.id },
          data: {
            status: status as never,
            ...(status === 'TERMINATED'
              ? { terminatedAt: new Date(), terminatedById: actor.userId, terminationReason: reason, effectiveTo: new Date() }
              : {}),
          },
        });
        await recordAudit(tx, audit, {
          duty: DUTY_AGREEMENT_CHANGED,
          action: isSuspend ? 'vendor-agreement.suspend' : 'vendor-agreement.terminate',
          entity: 'vendor-agreement',
          entityId: agreement.id,
          previousValue: { status: agreement.status },
          newValue: { status },
          reason,
          sodOverridden,
        });
      });

      return NextResponse.json({
        success: true,
        status,
        note: 'No levy will be taken while the agreement is not active; the vendor is paid in full.',
      });
    }

    case 'REVOKE_SIGNATURE': {
      const reason = body.reason?.trim() ?? '';
      if (!body.party || reason.length < 10) {
        return NextResponse.json({ error: 'Which party, and why?', code: 'INCOMPLETE' }, { status: 400 });
      }

      await prisma.$transaction(async (tx) => {
        // Revoked, never deleted: the record must still show that consent was
        // given and then withdrawn.
        await tx.agreementSignature.update({
          where: { agreementId_party: { agreementId: agreement.id, party: body.party as never } },
          data: { revokedAt: new Date(), revokedReason: reason },
        });
        // Withdrawn consent stops the levy immediately.
        if (agreement.status === 'ACTIVE') {
          await tx.vendorAgreement.update({ where: { id: agreement.id }, data: { status: 'SUSPENDED' } });
        }
        await recordAudit(tx, audit, {
          duty: DUTY_AGREEMENT_CHANGED,
          action: 'vendor-agreement.revoke-signature',
          entity: 'vendor-agreement',
          entityId: agreement.id,
          newValue: { party: body.party, revoked: true },
          reason,
          sodOverridden,
        });
      });

      return NextResponse.json({
        success: true,
        note: 'Consent has been withdrawn and the agreement suspended. No levy will be taken until it is signed again.',
      });
    }

    default:
      return NextResponse.json({ error: `Unknown action ${body.action}.`, code: 'BAD_ACTION' }, { status: 400 });
  }
}

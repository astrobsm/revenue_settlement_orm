// ============================================================
// The route guard (§24, §25, §37, §42)
// ------------------------------------------------------------
// Every financial route begins here. THIS IS THE SECURITY BOUNDARY. The UI reads
// the same permission matrix only to avoid offering controls that will fail; a
// hidden button is a courtesy and never a control, and §55 is explicit that
// nobody may bypass a financial control by modifying the frontend.
//
// The guard answers three questions, in order, and the third is the one most
// systems never ask:
//
//   1. WHO is this?                      — an active session, a live account
//   2. MAY THIS ROLE do this at all?     — the permission matrix
//   3. MAY THIS PERSON do it TO THIS RECORD? — separation of duties, read from
//                                              the record's own audit history
//
// Question 3 cannot be answered by a permission check, because permissions have
// no memory. A cashier holding payment:confirm is unremarkable; the same cashier
// confirming a payment against an invoice whose price THEY overrode is a fraud
// with no third party in it. Only the audit trail can see that.
// ============================================================

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from './auth';
import prisma from './prisma';
import { can, checkSeparationOfDuties, PermissionValue, RevenueRole } from './rbac';
import { auditContextFrom, AuditContext, priorActsFor, recordAudit } from './audit';

export interface Actor {
  userId: string;
  fullName: string;
  roles: RevenueRole[];
  mfaEnabled: boolean;
  sessionId?: string;
}

export type GuardResult =
  | { ok: true; actor: Actor; audit: AuditContext; sodOverridden: boolean }
  | { ok: false; response: NextResponse };

function deny(status: number, error: string, code: string): { ok: false; response: NextResponse } {
  return { ok: false, response: NextResponse.json({ error, code }, { status }) };
}

/** Roles that §42 requires to hold MFA before they may touch configuration. */
const MFA_REQUIRED_ROLES: RevenueRole[] = ['FINANCE_ADMINISTRATOR', 'SUPER_ADMINISTRATOR'];

/**
 * Guard a route.
 *
 * Pass `duty`, `entity` and `entityId` for any act §25 names — confirming a
 * payment, approving a refund, changing an allocation rule. Omitting them for
 * such an act silently disables the separation-of-duties check, which is why the
 * duties are a closed set in lib/audit.ts rather than free text.
 */
export async function guard(
  request: Request,
  params: {
    permission: PermissionValue;
    duty?: string;
    entity?: string;
    entityId?: string;
    /** The invoice a payment or refund belongs to, so its history counts too. */
    invoiceId?: string | null;
  }
): Promise<GuardResult> {
  // --- 1. Who is this? -----------------------------------------------------
  const session = await getServerSession(authOptions);
  const sessionUser = session?.user as { id?: string } | undefined;

  if (!sessionUser?.id) {
    // 401 is kept distinct from 403 deliberately: telling a signed-in user with
    // the wrong role to sign in again sends them round in circles.
    return deny(401, 'Sign in to continue.', 'NOT_AUTHENTICATED');
  }

  // The session is a claim about who the user WAS at sign-in. Roles and status
  // are re-read from the database on every request, so revoking a role or
  // suspending an account takes effect immediately rather than whenever the
  // token happens to expire.
  const user = await prisma.user.findUnique({
    where: { id: sessionUser.id },
    select: {
      id: true, fullName: true, status: true, mfaEnabled: true,
      roles: { where: { isActive: true }, select: { role: true } },
    },
  });

  if (!user) return deny(401, 'This account no longer exists.', 'NO_SUCH_USER');
  if (user.status !== 'ACTIVE') {
    return deny(403, `This account is ${user.status.toLowerCase()} and cannot be used.`, 'ACCOUNT_INACTIVE');
  }

  const roles = user.roles.map((r) => r.role) as RevenueRole[];
  if (roles.length === 0) {
    return deny(403, 'This account has no role assigned, so it can do nothing yet.', 'NO_ROLE');
  }

  const actor: Actor = {
    userId: user.id,
    fullName: user.fullName,
    roles,
    mfaEnabled: user.mfaEnabled,
    sessionId: (session as { sessionId?: string } | null)?.sessionId,
  };
  const audit = auditContextFrom(request, actor);

  // --- 2. May this role do this at all? ------------------------------------
  if (!can(roles, params.permission)) {
    // A refused attempt is itself worth recording: repeated 403s against
    // payment:confirm is what an attack looks like from the inside.
    await recordAudit(prisma, audit, {
      action: 'access.denied',
      entity: params.entity ?? 'route',
      entityId: params.entityId ?? null,
      reason: `Role does not hold ${params.permission}.`,
      newValue: { permission: params.permission },
    }).catch(() => undefined);

    return deny(403, `Your role does not allow you to ${params.permission.replace(':', ' ')}.`, 'FORBIDDEN');
  }

  // --- 2b. MFA for financial administration (§42) --------------------------
  if (!user.mfaEnabled && roles.some((r) => MFA_REQUIRED_ROLES.includes(r))) {
    return deny(
      403,
      'Financial administration requires multi-factor authentication. Enrol a second factor before configuring accounts, rules or prices.',
      'MFA_REQUIRED'
    );
  }

  // --- 3. May this PERSON act on THIS record? ------------------------------
  let sodOverridden = false;

  if (params.duty && params.entity && params.entityId) {
    const priorActs = await priorActsFor(prisma, {
      entity: params.entity,
      entityId: params.entityId,
      alsoInvoiceId: params.invoiceId ?? null,
    });

    const policy = await prisma.organisationSetting.findUnique({ where: { key: 'SOD_ALLOW_SINGLE_OPERATOR' } });
    const policyAllowsSelfService = policy?.value === 'true';

    const verdict = checkSeparationOfDuties({
      userId: actor.userId,
      duty: params.duty,
      priorActs,
      policyAllowsSelfService,
    });

    if (!verdict.allowed) {
      await recordAudit(prisma, audit, {
        action: 'access.denied.separation-of-duties',
        entity: params.entity,
        entityId: params.entityId,
        invoiceId: params.invoiceId ?? null,
        reason: verdict.message ?? 'Separation of duties.',
        newValue: { duty: params.duty, conflictingDuty: verdict.conflictingDuty },
      }).catch(() => undefined);

      return deny(409, verdict.message ?? 'Separation of duties prevents this.', verdict.code ?? 'SEPARATION_OF_DUTIES');
    }

    if (verdict.code === 'SOD_OVERRIDDEN') {
      // Permitted under the single-operator policy — but it MUST be recorded,
      // and the caller passes this through to the audit row for the act itself.
      sodOverridden = true;
    }
  }

  return { ok: true, actor, audit, sodOverridden };
}

/** Parse a JSON body, or produce the 400 rather than throwing into a 500. */
export async function readJson<T>(request: Request): Promise<{ ok: true; body: T } | { ok: false; response: NextResponse }> {
  try {
    return { ok: true, body: (await request.json()) as T };
  } catch {
    return { ok: false, response: NextResponse.json({ error: 'Invalid request body.', code: 'BAD_JSON' }, { status: 400 }) };
  }
}

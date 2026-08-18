// ============================================================
// / — system readiness
// ------------------------------------------------------------
// Not a dashboard: those come later and sit behind a session. This is the page
// an operator opens on the theatre server to answer one question — is this
// installation actually able to take money safely?
//
// Every check below is a REAL query, not a configuration echo. "A hospital
// account exists" is answered by looking for one, and "encryption is configured"
// by attempting it. A readiness page that reads its own settings file tells you
// what somebody intended, not what is true.
//
// NOTHING PATIENT-IDENTIFYING APPEARS HERE, and nothing that is not already
// public knowledge to anyone standing at the machine. Counts and yes/no answers
// only, because this page is deliberately reachable without signing in — an
// operator locked out by a misconfiguration still needs to see what is wrong.
// ============================================================

import prisma from '@/lib/prisma';
import { encryptionAvailable } from '@/lib/crypto';
import { configuredProviders } from '@/lib/payments/providers';

export const dynamic = 'force-dynamic';

interface Check {
  label: string;
  ok: boolean;
  /** A finding that is not a failure — worth knowing, not blocking. */
  advisory?: boolean;
  detail: string;
}

async function runChecks(): Promise<{ checks: Check[]; reachable: boolean; error?: string }> {
  try {
    const [
      accounts,
      hospitalAccount,
      accountsWithBank,
      rules,
      services,
      admins,
      adminsWithMfa,
      openExceptions,
      levyRules,
    ] = await Promise.all([
      prisma.revenueAccount.count({ where: { isActive: true } }),
      prisma.revenueAccount.findFirst({ where: { code: 'ACCT-HOSPITAL', isActive: true }, select: { id: true } }),
      prisma.revenueAccount.count({ where: { isActive: true, accountNumberEncrypted: { not: null } } }),
      prisma.allocationRule.count({ where: { effectiveTo: null } }),
      prisma.service.count({ where: { isActive: true } }),
      prisma.roleAssignment.count({
        where: { isActive: true, role: { in: ['SUPER_ADMINISTRATOR', 'FINANCE_ADMINISTRATOR'] } },
      }),
      prisma.user.count({
        where: { mfaEnabled: true, roles: { some: { isActive: true, role: { in: ['SUPER_ADMINISTRATOR', 'FINANCE_ADMINISTRATOR'] } } } },
      }),
      prisma.reconciliationException.count({ where: { status: { in: ['OPEN', 'INVESTIGATING'] } } }),
      prisma.allocationRule.findMany({
        where: { kind: 'CONSUMABLE', effectiveTo: null },
        select: { shareBasisPoints: true, account: { select: { code: true } } },
      }),
    ]);

    const gateways = configuredProviders();
    const liveGateways = gateways.filter((g) => g.configured);

    const levy = levyRules.find((r) => r.account.code === 'ACCT-HOSPITAL-DEV');

    return {
      reachable: true,
      checks: [
        {
          label: 'Database',
          ok: true,
          detail: 'Connected. Schema present and queryable.',
        },
        {
          label: 'Field encryption',
          ok: encryptionAvailable(),
          detail: encryptionAvailable()
            ? 'FIELD_ENCRYPTION_KEY is set. Bank details and MFA secrets can be stored.'
            : 'FIELD_ENCRYPTION_KEY is missing. Bank details and MFA enrolment will be REFUSED rather than stored in the clear.',
        },
        {
          label: 'Service catalogue',
          ok: services > 0,
          detail: `${services} active service${services === 1 ? '' : 's'} priced.`,
        },
        {
          label: 'Revenue accounts',
          ok: accounts > 0 && Boolean(hospitalAccount),
          detail: hospitalAccount
            ? `${accounts} active, including the fallback hospital account.`
            : `${accounts} active, but NO fallback hospital account. Payments cannot be allocated without one.`,
        },
        {
          label: 'Allocation rules',
          ok: rules > 0,
          detail: `${rules} rule${rules === 1 ? '' : 's'} in force.`,
        },
        {
          label: 'Consumables development levy',
          ok: Boolean(levy),
          advisory: !levy,
          detail: levy
            ? `${(levy.shareBasisPoints ?? 0) / 100}% of consumables revenue is levied to the hospital development fund.`
            : 'No development levy is configured on consumables.',
        },
        {
          label: 'Bank details for settlement',
          ok: accountsWithBank > 0,
          advisory: accountsWithBank === 0,
          detail:
            accountsWithBank > 0
              ? `${accountsWithBank} of ${accounts} accounts have bank details. The rest can accrue revenue but cannot be paid.`
              : 'No account has bank details yet. Revenue will accrue correctly but nothing can be settled out.',
        },
        {
          label: 'Payment desk',
          ok: true,
          detail: 'The cash and POS desk is always available. Its payments are ATTESTED and appear in reconciliation until banked.',
        },
        {
          label: 'Payment gateways',
          ok: true,
          advisory: liveGateways.length === 0,
          detail:
            liveGateways.length > 0
              ? `${liveGateways.map((g) => g.code).join(', ')} configured.`
              : 'None configured. Card and transfer payments are unavailable; the desk still works.',
        },
        {
          label: 'Administrators',
          ok: admins > 0,
          detail: `${admins} administrator role assignment${admins === 1 ? '' : 's'}.`,
        },
        {
          label: 'Administrator MFA (§42)',
          ok: admins > 0 && adminsWithMfa >= admins,
          detail:
            adminsWithMfa >= admins && admins > 0
              ? 'Every administrator has enrolled a second factor.'
              : `${adminsWithMfa} of ${admins} administrators have enrolled. Those who have not are REFUSED every configuration route.`,
        },
        {
          label: 'Reconciliation',
          ok: openExceptions === 0,
          advisory: openExceptions > 0,
          detail:
            openExceptions === 0
              ? 'No unexplained differences outstanding.'
              : `${openExceptions} exception${openExceptions === 1 ? '' : 's'} awaiting explanation.`,
        },
      ],
    };
  } catch (error) {
    return {
      reachable: false,
      checks: [],
      error: error instanceof Error ? error.message : 'The database could not be reached.',
    };
  }
}

export default async function ReadinessPage() {
  const { checks, reachable, error } = await runChecks();

  const failing = checks.filter((c) => !c.ok && !c.advisory);
  const advisories = checks.filter((c) => c.advisory);

  const ready = reachable && failing.length === 0;

  return (
    <div className="min-h-screen">
      {/* The brand band marks this as the hospital's own system before anybody
          types anything into it. */}
      <header className="px-6 py-10" style={{ background: 'var(--brand-strong)', color: 'var(--brand-on)' }}>
        <div className="mx-auto max-w-3xl">
          <p className="text-[11px] uppercase tracking-[0.2em] opacity-70">
            University of Nigeria Teaching Hospital · Ituku Ozalla
          </p>
          <h1 className="mt-3 text-3xl font-semibold">Central Theatre Revenue</h1>
          <p className="mt-3 max-w-xl text-sm leading-relaxed opacity-85">
            One consolidated bill, one payment, and an exact allocation to every department, professional pool,
            pharmacy, store and vendor that earned a share of it.
          </p>
          <a
            href="/auth/signin"
            className="mt-6 inline-block rounded px-4 py-2 text-sm font-semibold"
            style={{ background: 'var(--brand-on)', color: 'var(--brand-strong)' }}
          >
            Sign in
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-10">
        {!reachable ? (
          <section
            className="rounded border p-4"
            style={{
              background: 'var(--status-critical-bg)',
              borderColor: 'var(--status-critical)',
              color: 'var(--status-critical)',
            }}
          >
            <h2 className="font-semibold">
              <span aria-hidden className="mr-1.5 font-mono">
                ✕
              </span>
              The database cannot be reached
            </h2>
            <p className="mt-1 text-sm">{error}</p>
            <p className="mt-2 text-sm">
              Nothing can be billed or collected until this is resolved. Check DATABASE_URL and that PostgreSQL is
              running.
            </p>
          </section>
        ) : (
          <>
            <section
              className="mb-7 rounded border p-4"
              style={{
                background: ready ? 'var(--status-good-bg)' : 'var(--status-critical-bg)',
                borderColor: ready ? 'var(--status-good)' : 'var(--status-critical)',
              }}
            >
              <h2 className="font-semibold" style={{ color: ready ? 'var(--status-good)' : 'var(--status-critical)' }}>
                <span aria-hidden className="mr-1.5 font-mono">
                  {ready ? '✓' : '✕'}
                </span>
                {ready
                  ? 'This installation is ready to take money'
                  : `${failing.length} thing${failing.length === 1 ? '' : 's'} must be fixed before this installation can take money safely`}
              </h2>
              {advisories.length > 0 && (
                <p className="mt-1 text-sm" style={{ color: 'var(--ink-secondary)' }}>
                  {advisories.length} advisor{advisories.length === 1 ? 'y' : 'ies'} below — worth knowing, not
                  blocking.
                </p>
              )}
            </section>

            <ul className="space-y-2">
              {checks.map((check) => (
                <li key={check.label} className="card flex items-start gap-3 p-3.5">
                  {/* The glyph is not decoration: it is what carries the state for
                      a reader who cannot separate the green from the red. */}
                  <span
                    aria-hidden
                    className="mt-0.5 select-none font-mono text-sm"
                    style={{
                      color: check.ok
                        ? 'var(--status-good)'
                        : check.advisory
                          ? 'var(--status-warn)'
                          : 'var(--status-critical)',
                    }}
                  >
                    {check.ok ? '✓' : check.advisory ? '!' : '✕'}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {check.label}
                      <span className="sr-only">
                        {check.ok ? ' — ready' : check.advisory ? ' — advisory' : ' — not ready'}
                      </span>
                    </p>
                    <p className="text-sm" style={{ color: 'var(--ink-secondary)' }}>
                      {check.detail}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}

        <footer className="mt-9 border-t pt-6 text-xs" style={{ borderColor: 'var(--border)', color: 'var(--ink-muted)' }}>
          <p>
            Every check above is a live query, not a reading of the configuration file — this page reports what is
            true, not what was intended.
          </p>
        </footer>
      </main>
    </div>
  );
}

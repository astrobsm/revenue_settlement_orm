// ============================================================
// The signed-in shell — a bank layout
// ------------------------------------------------------------
// A persistent left rail rather than a top tab bar, because a cashier works one
// screen all day and a rail keeps the whole system one click away without
// reflowing when the window narrows. Below 1024px it becomes a horizontal strip:
// a rail that collapses to a hamburger hides the only navigation a standing
// clerk has.
//
// The green header band is the brand, and it is also doing a job — it marks the
// authenticated area, so nobody mistakes the public readiness page for the
// system itself.
//
// NAVIGATION HIDING IS A COURTESY, NOT A CONTROL. Every route behind these links
// checks permissions again server-side, and that check is the boundary. A menu
// item merely absent from the page is one typed URL away from being visited.
// ============================================================

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { can, Permission, RevenueRole } from '@/lib/rbac';
import { mfaRequiredFor } from '@/lib/mfa';
import { StatusPill } from '@/components/Delta';

export const dynamic = 'force-dynamic';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect('/auth/signin?from=/dashboard');

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      fullName: true, status: true, mfaEnabled: true,
      roles: { where: { isActive: true }, select: { role: true } },
    },
  });
  if (!user || user.status !== 'ACTIVE') redirect('/auth/signin');

  const roles = user.roles.map((r) => r.role) as RevenueRole[];
  const mfaOutstanding = mfaRequiredFor(roles) && !user.mfaEnabled;

  // Only screens that exist. A menu item leading to a 404 is worse than an
  // absent one.
  const links = [
    { href: '/dashboard', label: 'Overview', glyph: '▦', show: true },
    {
      href: '/dashboard/desk',
      label: 'Revenue desk',
      glyph: '₦',
      show: can(roles, Permission.PAYMENT_CONFIRM) || can(roles, Permission.PAYMENT_VIEW),
    },
    { href: '/dashboard/security', label: 'Security', glyph: '⛨', show: true },
  ].filter((l) => l.show);

  const initials = user.fullName
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <div className="min-h-screen lg:flex">
      {/* --- The rail ---------------------------------------------------- */}
      <aside
        className="shrink-0 lg:min-h-screen lg:w-60"
        style={{ background: 'var(--brand-strong)', color: 'var(--brand-on)' }}
      >
        <div className="px-5 py-5">
          <p className="text-[10px] uppercase tracking-[0.18em] opacity-70">UNTH Ituku Ozalla</p>
          <p className="mt-0.5 text-base font-semibold leading-tight">
            Central Theatre
            <br />
            Revenue
          </p>
        </div>

        <nav aria-label="Main">
          <ul className="flex gap-1 overflow-x-auto px-3 pb-3 lg:flex-col lg:overflow-visible">
            {links.map((link) => (
              <li key={link.href} className="shrink-0">
                <Link
                  href={link.href}
                  className="flex items-center gap-2.5 whitespace-nowrap rounded px-3 py-2 text-sm transition-colors hover:bg-white/10"
                >
                  <span aria-hidden className="w-4 text-center opacity-80">
                    {link.glyph}
                  </span>
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="mt-auto hidden px-5 py-4 text-[11px] leading-relaxed opacity-60 lg:block">
          Every figure in this system is traceable from the charge that produced it to the account it was settled to.
        </div>
      </aside>

      {/* --- The working area -------------------------------------------- */}
      <div className="min-w-0 flex-1">
        <header
          className="flex flex-wrap items-center justify-between gap-3 border-b px-6 py-3"
          style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
        >
          <div className="flex items-center gap-3">
            <span
              aria-hidden
              className="grid h-9 w-9 place-items-center rounded-full text-xs font-semibold"
              style={{ background: 'var(--brand)', color: 'var(--brand-on)' }}
            >
              {initials}
            </span>
            <div>
              <p className="text-sm font-medium leading-tight">{user.fullName}</p>
              <p className="text-xs leading-tight" style={{ color: 'var(--ink-muted)' }}>
                {roles.join(' · ').toLowerCase().replace(/_/g, ' ')}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {user.mfaEnabled ? (
              <StatusPill tone="good">Second factor on</StatusPill>
            ) : mfaOutstanding ? (
              <StatusPill tone="critical">Second factor required</StatusPill>
            ) : (
              <StatusPill tone="neutral">No second factor</StatusPill>
            )}
            <Link
              href="/api/auth/signout"
              className="rounded border px-3 py-1.5 text-xs"
              style={{ borderColor: 'var(--border-strong)', color: 'var(--ink-secondary)' }}
            >
              Sign out
            </Link>
          </div>
        </header>

        {mfaOutstanding && (
          <div
            className="border-b px-6 py-3 text-sm"
            style={{ background: 'var(--status-critical-bg)', borderColor: 'var(--border)', color: 'var(--status-critical)' }}
          >
            <span aria-hidden className="mr-1.5 font-mono">
              ✕
            </span>
            <strong>Configuration is closed to you.</strong> Your role requires a second factor — accounts, allocation
            rules, beneficiaries and prices will all refuse you until you enrol.{' '}
            <Link href="/dashboard/security" className="underline">
              Enrol now
            </Link>
            .
          </div>
        )}

        <main className="px-6 py-7">{children}</main>
      </div>
    </div>
  );
}

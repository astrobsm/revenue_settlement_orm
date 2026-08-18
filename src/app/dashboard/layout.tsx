// ============================================================
// The signed-in shell
// ------------------------------------------------------------
// Guards the whole dashboard, and hides navigation the user's roles cannot use.
//
// THE HIDING IS A COURTESY, NOT A CONTROL. Every route behind these links checks
// permissions again server-side, and that check is the security boundary. A menu
// item that is merely absent from the page is one URL away from being visited.
//
// It also carries the MFA warning, because an administrator who has not enrolled
// will otherwise meet a 403 on a screen the menu told them they could use.
// ============================================================

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { can, Permission, RevenueRole } from '@/lib/rbac';
import { mfaRequiredFor } from '@/lib/mfa';

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

  // Only screens that exist. Invoices, reconciliation and settings are reachable
  // over the API but have no page yet, and a menu item leading to a 404 is worse
  // than an absent one.
  const links = [
    { href: '/dashboard', label: 'Overview', show: true },
    {
      href: '/dashboard/desk',
      label: 'Revenue desk',
      show: can(roles, Permission.PAYMENT_CONFIRM) || can(roles, Permission.PAYMENT_VIEW),
    },
    { href: '/dashboard/security', label: 'Security', show: true },
  ].filter((l) => l.show);

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-6 py-3">
          <div>
            <p className="text-xs uppercase tracking-widest text-slate-500">UNTH Ituku Ozalla</p>
            <p className="text-sm font-semibold">Central Theatre Revenue</p>
          </div>
          <div className="text-right text-xs text-slate-600 dark:text-slate-400">
            <p className="font-medium text-slate-900 dark:text-slate-100">{user.fullName}</p>
            <p>{roles.join(' · ').toLowerCase().replace(/_/g, ' ')}</p>
          </div>
        </div>

        <nav className="mx-auto max-w-5xl px-6">
          <ul className="flex flex-wrap gap-4 pb-2 text-sm">
            {links.map((link) => (
              <li key={link.href}>
                <Link href={link.href} className="text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100">
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </header>

      {mfaOutstanding && (
        <div className="border-b border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950">
          <div className="mx-auto max-w-5xl px-6 py-3 text-sm text-amber-900 dark:text-amber-200">
            <strong>Your role requires a second factor.</strong> Until you enrol, configuration is closed to you —
            accounts, allocation rules, beneficiaries and prices will all refuse you.{' '}
            <Link href="/dashboard/security" className="underline">
              Enrol now
            </Link>
            .
          </div>
        </div>
      )}

      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
    </div>
  );
}

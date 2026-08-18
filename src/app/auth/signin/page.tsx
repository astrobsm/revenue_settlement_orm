'use client';

// ============================================================
// Sign in
// ------------------------------------------------------------
// A bank sign-in: a green brand panel carrying the institution, a white card
// carrying the form. On a phone the panel collapses to a header band rather than
// disappearing — a clerk should be able to see they are on the hospital's own
// system before typing a password into it.
//
// Two decisions are security-relevant rather than cosmetic.
//
// THE FAILURE MESSAGE NEVER SAYS WHY. Wrong email, wrong password, wrong code,
// suspended and locked all produce one sentence. Anything more tells an attacker
// which staff emails are real, and whether they have the password but not the
// phone.
//
// THE CODE FIELD IS ALWAYS SHOWN. Revealing it only after a correct password
// would answer "does this account have MFA?" for anybody who asks, and would
// force the server to hold a half-authenticated state between requests.
// ============================================================

import { useState } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter, useSearchParams } from 'next/navigation';

export default function SignInPage() {
  const router = useRouter();
  const params = useSearchParams();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFailed(false);

    const result = await signIn('credentials', { email, password, totp, redirect: false });
    setBusy(false);

    if (result?.ok) {
      router.push(params.get('from') ?? '/dashboard');
      return;
    }
    setFailed(true);
    // The code is cleared but the email kept: a TOTP code is single-use, and one
    // just rejected will not work on a retry either.
    setTotp('');
  }

  const field =
    'mt-1 w-full rounded border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-offset-0';
  const fieldStyle = {
    background: 'var(--surface)',
    borderColor: 'var(--border-strong)',
    color: 'var(--ink)',
  } as const;

  return (
    <div className="min-h-screen lg:flex">
      {/* --- Brand panel --------------------------------------------------- */}
      <aside
        className="flex flex-col justify-between px-8 py-8 lg:w-2/5 lg:px-10 lg:py-12"
        style={{ background: 'var(--brand-strong)', color: 'var(--brand-on)' }}
      >
        <div>
          <p className="text-[11px] uppercase tracking-[0.2em] opacity-70">
            University of Nigeria Teaching Hospital
          </p>
          <p className="text-[11px] uppercase tracking-[0.2em] opacity-70">Ituku Ozalla</p>
          <h1 className="mt-4 text-3xl font-semibold leading-tight lg:text-4xl">
            Central Theatre
            <br />
            Revenue
          </h1>
          <p className="mt-4 max-w-sm text-sm leading-relaxed opacity-80">
            One consolidated bill. One payment. An exact allocation to every department, professional pool, pharmacy,
            store and vendor that earned a share of it.
          </p>
        </div>

        <p className="mt-8 hidden max-w-sm text-xs leading-relaxed opacity-60 lg:block">
          Every naira is traceable from the charge that produced it to the account it was settled to. Nothing is
          recorded as paid without evidence.
        </p>
      </aside>

      {/* --- Form --------------------------------------------------------- */}
      <main className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <h2 className="text-xl font-semibold">Sign in</h2>
          <p className="mt-1 text-sm" style={{ color: 'var(--ink-secondary)' }}>
            Use your hospital account.
          </p>

          <form onSubmit={submit} className="mt-6 space-y-4">
            <div>
              <label htmlFor="email" className="block text-sm font-medium">
                Email
              </label>
              <input
                id="email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={field}
                style={fieldStyle}
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium">
                Password
              </label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={field}
                style={fieldStyle}
              />
            </div>

            <div>
              <label htmlFor="totp" className="block text-sm font-medium">
                Authentication code{' '}
                <span className="font-normal" style={{ color: 'var(--ink-muted)' }}>
                  if your account has one
                </span>
              </label>
              <input
                id="totp"
                // Not type="number": leading zeros matter in a TOTP code, and a
                // spinner on an authentication field is nonsense.
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="000000"
                value={totp}
                onChange={(e) => setTotp(e.target.value)}
                className={`${field} figure tracking-[0.3em]`}
                style={fieldStyle}
              />
              <p className="mt-1 text-xs" style={{ color: 'var(--ink-muted)' }}>
                Six digits from your authenticator, or one of your backup codes.
              </p>
            </div>

            {failed && (
              <div
                role="alert"
                className="rounded border p-3 text-sm"
                style={{
                  background: 'var(--status-critical-bg)',
                  borderColor: 'var(--status-critical)',
                  color: 'var(--status-critical)',
                }}
              >
                <span aria-hidden className="mr-1.5 font-mono">
                  ✕
                </span>
                Those details were not accepted. Check your email, password and authentication code.
                <p className="mt-1 text-xs opacity-80">Five failed attempts lock the account for fifteen minutes.</p>
              </div>
            )}

            <button
              type="submit"
              disabled={busy}
              className="w-full rounded px-4 py-2.5 text-sm font-semibold transition-opacity disabled:opacity-50"
              style={{ background: 'var(--brand)', color: 'var(--brand-on)' }}
            >
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>
      </main>
    </div>
  );
}

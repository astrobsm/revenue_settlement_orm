'use client';

// ============================================================
// Sign in
// ------------------------------------------------------------
// Two decisions here are security-relevant rather than cosmetic.
//
// THE FAILURE MESSAGE NEVER SAYS WHY. Wrong email, wrong password, wrong code,
// suspended account and locked account all produce the same sentence. Telling a
// user which of those it was tells an attacker which staff emails are real and
// whether they have the password but not the phone.
//
// THE CODE FIELD IS ALWAYS OFFERED. It would be friendlier to ask for the
// password first and only prompt for a code if the account has MFA — but that
// two-step flow answers "does this account have MFA?" for anybody who asks, and
// it means the server has to hold a half-authenticated state between requests.
// One form, one request, one answer.
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

    const result = await signIn('credentials', {
      email,
      password,
      totp,
      redirect: false,
    });

    setBusy(false);

    if (result?.ok) {
      router.push(params.get('from') ?? '/dashboard');
      return;
    }
    setFailed(true);
    // The code is cleared but the email kept: a TOTP code is single-use and one
    // that has just been rejected will not work on a retry either.
    setTotp('');
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
      <header className="mb-8">
        <p className="text-xs uppercase tracking-widest text-slate-500">UNTH Ituku Ozalla</p>
        <h1 className="mt-1 text-2xl font-semibold">Central Theatre Revenue</h1>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">Sign in with your hospital account.</p>
      </header>

      <form onSubmit={submit} className="space-y-4">
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
            className="mt-1 w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
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
            className="mt-1 w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
          />
        </div>

        <div>
          <label htmlFor="totp" className="block text-sm font-medium">
            Authentication code
            <span className="ml-2 font-normal text-slate-500">if your account has one</span>
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
            className="figure mt-1 w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm tracking-widest dark:border-slate-700 dark:bg-slate-900"
          />
          <p className="mt-1 text-xs text-slate-500">
            Six digits from your authenticator app, or one of your backup codes.
          </p>
        </div>

        {failed && (
          <div
            role="alert"
            className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
          >
            Those details were not accepted. Check your email, password and authentication code.
            <p className="mt-1 text-xs opacity-80">
              Five failed attempts lock the account for fifteen minutes.
            </p>
          </div>
        )}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}

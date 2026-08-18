'use client';

// ============================================================
// Security — enrolling a second factor
// ------------------------------------------------------------
// The screen that unblocks a finance administrator. Three points of care:
//
// THE BACKUP CODES ARE SHOWN ONCE, and the page says so before they appear
// rather than after they are gone. They are stored hashed, so nothing here or
// anywhere else can show them again.
//
// THE MANUAL KEY IS OFFERED ALONGSIDE THE QR CODE. A theatre-floor phone with a
// cracked camera is a real thing, and an administrator who cannot scan must not
// be locked out of the system that pays the hospital's suppliers.
//
// NOTHING IS SENT ANYWHERE. The QR code arrives from our own server as a data
// URI — no third-party chart service ever sees an MFA secret.
// ============================================================

import { useEffect, useState } from 'react';

interface Status {
  enabled: boolean;
  required: boolean;
  backupCodesRemaining: number;
  enrolledAt: string | null;
  note?: string;
}

interface Enrolment {
  qrCodeDataUrl: string;
  manualEntryKey: string;
  issuer: string;
  account: string;
  nextStep: string;
}

export default function SecurityPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [code, setCode] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function loadStatus() {
    const response = await fetch('/api/auth/mfa');
    if (response.ok) setStatus(await response.json());
  }

  useEffect(() => {
    void loadStatus();
  }, []);

  async function begin() {
    setBusy(true);
    setError(null);
    const response = await fetch('/api/auth/mfa', { method: 'POST' });
    const body = await response.json();
    setBusy(false);
    if (!response.ok) {
      setError(body.error);
      return;
    }
    setEnrolment(body);
  }

  async function confirm(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const response = await fetch('/api/auth/mfa', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'CONFIRM', code }),
    });
    const body = await response.json();
    setBusy(false);
    if (!response.ok) {
      setError(body.error);
      setCode('');
      return;
    }
    setBackupCodes(body.backupCodes);
    setEnrolment(null);
    await loadStatus();
  }

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Security</h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Multi-factor authentication for anyone who can change where money is sent, or approve money leaving.
        </p>
      </header>

      {/* --- Backup codes, shown exactly once ------------------------------ */}
      {backupCodes && (
        <section className="rounded border-2 border-amber-400 bg-amber-50 p-5 dark:border-amber-600 dark:bg-amber-950">
          <h2 className="font-semibold text-amber-900 dark:text-amber-100">
            Your backup codes — copy them now
          </h2>
          <p className="mt-1 text-sm text-amber-800 dark:text-amber-200">
            These are stored only as hashes. This system <strong>cannot show them to you again</strong>. Print them
            or write them down and keep them somewhere safe. Each one works once.
          </p>
          <ul className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {backupCodes.map((c) => (
              <li key={c} className="figure rounded bg-white px-3 py-2 text-sm dark:bg-slate-900">
                {c}
              </li>
            ))}
          </ul>
          <button
            onClick={() => setBackupCodes(null)}
            className="mt-4 rounded border border-amber-500 px-3 py-1.5 text-sm text-amber-900 dark:text-amber-100"
          >
            I have saved these
          </button>
        </section>
      )}

      {/* --- Current state ------------------------------------------------- */}
      <section className="rounded border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
        {!status ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : status.enabled ? (
          <>
            <div className="flex items-center gap-2">
              <span className="font-mono text-emerald-600" aria-hidden>
                ✓
              </span>
              <h2 className="font-semibold">Multi-factor authentication is on</h2>
            </div>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
              Enrolled {status.enrolledAt ? new Date(status.enrolledAt).toLocaleString('en-NG') : ''}.{' '}
              {status.backupCodesRemaining} backup code{status.backupCodesRemaining === 1 ? '' : 's'} unused.
            </p>
            {status.note && (
              <p className="mt-2 rounded bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                {status.note}
              </p>
            )}
          </>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <span className={`font-mono ${status.required ? 'text-red-600' : 'text-slate-400'}`} aria-hidden>
                {status.required ? '✗' : '–'}
              </span>
              <h2 className="font-semibold">
                {status.required ? 'Required, and not yet enrolled' : 'Not enrolled'}
              </h2>
            </div>
            {status.note && (
              <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">{status.note}</p>
            )}
            {!enrolment && (
              <button
                onClick={begin}
                disabled={busy}
                className="mt-4 rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
              >
                {busy ? 'Preparing…' : 'Set up authenticator'}
              </button>
            )}
          </>
        )}
      </section>

      {/* --- Enrolment in progress ----------------------------------------- */}
      {enrolment && (
        <section className="rounded border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="font-semibold">Scan this with your authenticator</h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{enrolment.nextStep}</p>

          <div className="mt-4 flex flex-wrap items-start gap-6">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={enrolment.qrCodeDataUrl}
              alt="QR code for authenticator enrolment"
              width={200}
              height={200}
              className="rounded border border-slate-200 bg-white p-2 dark:border-slate-700"
            />

            <div className="min-w-56">
              <p className="text-sm font-medium">Cannot scan?</p>
              <p className="mt-1 text-xs text-slate-500">Enter this key by hand instead.</p>
              <code className="figure mt-2 block break-all rounded bg-slate-100 p-2 text-xs dark:bg-slate-800">
                {enrolment.manualEntryKey}
              </code>
              <dl className="mt-3 text-xs text-slate-600 dark:text-slate-400">
                <dt className="inline font-medium">Account: </dt>
                <dd className="inline">{enrolment.account}</dd>
                <br />
                <dt className="inline font-medium">Issuer: </dt>
                <dd className="inline">{enrolment.issuer}</dd>
              </dl>
            </div>
          </div>

          <form onSubmit={confirm} className="mt-6 max-w-xs">
            <label htmlFor="code" className="block text-sm font-medium">
              Code from the app
            </label>
            <input
              id="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="000000"
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="figure mt-1 w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm tracking-widest dark:border-slate-700 dark:bg-slate-950"
            />
            <p className="mt-1 text-xs text-slate-500">
              Nothing is switched on until this code is accepted, so a mis-scan cannot lock you out.
            </p>
            <button
              type="submit"
              disabled={busy}
              className="mt-3 rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
            >
              {busy ? 'Checking…' : 'Confirm and switch on'}
            </button>
          </form>
        </section>
      )}

      {error && (
        <div
          role="alert"
          className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
        >
          {error}
        </div>
      )}
    </div>
  );
}

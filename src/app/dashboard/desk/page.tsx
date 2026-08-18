'use client';

// ============================================================
// The revenue desk (§8, §26)
// ------------------------------------------------------------
// Where a cashier takes money from a patient. The screen is deliberately plain:
// it runs all day under fluorescent light, often by someone standing up, with a
// patient waiting on the other side of the glass.
//
// FOUR THINGS IT INSISTS ON, all of them because of what happens when they are
// missing:
//
// THE AMOUNT DEFAULTS TO THE OUTSTANDING BALANCE. The commonest desk error is a
// mistyped figure, and the commonest correct action is "pay the bill".
//
// EVIDENCE IS REQUIRED BEFORE THE BUTTON WORKS. An ATTESTED payment without a
// teller slip is a cashier's unsupported word, and the API will refuse it — so
// the form refuses it first, where the clerk can still do something about it.
//
// THE CASHIER IS NAMED AUTOMATICALLY, from their session. There is no field for
// "who took this", because a field for it is a field that can name somebody else.
//
// IT SAYS OUT LOUD THAT THE MONEY IS NOT YET RECONCILED. A desk payment is real
// but unverified until a bank statement matches it, and the receipt should not
// imply otherwise.
// ============================================================

import { useEffect, useState } from 'react';
import { Money, nairaInputToKobo } from '@/components/Money';

interface InvoiceRow {
  id: string;
  invoiceNumber: string;
  patientName: string;
  status: string;
  total: number;
  amountPaid: number;
  balance: number;
  depositComponent: number;
}

interface Result {
  payment: { paymentNumber: string; amount: number; trustBasis: string };
  invoice: { status: string; balance: number };
  allocation: { allocated: number; shares: number; timing: string; note?: string };
  deposit: { heldAsLiability: number } | null;
  reconciliation: { status: string; note?: string };
}

const CHANNELS = [
  { value: 'CASH', label: 'Cash' },
  { value: 'POS', label: 'POS / card at desk' },
  { value: 'BANK_TRANSFER', label: 'Bank transfer' },
  { value: 'CHEQUE', label: 'Cheque' },
];

export default function DeskPage() {
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [selected, setSelected] = useState<InvoiceRow | null>(null);
  const [amount, setAmount] = useState('');
  const [channel, setChannel] = useState('CASH');
  const [evidenceRef, setEvidenceRef] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    const response = await fetch('/api/invoices?limit=100');
    if (response.ok) {
      const body = await response.json();
      setInvoices(
        (body.invoices as InvoiceRow[]).filter((i) => i.status === 'ISSUED' || i.status === 'PARTIALLY_PAID')
      );
    }
    setLoading(false);
  }

  useEffect(() => {
    void load();
  }, []);

  function choose(invoice: InvoiceRow) {
    setSelected(invoice);
    setResult(null);
    setError(null);
    // Defaulting to the balance: the commonest correct action is "pay the bill",
    // and the commonest error is a mistyped figure.
    setAmount((invoice.balance / 100).toFixed(2));
    setEvidenceRef('');
    setNotes('');
  }

  const kobo = nairaInputToKobo(amount);
  const amountValid = kobo !== null && kobo > 0 && selected !== null && kobo <= selected.balance;
  const canSubmit = amountValid && evidenceRef.trim().length > 0 && !busy;

  async function takePayment(event: React.FormEvent) {
    event.preventDefault();
    if (!selected || kobo === null) return;

    setBusy(true);
    setError(null);

    const response = await fetch('/api/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // A payment queued twice by a double-click is somebody's money counted
        // against a bill they paid once.
        'Idempotency-Key': `desk-${selected.id}-${kobo}-${Date.now()}`,
      },
      body: JSON.stringify({
        invoiceId: selected.id,
        amount: kobo,
        channel,
        // A desk payment is ATTESTED: real money, a named cashier, and evidence
        // — but not verified until a bank statement agrees.
        trustBasis: 'ATTESTED',
        providerCode: 'DESK',
        evidenceRef: evidenceRef.trim(),
        notes: notes.trim() || undefined,
      }),
    });

    const body = await response.json();
    setBusy(false);

    if (!response.ok) {
      setError(body.error ?? 'The payment could not be recorded.');
      return;
    }

    setResult(body);
    setSelected(null);
    await load();
  }

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Revenue desk</h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Take a payment against an issued bill. Cash and POS taken here are recorded as attested — real money, with
          your name on it, awaiting a bank match.
        </p>
      </header>

      {/* --- Receipt of the last payment ----------------------------------- */}
      {result && (
        <section className="rounded border-2 border-emerald-400 bg-emerald-50 p-5 dark:border-emerald-700 dark:bg-emerald-950">
          <h2 className="font-semibold text-emerald-900 dark:text-emerald-100">
            Payment recorded — {result.payment.paymentNumber}
          </h2>
          <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-slate-600 dark:text-slate-400">Taken</dt>
              <dd>
                <Money kobo={result.payment.amount} emphasis />
              </dd>
            </div>
            <div>
              <dt className="text-slate-600 dark:text-slate-400">Bill now</dt>
              <dd>
                {result.invoice.status} · balance <Money kobo={result.invoice.balance} />
              </dd>
            </div>
            <div>
              <dt className="text-slate-600 dark:text-slate-400">Allocated</dt>
              <dd>
                <Money kobo={result.allocation.allocated} /> across {result.allocation.shares} account(s)
              </dd>
            </div>
            {result.deposit && (
              <div>
                <dt className="text-slate-600 dark:text-slate-400">Held as deposit</dt>
                <dd>
                  <Money kobo={result.deposit.heldAsLiability} /> — not revenue
                </dd>
              </div>
            )}
          </dl>

          {result.allocation.note && (
            <p className="mt-3 text-xs text-emerald-800 dark:text-emerald-200">{result.allocation.note}</p>
          )}
          {result.reconciliation.note && (
            <p className="mt-2 rounded bg-amber-100 p-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
              {result.reconciliation.note}
            </p>
          )}
        </section>
      )}

      {/* --- Unpaid bills --------------------------------------------------- */}
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Awaiting payment</h2>

        {loading ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : invoices.length === 0 ? (
          <p className="rounded border border-slate-200 bg-white p-4 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
            No issued bills are awaiting payment. A bill must be raised and issued before money can be taken against
            it.
          </p>
        ) : (
          <ul className="divide-y divide-slate-200 rounded border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
            {invoices.map((invoice) => (
              <li key={invoice.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
                <div>
                  <p className="figure text-sm font-medium">{invoice.invoiceNumber}</p>
                  <p className="text-sm text-slate-600 dark:text-slate-400">{invoice.patientName}</p>
                </div>
                <div className="text-right text-sm">
                  <p>
                    <Money kobo={invoice.balance} emphasis /> <span className="text-slate-500">outstanding</span>
                  </p>
                  <p className="text-xs text-slate-500">
                    of <Money kobo={invoice.total} /> · {invoice.status.toLowerCase().replace('_', ' ')}
                  </p>
                </div>
                <button
                  onClick={() => choose(invoice)}
                  className="rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-slate-100 dark:text-slate-900"
                >
                  Take payment
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* --- The payment form ---------------------------------------------- */}
      {selected && (
        <section className="rounded border border-slate-300 bg-white p-5 dark:border-slate-700 dark:bg-slate-900">
          <h2 className="font-semibold">
            {selected.patientName} · <span className="figure">{selected.invoiceNumber}</span>
          </h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            <Money kobo={selected.balance} emphasis /> outstanding of <Money kobo={selected.total} />
            {selected.depositComponent > 0 && (
              <>
                {' '}
                · includes <Money kobo={selected.depositComponent} /> deposit
              </>
            )}
          </p>

          <form onSubmit={takePayment} className="mt-5 space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="amount" className="block text-sm font-medium">
                  Amount tendered
                </label>
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-slate-500">₦</span>
                  <input
                    id="amount"
                    type="text"
                    inputMode="decimal"
                    required
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="figure w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
                  />
                </div>
                {kobo === null && amount.length > 0 && (
                  <p className="mt-1 text-xs text-red-600">Enter an amount like 910000.00</p>
                )}
                {kobo !== null && kobo > selected.balance && (
                  <p className="mt-1 text-xs text-red-600">
                    That is more than the <Money kobo={selected.balance} /> outstanding. Check the invoice number —
                    overpayment is refused rather than taken and refunded later.
                  </p>
                )}
              </div>

              <div>
                <label htmlFor="channel" className="block text-sm font-medium">
                  How it was paid
                </label>
                <select
                  id="channel"
                  value={channel}
                  onChange={(e) => setChannel(e.target.value)}
                  className="mt-1 w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
                >
                  {CHANNELS.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label htmlFor="evidence" className="block text-sm font-medium">
                Evidence reference <span className="text-red-600">*</span>
              </label>
              <input
                id="evidence"
                type="text"
                required
                placeholder="Teller slip number, POS terminal reference, transfer reference"
                value={evidenceRef}
                onChange={(e) => setEvidenceRef(e.target.value)}
                className="mt-1 w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
              />
              <p className="mt-1 text-xs text-slate-500">
                Required. This is what a bank statement will later be matched against — without it the payment cannot
                be reconciled, and the system will refuse it.
              </p>
            </div>

            <div>
              <label htmlFor="notes" className="block text-sm font-medium">
                Notes <span className="font-normal text-slate-500">optional</span>
              </label>
              <input
                id="notes"
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="mt-1 w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
              />
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="submit"
                disabled={!canSubmit}
                className="rounded bg-emerald-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
              >
                {busy ? 'Recording…' : `Record payment of ${amount ? `₦${amount}` : '—'}`}
              </button>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="rounded border border-slate-300 px-4 py-2 text-sm dark:border-slate-700"
              >
                Cancel
              </button>
            </div>

            <p className="text-xs text-slate-500">
              Recorded under your own name from your session. Revenue is allocated automatically the moment the bill
              is settled, and the payment appears in reconciliation until a bank statement confirms it.
            </p>
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

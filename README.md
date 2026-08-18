# Central Theatre Revenue

Revenue collection, payment and automated revenue allocation for **UNTH Ituku
Ozalla**. A standalone application that integrates with the **Operative Resource
Manager (ORM)** over its API.

One patient, one consolidated bill, one payment — then an automatic, exact,
auditable allocation to every department, professional pool, pharmacy, store and
vendor that earned a share of it.

```
SERVICE → PRICE → INVOICE → PAYMENT → VERIFICATION → ALLOCATION
        → SETTLEMENT → RECONCILIATION → AUDIT
```

---

## Status

**The financial core is built and tested. The HTTP and UI layers are not yet
written.** See [Build state](#build-state) for exactly what exists.

```
272 passed, 0 failed        npm test
schema valid                npx prisma validate
strict typecheck clean      npx tsc --noEmit
```

---

## Quick start

```bash
npm install
cp .env.example .env.local     # then fill in DATABASE_URL and NEXTAUTH_SECRET
npx prisma migrate dev         # create the schema
npm test                       # domain tests — no database needed
npm run dev                    # http://localhost:3100
```

`npm test` deliberately needs **no database, no network and no clock**. The
properties most worth proving here — that a split sums back to its total, that a
payment cannot reach `SUCCESSFUL` without proof, that a ledger entry balances —
are properties of arithmetic and rules, and a test that needs a live Postgres to
check them is a test nobody runs.

---

## The five rules this system is built on

Everything else is detail. These are load-bearing.

**1. Money is integer kobo.** Never a float, never `Decimal`, never naira. A
surgical invoice carries forty lines; float addition over forty lines drifts, and
one drifting kobo per invoice is a ledger that will not reconcile and nobody can
explain. Naira exists only at the edges, produced by `formatNaira()`.

**2. Nothing is "paid" because something said so.** A browser callback, a
screenshot, a patient's word and a clerk clicking *confirm* are worth exactly
nothing. `SUCCESSFUL` is reachable only with a **trust basis** — see below.

**3. Financial history is append-only.** No record of money is ever updated
destructively. A correction is a **new compensating entry** that references the
original and leaves it untouched. A reversal that edited the original would
destroy the record of what was believed at the time, which is the one thing an
audit needs.

**4. Prices and allocation rules are effective-dated, never edited in place.** A
bill raised last year still explains its own figures under last year's tariff and
last year's split. Superseding writes `effectiveTo` on the old row and inserts a
new one.

**5. Every allocated kobo names the charge that produced it.** Allocation is
recorded per invoice line, not per charge-kind subtotal. Rolling up first would
leave a consumables total that no longer knows which vendor supplied which item.

---

## How a payment is trusted

The honest problem: §2 of the specification forbids trusting a client's claim of
payment. It cannot forbid a cashier recording genuine cash — at a Nigerian
teaching-hospital revenue desk, cash and POS are a large share of collections,
and a human entry is the only possible source of truth for them.

So the system distinguishes them **structurally** instead of pretending they are
the same:

| Trust basis | How it is known | Requires |
|---|---|---|
| `GATEWAY_VERIFIED` | The provider was asked, server to server, and said yes | provider transaction id |
| `BANK_CONFIRMED` | A bank statement line was matched to it | bank reference |
| `ATTESTED` | A named, authorised cashier took cash or POS at a desk | cashier's user id **and** evidence |

An `ATTESTED` payment is allowed — care must not stop for want of a gateway — and
it is allocated immediately. What it does not get is the *pretence* of
verification: it names the cashier, it is reported as unreconciled, and it stays
in the daily exceptions report until a bank statement confirms it.

That satisfies the requirement that the system never suggest money has arrived
somewhere it has not, without pretending a cash desk does not exist.

---

## Separation of duties is enforced per record

The permission matrix answers *may this role do this at all?* That is the easy
half. The dangerous case is a cashier confirming a payment against an invoice
whose price **they** overrode — permission checks have no memory of who did what
earlier, so they cannot see it.

`checkSeparationOfDuties()` reads a record's own prior acts from the audit log and
refuses. Which is why the audit trail here is **not merely a report** — it is an
input to a live control. A system that logs nothing cannot enforce separation of
duties at all.

Three properties are asserted by the test suite, so a future well-meaning edit
fails the build rather than quietly opening a door:

- No role holds both `payment:confirm` and `allocation-rule:manage`.
- The auditor holds **no write permission of any kind**.
- The super administrator holds every permission and is **still barred** by
  separation of duties on a record it has already touched. An exemption there
  would be a door, and a door in a separation-of-duties control is the whole
  control.

---

## Build state

### Built and tested

| Area | Module | Tests |
|---|---|---|
| Kobo arithmetic, naira formatting | [src/lib/money.ts](src/lib/money.ts) | — |
| Allocation engine — fixed, tiered, percentage, residual | [src/lib/allocation.ts](src/lib/allocation.ts) | 53 |
| Consolidated bill, status, overrides, allocation timing | [src/lib/invoice.ts](src/lib/invoice.ts) | 47 |
| Double-entry ledger | [src/lib/ledger.ts](src/lib/ledger.ts) | 27 |
| Roles, permissions, separation of duties | [src/lib/rbac.ts](src/lib/rbac.ts) | 27 |
| Payment state machine and trust basis | [src/lib/payments/states.ts](src/lib/payments/states.ts) | 24 |
| Pro-rata part payments | `proRataLines()` in allocation.ts | in the 53 |
| Vendor supply agreements: levy, signatures, consent | [src/lib/agreements.ts](src/lib/agreements.ts) | 29 |
| Bank-detail encryption and masking | [src/lib/crypto.ts](src/lib/crypto.ts) | — |
| Webhook signature verification and event handling | [src/lib/payments/webhooks.ts](src/lib/payments/webhooks.ts) | 36 |
| Provider adapters — Paystack, Flutterwave | [src/lib/payments/providers.ts](src/lib/payments/providers.ts) | — |
| Reconciliation: twelve exception types across five records | [src/lib/reconciliation.ts](src/lib/reconciliation.ts) | 29 |
| Full database schema (36 models) | [prisma/schema.prisma](prisma/schema.prisma) | validates |
| Migrations, incl. database-level append-only triggers | [prisma/migrations/](prisma/migrations/) | — |
| Seed: catalogue, accounts, rules, providers, policy | [prisma/seed.ts](prisma/seed.ts) | — |
| ORM read client | [src/lib/orm/client.ts](src/lib/orm/client.ts) | — |
| Auth, route guard, audit trail, idempotency, numbering | [src/lib/](src/lib/) | — |
| `POST /api/invoices`, `POST /api/payments` | [src/app/api/](src/app/api/) | — |
| Settings: revenue-account bank details, vendor agreements | [src/app/api/settings/](src/app/api/settings/) | — |
| `POST /api/payments/initiate`, `POST /api/webhooks/[provider]` | [src/app/api/](src/app/api/) | — |
| `POST /api/reconciliation` — daily run and exception resolution | [src/app/api/reconciliation/](src/app/api/reconciliation/) | — |

The append-only rule is enforced by **database triggers**, not only in
TypeScript: an application rule is bypassed by `psql`, by a migration script, and
by the next route written in a hurry. The ledger, the audit log, provider
exchanges and issued receipts reject `UPDATE` and `DELETE` outright.

### Not yet built

Refunds and deposit draw-down routes · receipt
and QR generation · dashboards · patient portal · UI.

[ARCHITECTURE.md](ARCHITECTURE.md) records the design decisions and the order the
remaining phases should be built in.

---

## Allocation, concretely

The specification's acceptance case: one bill of ₦910,000.00 across seven charges
from five departments.

```
Surgical fee              500,000.00  → Surgery account
Anaesthetist fee          100,000.00  → Anaesthesia account
Anaesthetic drugs          75,000.00  ┐
Procedure drugs            40,000.00  ├→ Pharmacy account    130,000.00
IV fluids                  15,000.00  ┘
Surgical consumables       80,000.00  → Consumables account
Admission deposit         100,000.00  → held as a LIABILITY, not revenue
                          ──────────
                          910,000.00
```

Three things in that table are the whole point of the system.

**The pharmacy figure is ₦130,000, not ₦115,000.** The specification's §54 states
₦115,000, but its own line items sum to ₦130,000 and its five destinations then
total ₦895,000 against a bill of ₦910,000 — ₦15,000 unaccounted for. The
specification's own §16, working the same case, says ₦130,000 and totals exactly
₦910,000. §54 contains an arithmetic slip, and reproducing it literally would
mean building an engine that loses ₦15,000 of a patient's money on this very
invoice. `allocate()` refuses to do that by design; the discrepancy was surfaced
by the test that asserts it.

**The admission deposit is a liability, not revenue.** Money taken against a
deposit is money the hospital *holds*, not money it has *earned*. Booking it as
revenue on receipt overstates income. It is drawn down as services are actually
consumed, and the remaining balance is always the patient's.

---

## The vendor supply levy

Where a vendor takes over supply of a consumable, they agree that the hospital
retains a share of the revenue billed for it — 15% by default, into the hospital
development fund. It is a **negotiated commercial term**, so it is editable per
vendor. What it is not is unilateral.

Three rules make that real, and all three are enforced in the domain layer, in
the API, and by database trigger:

**A levy applies only when both parties have signed.** No signature, a revoked
signature, a suspended or expired agreement, or a charge kind the agreement does
not cover — each yields a levy of **zero**, and the vendor is paid in full.
Deducting an unagreed share of a supplier's money is not a configuration
default.

**A signature is against a specific percentage.** If the figure moves after
signing, the signature is *stale*, not merely present, and the levy stops until
both parties sign again. This is the case the whole mechanism exists to catch.

**A signed percentage cannot be edited.** Changing 15% to 20% on an agreement the
vendor has already signed would mean they signed one number while another is
applied to their money. Amending therefore raises a **new version** that both
parties sign — and the existing agreement stays in force until they do, so
supply is never left ungoverned in the gap.

Consent is recorded separately from the signature image: one proves *who*, the
other proves *they were shown these terms at this percentage and accepted them*.
The exact wording each party agreed to is stored on their signature.

**Instructing a settlement moves nothing.** There is deliberately no ledger entry
for "settlement initiated". Telling a bank to transfer is not a transfer, and
posting as though it were is exactly the false impression the specification
forbids. Only a *confirmed* settlement — with the bank reference that proves it —
moves money out.

---

## Relationship to ORM

Separate application, separate database. Central Theatre Revenue reads patient,
booking, theatre, anaesthesia, pharmacy, consumable and admission data from ORM's
API and **never writes to ORM's schema** — clinical records belong to the
clinical system. ORM's ids are stored as opaque `ormRef` text, never as foreign
keys, because a cross-database foreign key is not a thing.

ORM already contains a working theatre billing ledger of its own
(`Invoice`/`Payment`/`RevenueDistribution`). That module is deliberately left
running and untouched; see ARCHITECTURE.md for how the two relate and what would
be involved in migrating from it.

---

## Licence

Internal application of the University of Nigeria Teaching Hospital, Ituku
Ozalla. Not for distribution.

# Central Theatre Revenue — Architecture

> **How to read this document.** §A–§C assess the **existing ORM billing
> module**, and were written before any code here existed. They are kept because
> they are the design basis: they record what ORM already does well and should not
> be duplicated, what it does badly, and which of its decisions this application
> deliberately departs from.
>
> **§A–§C describe ORM, not this application.** Where they say "the fix
> should…", that work was done *here* — a separate app with its own database —
> rather than as a change to ORM. ORM's billing module is left running, untouched.
>
> §D listed the decisions that had to be settled before building. They have now
> been taken: see **§D-RESOLVED** at the end, which supersedes §D.

Baseline measured on ORM at assessment time: `npm run test:billing` → 73 passed,
0 failed. Current state of *this* application: `npm test` → **157 passed, 0
failed**.

---

## A. What already exists

The master prompt describes a system that is roughly **40% already built** in this
repository, and built well. Phase 1's most useful output is therefore not a
greenfield design but an honest map of what to keep, what to extend, and what is
genuinely missing.

Stack: Next.js 14 (App Router) · Prisma 5 · PostgreSQL · NextAuth · TypeScript.
Money is **integer kobo** throughout — never float, never `Decimal`. Keep this.

### Already implemented, to standard

| Spec section | Requirement | Existing implementation |
|---|---|---|
| §5, §40 | Service catalogue, price versioning | `Tariff` — effective-dated (`effectiveFrom`/`effectiveTo`), superseded by writing `effectiveTo` on the old row, never edited in place. `reason` field on price change. |
| §7 | Consolidated itemised bill | `Invoice` + `InvoiceLine`, assembled by `lib/billing/invoice.ts` |
| §40 | Historical invoices immune to price change | `InvoiceLine.unitPrice` captured at billing time; stock priced at `unitPriceAtReservation` |
| §12, §13 | Allocation engine, percentage splits | `lib/billing/revenue.ts` — `distributeInvoice()` |
| §53 | Rounding differences | **Largest-remainder allocation.** Shares of an integer sum back to it exactly. This is the correct algorithm and is already tested (23 cases). |
| §14 | Revenue account directory | `RevenueAccount` (+ `RevenueAccountKind`) |
| §41 | Allocation rule versioning | `RevenueRule` — effective-dated, basis points (1% = 100bp) |
| §12 | Computed split, recorded as applied | `RevenueDistribution` — stores `shareBasisPoints` so the figure can be re-derived |
| §34, §35 | Idempotency | `IdempotencyKey` model + `lib/idempotency.ts`, applied to payment POST |
| §23, §44 | Invoice lock after payment | `isInvoiceLocked()` — enforced on invoice PATCH |
| §18 (partial) | Reversal not deletion | `Payment.reversedAt` + `reversalReason`; distributions cancelled, not deleted |
| §39 | Provisional bill from care pathway | `SurgeryEstimate` + `SurgeryEstimateLine` + `lib/estimates/` (autoDraft, fromPacks) |
| §38 | ORM integration | Already wired: `StockReservation` → billing consumes `quantityUsed`; `ProcedurePackMap`; `Vendor` consignment routing |

Two existing design rules are better than the master prompt's defaults and
should be preserved explicitly:

1. **The patient is billed for what was `quantityUsed`, never what was reserved,
   issued or wasted.** A dropped vial is the hospital's loss. (`lib/billing/invoice.ts`)
2. **Consignment stock pays the vendor that supplied that specific line**, not
   the generic consumables rule. Ownership transfers at consumption.

---

## B. The central architectural conflict

`src/app/api/billing/payments/route.ts` states its design decision in its header:

> *"This is a LEDGER. No money moves through the application. ORM computes what
> each account is owed, records it, and Finance executes the transfers — which is
> why there is no payment gateway here and no credentials to protect."*

The master prompt (§9, §11, §16, §35) requires the opposite: a payment-gateway
integration with server-side verification, signed webhooks, and — where supported
— **native provider split settlement**.

These are not reconcilable by compromise; they are two different trust models.

| | Existing: **manual ledger** | Master prompt: **gateway** |
|---|---|---|
| Money path | Patient → cash desk → hospital bank, outside the app | Patient → gateway → hospital settlement account |
| Payment truth | A cashier's entry + evidence image | Provider's server-to-server verification |
| Settlement | Finance transfers in the bank; app records the reference | Provider split, or transfer API |
| Attack surface | None. No credentials. | Gateway secrets, webhook endpoint, replay risk |
| Works offline | Yes — this matters on the on-site box | No — needs outbound internet |

**Recommendation: keep both rails, with different trust levels — do not replace
the ledger.**

The reason is not conservatism. §2 forbids trusting a *client's claim* of payment.
It does not, and cannot, forbid a cashier recording genuine cash — at a Nigerian
teaching-hospital revenue desk, cash and POS are a large share of collections, and
a human entry is the only possible source of truth for them. The correct design
distinguishes them structurally rather than pretending they are the same:

```
Payment.trustBasis:
  GATEWAY_VERIFIED   server-to-server verified — auto-allocates
  BANK_CONFIRMED     matched against a bank statement import — auto-allocates
  ATTESTED           a cashier's entry + evidence — allocates, but flagged
                     for reconciliation and counted in the exceptions report
```

An `ATTESTED` payment is honest about what it is: someone's word plus a teller
slip. It is allowed (care must not stop), it is allocated, and it is *visibly
unreconciled* until a bank statement confirms it. That satisfies §51's demand
that the system never create the illusion that money has arrived when it has not,
without breaking a working cash desk.

---

## C. Genuine gaps — what Phases 2–8 must build

Ordered by financial risk, highest first.

### C1. No separation of duties — **highest risk** (§24, §25)

`UserRole` contains **no finance role at all**: no cashier, revenue officer,
finance officer, or auditor. All three billing endpoints — invoice create/update,
payment, *and* settlement — are guarded by the single permission
`requireStock('receive')`, whose holders are:

```
ADMIN, SYSTEM_ADMINISTRATOR, THEATRE_MANAGER, THEATRE_CHAIRMAN,
THEATRE_STORE_KEEPER, PROCUREMENT_OFFICER, PHARMACIST
```

So today **one store keeper can raise an invoice, set an override price, take the
payment, and record the bank settlement** — the exact concentration §25 forbids.
A pharmacist can mark money as transferred to a vendor account.

The fix should **not** invent a third permission system. The imprest module has
already solved this: `ImprestRole` (CASHIER, CHIEF_ACCOUNTANT, ACCOUNT_OFFICER,
INTERNAL_AUDITOR, VIEW_ONLY_AUDITOR, FINANCE…) assigned through
`ImprestRoleAssignment`, with a `resource:action` permission matrix in
`lib/imprest/permissions.ts` and a documented rule that *the API check is the
security boundary and the UI check is a courtesy*. Extend that layer.

### C2. No audit trail on any financial action (§33)

`grep` for audit writes across `src/app/api/billing/` and `src/lib/billing/`
returns **nothing**. `AuditLog` and `ImprestAuditLog` models exist and are used
elsewhere; billing writes to neither. Every price override, discount, payment,
reversal and settlement is currently unlogged.

### C3. `Payment` has no status — no state machine (§10)

`Payment` has `amount`, `method`, `reference`, `reversedAt` — and no status
field. A payment exists or it does not; there is no
`PENDING → PROCESSING → SUCCESSFUL` progression, which a gateway requires and
which §10 mandates. Needs a `PaymentStatus` enum plus a guarded transition
function (the `statusAfterPayment` pattern in `lib/billing/invoice.ts` is the
model to follow).

### C4. Deposits are booked as revenue, not liability (§21)

`ChargeKind.ADMISSION` is an ordinary invoice line, so an admission deposit is
distributed to revenue accounts the moment the invoice is paid. §21 requires it
held as a **deposit/liability** and drawn down as services are consumed. This is
a real accounting defect, not a cosmetic one: it overstates earned revenue.
Needs `Deposit` + `DepositApplication`.

### C5. Settled allocations cannot be recovered on reversal (§19)

On payment reversal the route cancels distributions `where status: 'PENDING'`.
Distributions already `SETTLED` — money that has genuinely left the building —
are silently left in place with no recovery record. §19 requires
*Settlement Reversal / Recovery* as its own transaction.

### C6. Entities that do not exist at all

`Refund` (§19) · `Adjustment`/credit note (§23) · `LedgerEntry` (§18 double-entry)
· `Settlement`/`SettlementItem` as first-class objects with a lifecycle (§16 —
today settlement is only two nullable columns on `RevenueDistribution`) ·
`Reconciliation` (§31, §32) · `PaymentProvider`/`PaymentTransaction` (§9) ·
receipt + verification code (§26) · patient portal (§27).

### C7. Allocation timing is hard-coded (§20)

Distribution happens **only on full settlement** — a deliberate, well-reasoned
choice (documented: a split computed twice against a moving balance must be
unwound if a payment is reversed). But §20 requires Option A / Option B to be
*configurable*. Option B needs the reversal recovery of C5 to exist first.

---

## D. Decisions needed before Phase 2

These change the schema, so migrations should not be written until they are settled.

1. **Gateway rail — build it, and with which provider?** Adds an
   outbound-internet dependency and secrets to an on-site box. Paystack and
   Flutterwave both support native split settlement; Interswitch and Moniepoint
   differ. The alternative is to defer the gateway and first close C1–C6, which
   carry more financial risk than the gateway adds convenience.
2. **Invoice scope.** `Invoice.surgeryId` is `@unique` — strictly one invoice per
   surgery. §7's consolidated bill spanning admission, investigations and ward
   stay needs either an encounter-scoped invoice (migration, touches everything)
   or an invoice-group wrapper over surgery-scoped invoices (additive, safer).
3. **Deposit policy.** Confirm deposits become liabilities drawn down by charge
   (C4). This is the correct accounting and I recommend it, but it changes how
   admission money is reported.
4. **Allocation timing default** — keep Option A as the default (recommended) and
   add Option B as opt-in configuration.
5. **Finance RBAC** — extend the existing `ImprestRole`/`ImprestRoleAssignment`
   layer (recommended: one finance identity across imprest and revenue) versus a
   parallel `RevenueRole`.

---

## E. Proposed phase order (revised from §52)

§52's order assumes a greenfield build. Given what exists, this order retires
risk faster:

| Phase | Content | Blocked by |
|---|---|---|
| 2 | Finance RBAC + separation-of-duties rules + audit trail on every billing action (C1, C2) | D5 |
| 3 | `PaymentStatus` state machine; `Refund`, `Adjustment`, `LedgerEntry` (C3, C6) | — |
| 4 | Deposits as liability (C4); settlement as first-class object with recovery (C5) | D3 |
| 5 | Reconciliation engine + exceptions report (§31, §32) | — |
| 6 | Receipt, verification code/QR, patient portal (§26–§28) | D2 |
| 7 | Gateway abstraction + one provider + signed idempotent webhook (§9, §35) | D1 |
| 8 | Dashboards and reports (§29, §30, §46, §47) | — |
| 9 | Security review, load, deployment (§42, §53) | — |

Phase 2 comes first because C1 and C2 are exploitable **today**, with no gateway
involved.

---

## §D-RESOLVED. Decisions taken

Supersedes §D. Each was a real fork; the reasoning is recorded so it can be
revisited on evidence rather than re-argued from scratch.

**D1 — Gateway rail: abstraction built, no provider hard-wired.**
`PaymentProvider` is a configured row, not a compiled-in choice, and credentials
live only in environment variables (the table records *which env keys* a provider
reads, never the secret). A `DESK` provider is always available and needs no
credentials. Paystack and Flutterwave are the intended first adapters because both
support native split settlement; neither is assumed. The decisive point is in §B:
the trust model is what matters, not the vendor, so `TrustBasis` — not a provider
name — is what gates money.

**D2 — Invoice scope: encounter, not surgery.**
ORM ties an invoice to one surgery (`surgeryId @unique`), which cannot express a
consolidated bill spanning admission, ward stay and investigations. Here an
invoice belongs to an `Encounter`, and charges hang off the encounter. This is the
change that makes "one bill, one payment" true for an admitted surgical patient
rather than only for the operation itself.

**D3 — Deposits are liabilities. Confirmed.**
`ADMISSION_DEPOSIT` is flagged on the invoice line, excluded from tax and
discount, kept out of revenue allocation, and posted to
`PATIENT_DEPOSIT_LIABILITY`. It becomes revenue only through
`DepositApplication`, as services are consumed. This was the clearest real
accounting defect in ORM's module: it overstates earned income.

**D4 — Allocation timing: `ON_FULL_PAYMENT` default, `PRO_RATA` available.**
Both are implemented and exact (`amountToAllocate`, tested to sum to the invoice
total across instalments). The default is the conservative one for ORM's stated
reason — a split computed repeatedly against a moving balance must be unwound if
an instalment is reversed. `PRO_RATA` is configuration, not a code change.

**D5 — RBAC: native to this app.**
ORM's `ImprestRole` layer was the right precedent to *copy*, not to share: a
separate application with a separate database cannot depend on ORM's role table
without coupling authentication across a boundary that is meant to be read-only.
`RevenueRole` + `RoleAssignment` follows the same shape — a `resource:action`
matrix, roles assigned separately from job titles — and adds the per-record
separation-of-duties check ORM lacks entirely.

### Departure from the specification, recorded

**§54's arithmetic is wrong, and the code does not reproduce it.** §54 allocates
₦115,000 to pharmacy; its own line items sum to ₦130,000, and its five
destinations then total ₦895,000 against a bill of ₦910,000. §16, working the same
case, says ₦130,000 and totals exactly ₦910,000. §16 is correct. Building §54
literally would mean an engine that loses ₦15,000 on that invoice, which
`allocate()` refuses to do by construction. Asserted in
`scripts/tests/allocation.test.ts` so nobody "fixes" it back.

**§15 is honoured strictly.** There is no per-individual revenue account type.
Professional fees route to a `PROFESSIONAL_POOL` institutional account; onward
distribution to a named surgeon is a payroll decision made outside this system.
§15 is explicit that a fee must not follow a person merely because their name is
on a case.

### Remaining phase order

| Phase | Content | State |
|---|---|---|
| 1 | Domain core: money, allocation, invoice, ledger, RBAC, payment states | **done, 157 tests** |
| 2 | Database schema | **done, validates** |
| 3 | Migrations, seed data, ORM read client | next |
| 4 | API routes with RBAC + SoD + audit write on every financial action | next |
| 5 | Provider adapters (desk, Paystack) + signed idempotent webhook | |
| 6 | Reconciliation runner and exceptions report | |
| 7 | Receipts, verification code, QR, patient portal | |
| 8 | Dashboards and reports | |
| 9 | Security review, load test, deployment | |

Phase 4 carries the audit write, because §33's log is an *input* to the
separation-of-duties control (`checkSeparationOfDuties` reads prior acts from it),
not a report bolted on afterwards. Routes and audit must land together or the
control is inert.

// ============================================================================
// Seed — the configuration a new installation cannot start without
// ----------------------------------------------------------------------------
//     npm run db:seed
//
// Idempotent: every write is an upsert keyed on a stable business code, so this
// can be re-run after a schema change without duplicating a revenue account or
// resetting a price somebody has since corrected.
//
// WHAT IS SEEDED AND WHAT IS NOT.
//
// Seeded: the service catalogue, revenue accounts, allocation rules, payment
// providers and institutional policy settings. These are configuration — the
// system is inert without them, and an empty allocation rule table would send
// every naira to the fallback account.
//
// NOT seeded: users. A default administrator with a known password is how a
// financial system gets owned on its first day. The bootstrap administrator is
// created only when SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD are both set in
// the environment, and the account is created with MFA required (§42).
//
// PRICES HERE ARE THE SPECIFICATION'S WORKED EXAMPLE, not UNTH's tariff. They
// exist so the §54 acceptance case can be run end to end on a fresh database.
// Real prices are set through the catalogue screen by a finance administrator,
// where each change is effective-dated and carries a reason (§40).
// ============================================================================

import { PrismaClient, ChargeKind, BeneficiaryType, AllocationRuleType, PaymentChannel } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

/** Naira to kobo, for legibility below. Every stored amount is kobo. */
const naira = (n: number) => Math.round(n * 100);

/** Rules and prices take effect from a date the installation can point at. */
const EFFECTIVE_FROM = new Date('2026-01-01T00:00:00.000Z');

// ---------------------------------------------------------------------------
// 1. Revenue accounts (§14, §15)
// ---------------------------------------------------------------------------
// NOTE ON §15: there is no per-surgeon or per-anaesthetist account here, and
// there should never be one. §15 is explicit that professional fees must not be
// routed to an individual because their name appears on a case. The
// PROFESSIONAL_POOL accounts are institutional; onward distribution to a named
// clinician is a payroll decision taken outside this system.
//
// Bank account numbers are deliberately absent. They are entered by a finance
// administrator through the accounts screen, where they are encrypted at rest
// and the change is approved and audited (§14, §25). Seeding them would put real
// bank details in a file that lives in version control.
const ACCOUNTS: {
  code: string;
  name: string;
  beneficiaryType: BeneficiaryType;
  departmentName?: string;
  costCentre?: string;
}[] = [
  { code: 'ACCT-HOSPITAL', name: 'Hospital general revenue', beneficiaryType: 'HOSPITAL', costCentre: 'GEN' },
  {
    code: 'ACCT-HOSPITAL-DEV',
    name: 'Hospital development fund',
    beneficiaryType: 'HOSPITAL_DEVELOPMENT',
    costCentre: 'DEV',
  },
  { code: 'ACCT-SURGERY', name: 'Surgical services revenue', beneficiaryType: 'DEPARTMENT', departmentName: 'Surgery' },
  { code: 'ACCT-ANAESTHESIA', name: 'Anaesthesia services revenue', beneficiaryType: 'DEPARTMENT', departmentName: 'Anaesthesia' },
  { code: 'ACCT-THEATRE', name: 'Theatre revenue', beneficiaryType: 'THEATRE', departmentName: 'Theatre' },
  { code: 'ACCT-PHARMACY', name: 'Pharmacy revenue', beneficiaryType: 'PHARMACY', departmentName: 'Pharmacy' },
  { code: 'ACCT-CONSUMABLES', name: 'Theatre consumables and stores', beneficiaryType: 'CONSUMABLE_PROVIDER', departmentName: 'Theatre Stores' },
  { code: 'ACCT-CSSD', name: 'CSSD revenue', beneficiaryType: 'CSSD', departmentName: 'CSSD' },
  { code: 'ACCT-LABORATORY', name: 'Laboratory revenue', beneficiaryType: 'LABORATORY', departmentName: 'Laboratory' },
  { code: 'ACCT-RADIOLOGY', name: 'Radiology revenue', beneficiaryType: 'RADIOLOGY', departmentName: 'Radiology' },
  { code: 'ACCT-BLOOD-BANK', name: 'Blood bank revenue', beneficiaryType: 'BLOOD_BANK', departmentName: 'Blood Bank' },
  { code: 'ACCT-ADMISSION', name: 'Admission and ward revenue', beneficiaryType: 'DEPARTMENT', departmentName: 'Admissions' },
  { code: 'ACCT-PROF-SURGEON', name: 'Surgical professional fee pool', beneficiaryType: 'PROFESSIONAL_POOL', departmentName: 'Surgery' },
  { code: 'ACCT-PROF-ANAESTHETIST', name: 'Anaesthesia professional fee pool', beneficiaryType: 'PROFESSIONAL_POOL', departmentName: 'Anaesthesia' },
];

// ---------------------------------------------------------------------------
// 2. Allocation rules (§13, §41)
// ---------------------------------------------------------------------------
// THE CONSUMABLES DEVELOPMENT LEVY.
//
// Institutional policy: 15% of consumables revenue is levied into the hospital
// development fund; the remaining 85% goes to theatre stores. It is expressed
// here as two PERCENTAGE rules totalling 10,000 basis points, so the allocation
// engine splits it by largest remainder and the two shares sum back to the
// charge exactly — proved in scripts/tests/allocation.test.ts across a thousand
// consecutive amounts.
//
// It lives here, as DATA, precisely so that changing it to 10% or 20% is a
// configuration change made by a finance administrator with an effective date
// and an approval — not a code deployment. Superseding it writes effectiveTo on
// these rows and inserts new ones, so a bill allocated today still explains
// itself under today's levy years from now (§41).
//
// ONE THING IT DOES NOT DO: a consignment consumable — vendor-owned stock,
// carrying an explicit beneficiary account on its invoice line — bypasses these
// rules entirely and pays the vendor in full. That stock is the vendor's
// property until it is used, so levying 15% would be a unilateral cut of a
// supplier's invoice. If the hospital does intend to charge suppliers a
// handling levy, that is a commercial decision and a different rule; say so and
// it can be added.
const LEVY_BASIS_POINTS = 1500; // 15%

const RULES: {
  kind: ChargeKind;
  accountCode: string;
  type: AllocationRuleType;
  shareBasisPoints?: number;
  amount?: number;
  priority?: number;
  label?: string;
}[] = [
  // Professional fees -> institutional pools, in full (§15).
  { kind: 'PROFESSIONAL_SURGEON', accountCode: 'ACCT-PROF-SURGEON', type: 'RESIDUAL', label: 'Surgical professional pool' },
  { kind: 'PROFESSIONAL_ANAESTHETIST', accountCode: 'ACCT-PROF-ANAESTHETIST', type: 'RESIDUAL', label: 'Anaesthesia professional pool' },
  { kind: 'PROFESSIONAL_OTHER', accountCode: 'ACCT-HOSPITAL', type: 'RESIDUAL', label: 'Other professional fees' },

  // Theatre and recovery.
  { kind: 'THEATRE', accountCode: 'ACCT-THEATRE', type: 'RESIDUAL', label: 'Theatre' },
  { kind: 'RECOVERY', accountCode: 'ACCT-THEATRE', type: 'RESIDUAL', label: 'Recovery' },
  { kind: 'CSSD', accountCode: 'ACCT-CSSD', type: 'RESIDUAL', label: 'CSSD' },

  // Anything dispensed by pharmacy.
  { kind: 'ANAESTHESIA_DRUG', accountCode: 'ACCT-PHARMACY', type: 'RESIDUAL', label: 'Anaesthetic drugs' },
  { kind: 'DRUG', accountCode: 'ACCT-PHARMACY', type: 'RESIDUAL', label: 'Medications' },
  { kind: 'IV_FLUID', accountCode: 'ACCT-PHARMACY', type: 'RESIDUAL', label: 'IV fluids' },

  // --- The consumables levy: 15% development, 85% stores ---------------------
  {
    kind: 'CONSUMABLE',
    accountCode: 'ACCT-HOSPITAL-DEV',
    type: 'PERCENTAGE',
    shareBasisPoints: LEVY_BASIS_POINTS,
    priority: 1,
    label: 'Hospital development levy (15%)',
  },
  {
    kind: 'CONSUMABLE',
    accountCode: 'ACCT-CONSUMABLES',
    type: 'PERCENTAGE',
    shareBasisPoints: 10_000 - LEVY_BASIS_POINTS,
    priority: 1,
    label: 'Theatre stores (85%)',
  },
  // Anaesthetic consumables are consumables, and are levied the same way.
  {
    kind: 'ANAESTHESIA_CONSUMABLE',
    accountCode: 'ACCT-HOSPITAL-DEV',
    type: 'PERCENTAGE',
    shareBasisPoints: LEVY_BASIS_POINTS,
    priority: 1,
    label: 'Hospital development levy (15%)',
  },
  {
    kind: 'ANAESTHESIA_CONSUMABLE',
    accountCode: 'ACCT-CONSUMABLES',
    type: 'PERCENTAGE',
    shareBasisPoints: 10_000 - LEVY_BASIS_POINTS,
    priority: 1,
    label: 'Theatre stores (85%)',
  },
  // Implants are high-value and usually vendor-supplied; levied the same way
  // when hospital-owned, and bypassed entirely when consigned.
  {
    kind: 'IMPLANT',
    accountCode: 'ACCT-HOSPITAL-DEV',
    type: 'PERCENTAGE',
    shareBasisPoints: LEVY_BASIS_POINTS,
    priority: 1,
    label: 'Hospital development levy (15%)',
  },
  {
    kind: 'IMPLANT',
    accountCode: 'ACCT-CONSUMABLES',
    type: 'PERCENTAGE',
    shareBasisPoints: 10_000 - LEVY_BASIS_POINTS,
    priority: 1,
    label: 'Theatre stores (85%)',
  },

  // Investigations and blood.
  { kind: 'INVESTIGATION_LAB', accountCode: 'ACCT-LABORATORY', type: 'RESIDUAL', label: 'Laboratory' },
  { kind: 'INVESTIGATION_IMAGING', accountCode: 'ACCT-RADIOLOGY', type: 'RESIDUAL', label: 'Imaging' },
  { kind: 'BLOOD', accountCode: 'ACCT-BLOOD-BANK', type: 'RESIDUAL', label: 'Blood products' },
  { kind: 'OXYGEN', accountCode: 'ACCT-HOSPITAL', type: 'RESIDUAL', label: 'Oxygen' },

  // Admission and ward.
  { kind: 'ADMISSION_DEPOSIT', accountCode: 'ACCT-ADMISSION', type: 'RESIDUAL', label: 'Admission deposit' },
  { kind: 'BED_CHARGE', accountCode: 'ACCT-ADMISSION', type: 'RESIDUAL', label: 'Bed charges' },
  { kind: 'NURSING', accountCode: 'ACCT-ADMISSION', type: 'RESIDUAL', label: 'Nursing' },
  { kind: 'POSTOP_SERVICE', accountCode: 'ACCT-HOSPITAL', type: 'RESIDUAL', label: 'Post-operative services' },
  { kind: 'OTHER', accountCode: 'ACCT-HOSPITAL', type: 'RESIDUAL', label: 'Other approved charges' },
];

// ---------------------------------------------------------------------------
// 3. Service catalogue (§5) — the §54 worked example
// ---------------------------------------------------------------------------
const CATEGORIES = [
  { code: 'CAT-PROFESSIONAL', name: 'Professional services', sortOrder: 1 },
  { code: 'CAT-THEATRE', name: 'Theatre services', sortOrder: 2 },
  { code: 'CAT-ANAESTHESIA', name: 'Anaesthesia', sortOrder: 3 },
  { code: 'CAT-MEDICATION', name: 'Medications', sortOrder: 4 },
  { code: 'CAT-CONSUMABLE', name: 'Consumables', sortOrder: 5 },
  { code: 'CAT-ADMISSION', name: 'Admission', sortOrder: 6 },
  { code: 'CAT-INVESTIGATION', name: 'Investigations', sortOrder: 7 },
];

const SERVICES: {
  code: string; name: string; kind: ChargeKind; categoryCode: string;
  unit?: string; price: number; requiresApproval?: boolean;
}[] = [
  { code: 'SURG-MAJOR-FEE', name: 'Major surgery — surgical fee', kind: 'PROFESSIONAL_SURGEON', categoryCode: 'CAT-PROFESSIONAL', price: naira(500_000) },
  { code: 'ANAE-FEE', name: 'Anaesthetist fee', kind: 'PROFESSIONAL_ANAESTHETIST', categoryCode: 'CAT-PROFESSIONAL', price: naira(100_000) },
  { code: 'THEATRE-MAJOR', name: 'Theatre fee — major', kind: 'THEATRE', categoryCode: 'CAT-THEATRE', price: naira(150_000) },
  { code: 'ANAE-DRUGS', name: 'Anaesthetic drugs', kind: 'ANAESTHESIA_DRUG', categoryCode: 'CAT-ANAESTHESIA', price: naira(75_000) },
  { code: 'PROC-DRUGS', name: 'Procedure drugs', kind: 'DRUG', categoryCode: 'CAT-MEDICATION', price: naira(40_000) },
  { code: 'IV-FLUIDS', name: 'IV fluids', kind: 'IV_FLUID', categoryCode: 'CAT-MEDICATION', price: naira(15_000) },
  { code: 'SURG-CONSUMABLES', name: 'Surgical consumables', kind: 'CONSUMABLE', categoryCode: 'CAT-CONSUMABLE', price: naira(80_000) },
  { code: 'DRESSING-PACK', name: 'Sterile dressing pack', kind: 'CONSUMABLE', categoryCode: 'CAT-CONSUMABLE', unit: 'pack', price: naira(3_500) },
  { code: 'NPWT-FOAM', name: 'NPWT foam', kind: 'CONSUMABLE', categoryCode: 'CAT-CONSUMABLE', price: naira(12_000) },
  { code: 'SUTURE', name: 'Suture', kind: 'CONSUMABLE', categoryCode: 'CAT-CONSUMABLE', price: naira(2_250) },
  { code: 'ADMISSION-DEPOSIT', name: 'Admission deposit', kind: 'ADMISSION_DEPOSIT', categoryCode: 'CAT-ADMISSION', price: naira(100_000) },
  { code: 'BED-DAY-GENERAL', name: 'Bed charge — general ward, per day', kind: 'BED_CHARGE', categoryCode: 'CAT-ADMISSION', unit: 'day', price: naira(15_000) },
];

// ---------------------------------------------------------------------------
// 4. Institutional policy (§50)
// ---------------------------------------------------------------------------
// §50 forbids hard-coding legal and regulatory rules. Each setting records the
// authority it rests on, so a figure can be DEFENDED rather than merely found.
const SETTINGS: { key: string; value: string; valueType: string; description: string; sourceReference?: string }[] = [
  {
    key: 'ALLOCATION_TIMING', value: 'ON_FULL_PAYMENT', valueType: 'ENUM',
    description: 'When revenue is allocated: ON_FULL_PAYMENT or PRO_RATA (§20).',
    sourceReference: 'Hospital finance policy — allocation on settlement',
  },
  {
    key: 'DEFAULT_TAX_BASIS_POINTS', value: '0', valueType: 'BASIS_POINTS',
    description: 'Default tax on hospital services. 0 where exempt; 750 = 7.5% VAT.',
    sourceReference: 'To be confirmed against current FIRS guidance before go-live',
  },
  {
    key: 'DISCOUNT_APPROVAL_THRESHOLD_BASIS_POINTS', value: '1000', valueType: 'BASIS_POINTS',
    description: 'A discount above this share of a charge needs a second approver (§22). 1000 = 10%.',
    sourceReference: 'Hospital finance policy',
  },
  {
    key: 'CONSUMABLE_DEVELOPMENT_LEVY_BASIS_POINTS', value: String(LEVY_BASIS_POINTS), valueType: 'BASIS_POINTS',
    description:
      'Share of consumables revenue levied to the hospital development fund. Recorded here for reporting; the operative configuration is the CONSUMABLE allocation rules, which are effective-dated.',
    sourceReference: 'Management directive — hospital development fund',
  },
  {
    key: 'SOD_ALLOW_SINGLE_OPERATOR', value: 'false', valueType: 'BOOLEAN',
    description:
      'Whether one person may hold both halves of an incompatible duty pair (§25). Intended only for a genuinely single-handed shift; every use is recorded and reported.',
    sourceReference: 'Hospital finance policy — separation of duties',
  },
  {
    key: 'IDEMPOTENCY_RETENTION_DAYS', value: '30', valueType: 'STRING',
    description: 'How long consumed idempotency keys are kept before pruning (§34).',
  },
];

// ---------------------------------------------------------------------------

async function main() {
  console.log('Seeding Central Theatre Revenue\n');

  // --- Revenue accounts ----------------------------------------------------
  for (const a of ACCOUNTS) {
    await prisma.revenueAccount.upsert({
      where: { code: a.code },
      update: { name: a.name, beneficiaryType: a.beneficiaryType, departmentName: a.departmentName ?? null, costCentre: a.costCentre ?? null },
      create: {
        code: a.code,
        name: a.name,
        beneficiaryType: a.beneficiaryType,
        departmentName: a.departmentName ?? null,
        costCentre: a.costCentre ?? null,
        effectiveFrom: EFFECTIVE_FROM,
      },
    });
  }
  console.log(`  revenue accounts        ${ACCOUNTS.length}`);

  const accountsByCode = new Map(
    (await prisma.revenueAccount.findMany({ select: { id: true, code: true } })).map((a) => [a.code, a.id])
  );

  // --- Allocation rules ----------------------------------------------------
  // Rules are effective-dated and never edited in place, so seeding is a
  // create-if-absent rather than an update: silently rewriting a live rule
  // would change how money already in flight is split.
  let rulesCreated = 0;
  for (const r of RULES) {
    const accountId = accountsByCode.get(r.accountCode);
    if (!accountId) throw new Error(`Seed error: no revenue account ${r.accountCode}`);

    const existing = await prisma.allocationRule.findFirst({
      where: { kind: r.kind, accountId, effectiveFrom: EFFECTIVE_FROM, effectiveTo: null },
    });
    if (existing) continue;

    await prisma.allocationRule.create({
      data: {
        kind: r.kind,
        accountId,
        type: r.type,
        shareBasisPoints: r.shareBasisPoints ?? null,
        amount: r.amount ?? null,
        priority: r.priority ?? 0,
        label: r.label ?? null,
        effectiveFrom: EFFECTIVE_FROM,
      },
    });
    rulesCreated += 1;
  }
  console.log(`  allocation rules        ${rulesCreated} created, ${RULES.length - rulesCreated} already present`);
  console.log(`    consumables levy      ${LEVY_BASIS_POINTS / 100}% -> ACCT-HOSPITAL-DEV, ${(10_000 - LEVY_BASIS_POINTS) / 100}% -> ACCT-CONSUMABLES`);

  // --- Catalogue -----------------------------------------------------------
  for (const c of CATEGORIES) {
    await prisma.serviceCategory.upsert({
      where: { code: c.code },
      update: { name: c.name, sortOrder: c.sortOrder },
      create: c,
    });
  }
  const categoriesByCode = new Map(
    (await prisma.serviceCategory.findMany({ select: { id: true, code: true } })).map((c) => [c.code, c.id])
  );

  for (const s of SERVICES) {
    const service = await prisma.service.upsert({
      where: { code: s.code },
      update: { name: s.name, kind: s.kind, categoryId: categoriesByCode.get(s.categoryCode) ?? null, unit: s.unit ?? 'each' },
      create: {
        code: s.code,
        name: s.name,
        kind: s.kind,
        unit: s.unit ?? 'each',
        categoryId: categoriesByCode.get(s.categoryCode) ?? null,
        requiresApproval: s.requiresApproval ?? false,
      },
    });

    // A price is only seeded if the service has none in force. Overwriting a
    // live tariff would silently reprice services somebody has already agreed.
    const currentPrice = await prisma.tariff.findFirst({
      where: { serviceId: service.id, effectiveTo: null },
    });
    if (!currentPrice) {
      await prisma.tariff.create({
        data: {
          serviceId: service.id,
          amount: s.price,
          effectiveFrom: EFFECTIVE_FROM,
          reason: 'Initial catalogue price, seeded at installation.',
        },
      });
    }
  }
  console.log(`  services and tariffs    ${SERVICES.length}`);

  // --- Payment providers (§9) ----------------------------------------------
  // DESK is always present and needs no credentials: it is the revenue desk, and
  // its payments are ATTESTED. The gateways are registered but INACTIVE until an
  // administrator supplies credentials — an unconfigured provider should be
  // unavailable, not broken.
  const deskChannels: PaymentChannel[] = ['CASH', 'POS', 'BANK_TRANSFER', 'CHEQUE', 'NHIS', 'HMO', 'WAIVER'];
  await prisma.paymentProvider.upsert({
    where: { code: 'DESK' },
    update: { supportedChannels: deskChannels },
    create: {
      code: 'DESK',
      name: 'Hospital revenue desk',
      isActive: true,
      supportsNativeSplit: false,
      supportedChannels: deskChannels,
    },
  });

  const gatewayChannels: PaymentChannel[] = ['CARD', 'BANK_TRANSFER', 'USSD', 'PAYMENT_LINK'];
  for (const g of [
    { code: 'PAYSTACK', name: 'Paystack', secretEnvKey: 'PAYSTACK_SECRET_KEY', webhookEnvKey: 'PAYSTACK_SECRET_KEY' },
    { code: 'FLUTTERWAVE', name: 'Flutterwave', secretEnvKey: 'FLUTTERWAVE_SECRET_KEY', webhookEnvKey: 'FLUTTERWAVE_WEBHOOK_HASH' },
  ]) {
    await prisma.paymentProvider.upsert({
      where: { code: g.code },
      update: {},
      create: {
        code: g.code,
        name: g.name,
        // Inactive until credentials are configured and the provider is enabled
        // deliberately by an administrator.
        isActive: false,
        supportsNativeSplit: true,
        secretEnvKey: g.secretEnvKey,
        webhookEnvKey: g.webhookEnvKey,
        supportedChannels: gatewayChannels,
      },
    });
  }
  console.log('  payment providers       3 (DESK active; gateways inactive until configured)');

  // --- Policy settings -----------------------------------------------------
  for (const s of SETTINGS) {
    await prisma.organisationSetting.upsert({
      where: { key: s.key },
      update: { description: s.description, sourceReference: s.sourceReference ?? null },
      // The VALUE is not updated on re-seed: it may have been changed on purpose.
      create: {
        key: s.key,
        value: s.value,
        valueType: s.valueType,
        description: s.description,
        sourceReference: s.sourceReference ?? null,
      },
    });
  }
  console.log(`  policy settings         ${SETTINGS.length}`);

  // --- Administrator accounts (§24, §25, §42) -------------------------------
  //
  // TWO SEPARATE ACCOUNTS, deliberately, and this is not bureaucracy.
  //
  //   SUPER ADMINISTRATOR    system administration. Holds every permission,
  //                          which is exactly why it should be used rarely and
  //                          why every act it takes is audited. §24 calls it
  //                          "tightly controlled".
  //
  //   FINANCE ADMINISTRATOR  the day-to-day office that configures accounts,
  //                          allocation rules, beneficiaries and prices — and
  //                          which CANNOT confirm a payment or approve a refund.
  //
  // Giving one person both would recreate exactly the concentration §25 forbids,
  // so reviewRoleCombination() would reject the pair. They are separate accounts
  // for separate people.
  //
  // NEITHER IS CREATED WITH A DEFAULT PASSWORD. A known-password administrator
  // is how a financial system is owned on its first day. Each is created only
  // when its password is supplied explicitly in the environment.
  const admins: { envEmail: string; envPassword: string; role: 'SUPER_ADMINISTRATOR' | 'FINANCE_ADMINISTRATOR'; label: string; designation: string }[] = [
    {
      envEmail: 'SEED_SUPERADMIN_EMAIL',
      envPassword: 'SEED_SUPERADMIN_PASSWORD',
      role: 'SUPER_ADMINISTRATOR',
      label: 'System administrator',
      designation: 'Super Administrator',
    },
    {
      envEmail: 'SEED_ADMIN_EMAIL',
      envPassword: 'SEED_ADMIN_PASSWORD',
      role: 'FINANCE_ADMINISTRATOR',
      label: 'Finance administrator',
      designation: 'Finance Administrator',
    },
  ];

  let created = 0;
  for (const admin of admins) {
    const email = process.env[admin.envEmail]?.trim().toLowerCase();
    const password = process.env[admin.envPassword];

    if (!email || !password) {
      console.log(`  ${admin.label.padEnd(22)} skipped — set ${admin.envEmail} and ${admin.envPassword}`);
      continue;
    }
    if (password.length < 12) {
      throw new Error(
        `${admin.envPassword} must be at least 12 characters. This account can change where money is sent.`
      );
    }

    const user = await prisma.user.upsert({
      where: { email },
      update: { fullName: admin.label, designation: admin.designation, status: 'ACTIVE' },
      create: {
        email,
        fullName: admin.label,
        designation: admin.designation,
        passwordHash: await bcrypt.hash(password, 12),
        status: 'ACTIVE',
        // §42 requires MFA for financial administration. The account exists but
        // the route guard REFUSES every configuration action until a second
        // factor is enrolled — so this false is a live control, not a to-do.
        mfaEnabled: false,
      },
    });

    await prisma.roleAssignment.upsert({
      where: { userId_role: { userId: user.id, role: admin.role } },
      update: { isActive: true },
      create: {
        userId: user.id,
        role: admin.role,
        reason: 'Created at installation.',
      },
    });

    console.log(`  ${admin.label.padEnd(22)} ${email} (${admin.role})`);
    created += 1;
  }

  if (created > 0) {
    console.log('');
    console.log('  ENROL MFA ON EACH ADMINISTRATOR BEFORE GO-LIVE.');
    console.log('  Until then, every configuration route will refuse them with MFA_REQUIRED.');
    console.log('  Change the seeded passwords too — they have been in an environment variable.');
  }

  console.log('\nDone.');
}

main()
  .catch((err) => {
    console.error('\nSeed failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

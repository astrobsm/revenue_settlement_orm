// ============================================================
// Roles, permissions and separation of duties (§24, §25)
// ------------------------------------------------------------
// Two different questions live here, and conflating them is how financial
// systems get quietly captured by one determined person:
//
//   1. MAY THIS ROLE DO THIS AT ALL?           — the permission matrix
//   2. MAY THIS PERSON DO IT ON THIS RECORD?   — separation of duties
//
// The second question is the one that matters most, and the one most systems
// omit. A cashier holding "payment:confirm" is unremarkable. The same cashier
// confirming a payment against an invoice whose price THEY overrode is a fraud
// with no third party in it anywhere. Permission checks alone cannot see that;
// they have no memory of who did what earlier.
//
// So high-risk actions are checked twice: once against the matrix, and once
// against the record's own history via checkSeparationOfDuties().
//
// The API check is the SECURITY BOUNDARY. The UI reads the same matrix only to
// avoid showing controls that will fail — a hidden button is a courtesy, never a
// control.
// ============================================================

/**
 * Roles are §24's list, named as this hospital names its offices.
 *
 * Clinical roles appear because §24 gives surgeons and anaesthetists the right
 * to REQUEST services and see billing status. They can request; they cannot
 * price, confirm or settle.
 */
export type RevenueRole =
  // Revenue cycle
  | 'REVENUE_OFFICER'
  | 'CASHIER'
  | 'FINANCE_OFFICER'
  | 'FINANCE_ADMINISTRATOR'
  | 'AUDITOR'
  | 'SUPER_ADMINISTRATOR'
  // Service originators
  | 'SURGEON'
  | 'ANAESTHETIST'
  | 'PHARMACY'
  | 'STORES'
  | 'LABORATORY';

export const ALL_ROLES: RevenueRole[] = [
  'REVENUE_OFFICER', 'CASHIER', 'FINANCE_OFFICER', 'FINANCE_ADMINISTRATOR',
  'AUDITOR', 'SUPER_ADMINISTRATOR', 'SURGEON', 'ANAESTHETIST', 'PHARMACY',
  'STORES', 'LABORATORY',
];

/** Permissions are `resource:action`. The matrix below is the single authority. */
export const Permission = {
  // Service catalogue and prices
  CATALOGUE_VIEW: 'catalogue:view',
  CATALOGUE_MANAGE: 'catalogue:manage',
  PRICE_OVERRIDE_REQUEST: 'price:override-request',
  PRICE_OVERRIDE_APPROVE: 'price:override-approve',

  // Invoices
  INVOICE_VIEW: 'invoice:view',
  INVOICE_CREATE: 'invoice:create',
  INVOICE_ADD_ITEM: 'invoice:add-item',
  INVOICE_ISSUE: 'invoice:issue',
  INVOICE_CANCEL: 'invoice:cancel',
  DISCOUNT_REQUEST: 'discount:request',
  DISCOUNT_APPROVE: 'discount:approve',

  // Money in
  PAYMENT_VIEW: 'payment:view',
  PAYMENT_INITIATE: 'payment:initiate',
  /** Recording that money was actually taken. The dangerous one. */
  PAYMENT_CONFIRM: 'payment:confirm',
  PAYMENT_REVERSE: 'payment:reverse',
  RECEIPT_ISSUE: 'receipt:issue',
  RECEIPT_VERIFY: 'receipt:verify',

  // Money out
  REFUND_REQUEST: 'refund:request',
  REFUND_APPROVE: 'refund:approve',
  SETTLEMENT_VIEW: 'settlement:view',
  SETTLEMENT_INITIATE: 'settlement:initiate',
  SETTLEMENT_CONFIRM: 'settlement:confirm',

  // Configuration — the keys to where money goes
  ACCOUNT_VIEW: 'account:view',
  ACCOUNT_MANAGE: 'account:manage',
  ALLOCATION_RULE_VIEW: 'allocation-rule:view',
  ALLOCATION_RULE_MANAGE: 'allocation-rule:manage',
  BENEFICIARY_MANAGE: 'beneficiary:manage',
  PROVIDER_MANAGE: 'provider:manage',

  // Oversight
  LEDGER_VIEW: 'ledger:view',
  RECONCILIATION_VIEW: 'reconciliation:view',
  RECONCILIATION_RUN: 'reconciliation:run',
  RECONCILIATION_RESOLVE: 'reconciliation:resolve',
  REPORT_VIEW: 'report:view',
  REPORT_EXPORT: 'report:export',
  AUDIT_VIEW: 'audit:view',

  // Deposits
  DEPOSIT_VIEW: 'deposit:view',
  DEPOSIT_APPLY: 'deposit:apply',
} as const;

export type PermissionValue = (typeof Permission)[keyof typeof Permission];

const P = Permission;

/**
 * The matrix.
 *
 * Read it as a statement of who is trusted with what. Three properties are
 * deliberate and should survive future edits:
 *
 *   - AUDITOR has no write permission of any kind. Not one. An auditor who can
 *     change a record cannot audit it.
 *   - No role holds both PAYMENT_CONFIRM and ALLOCATION_RULE_MANAGE. Confirming
 *     money and deciding where money goes are the two halves of the fraud §25
 *     is written to prevent.
 *   - FINANCE_ADMINISTRATOR configures but never confirms; CASHIER confirms but
 *     never configures.
 */
const MATRIX: Record<RevenueRole, PermissionValue[]> = {
  REVENUE_OFFICER: [
    P.CATALOGUE_VIEW, P.INVOICE_VIEW, P.INVOICE_CREATE, P.INVOICE_ADD_ITEM,
    P.INVOICE_ISSUE, P.PRICE_OVERRIDE_REQUEST, P.DISCOUNT_REQUEST,
    P.PAYMENT_VIEW, P.PAYMENT_INITIATE, P.RECEIPT_ISSUE, P.RECEIPT_VERIFY,
    P.DEPOSIT_VIEW, P.REPORT_VIEW,
  ],

  CASHIER: [
    P.CATALOGUE_VIEW, P.INVOICE_VIEW,
    P.PAYMENT_VIEW, P.PAYMENT_INITIATE, P.PAYMENT_CONFIRM,
    P.RECEIPT_ISSUE, P.RECEIPT_VERIFY, P.DEPOSIT_VIEW, P.REPORT_VIEW,
  ],

  FINANCE_OFFICER: [
    P.CATALOGUE_VIEW, P.INVOICE_VIEW, P.PAYMENT_VIEW, P.PAYMENT_REVERSE,
    P.DISCOUNT_APPROVE, P.PRICE_OVERRIDE_APPROVE,
    P.REFUND_REQUEST, P.REFUND_APPROVE,
    P.SETTLEMENT_VIEW, P.SETTLEMENT_INITIATE, P.SETTLEMENT_CONFIRM,
    P.ACCOUNT_VIEW, P.ALLOCATION_RULE_VIEW,
    P.LEDGER_VIEW, P.RECONCILIATION_VIEW, P.RECONCILIATION_RUN, P.RECONCILIATION_RESOLVE,
    P.DEPOSIT_VIEW, P.DEPOSIT_APPLY, P.REPORT_VIEW, P.REPORT_EXPORT,
  ],

  FINANCE_ADMINISTRATOR: [
    P.CATALOGUE_VIEW, P.CATALOGUE_MANAGE,
    P.INVOICE_VIEW,
    P.ACCOUNT_VIEW, P.ACCOUNT_MANAGE,
    P.ALLOCATION_RULE_VIEW, P.ALLOCATION_RULE_MANAGE,
    P.BENEFICIARY_MANAGE, P.PROVIDER_MANAGE,
    P.SETTLEMENT_VIEW, P.LEDGER_VIEW, P.RECONCILIATION_VIEW,
    P.REPORT_VIEW, P.REPORT_EXPORT,
    // Note the absence of PAYMENT_CONFIRM and of every refund permission.
  ],

  // Read-only, completely. §24.
  AUDITOR: [
    P.CATALOGUE_VIEW, P.INVOICE_VIEW, P.PAYMENT_VIEW, P.SETTLEMENT_VIEW,
    P.ACCOUNT_VIEW, P.ALLOCATION_RULE_VIEW, P.LEDGER_VIEW,
    P.RECONCILIATION_VIEW, P.REPORT_VIEW, P.REPORT_EXPORT,
    P.AUDIT_VIEW, P.DEPOSIT_VIEW, P.RECEIPT_VERIFY,
  ],

  /**
   * Tightly controlled system administration (§24). Holds everything, which is
   * exactly why every action it takes is audited and why checkSeparationOfDuties
   * does NOT exempt it — see the note in that function.
   */
  SUPER_ADMINISTRATOR: Object.values(P),

  // --- Service originators: may ask, may not price or confirm ---------------
  SURGEON: [P.CATALOGUE_VIEW, P.INVOICE_VIEW, P.INVOICE_ADD_ITEM, P.PAYMENT_VIEW],
  ANAESTHETIST: [P.CATALOGUE_VIEW, P.INVOICE_VIEW, P.INVOICE_ADD_ITEM, P.PAYMENT_VIEW],
  PHARMACY: [P.CATALOGUE_VIEW, P.INVOICE_VIEW, P.INVOICE_ADD_ITEM, P.PAYMENT_VIEW, P.SETTLEMENT_VIEW],
  STORES: [P.CATALOGUE_VIEW, P.INVOICE_VIEW, P.INVOICE_ADD_ITEM, P.PAYMENT_VIEW, P.SETTLEMENT_VIEW],
  LABORATORY: [P.CATALOGUE_VIEW, P.INVOICE_VIEW, P.INVOICE_ADD_ITEM, P.PAYMENT_VIEW],
};

export function permissionsFor(roles: RevenueRole[]): Set<PermissionValue> {
  const out = new Set<PermissionValue>();
  for (const role of roles) for (const p of MATRIX[role] ?? []) out.add(p);
  return out;
}

export function can(roles: RevenueRole[], permission: PermissionValue): boolean {
  return permissionsFor(roles).has(permission);
}

/** Every permission a role holds. Used by the settings screen and by tests. */
export function matrixFor(role: RevenueRole): PermissionValue[] {
  return [...(MATRIX[role] ?? [])];
}

// ---------------------------------------------------------------------------
// Separation of duties (§25)
// ---------------------------------------------------------------------------

/**
 * The pairs §25 names. Holding one of these duties on a record bars the same
 * person from the other on that SAME record.
 *
 * These are about a specific invoice or payment, not about the role in general:
 * a hospital with three finance staff cannot function if a cashier is barred
 * from every invoice a colleague touched. The bar is per record.
 */
export const INCOMPATIBLE_DUTIES: { a: string; b: string; why: string }[] = [
  {
    a: 'PRICE_OVERRIDDEN',
    b: 'PAYMENT_CONFIRMED',
    why: 'The person who changed the price must not also be the person who confirms the money was received.',
  },
  {
    a: 'INVOICE_CREATED',
    b: 'PAYMENT_CONFIRMED',
    why: 'Raising a bill and confirming its payment are the two halves of an invented charge.',
  },
  {
    a: 'DISCOUNT_APPLIED',
    b: 'DISCOUNT_APPROVED',
    why: 'A discount cannot be approved by the person who applied it.',
  },
  {
    a: 'REFUND_REQUESTED',
    b: 'REFUND_APPROVED',
    why: 'A refund cannot be approved by the person who requested it.',
  },
  {
    a: 'ALLOCATION_RULE_CHANGED',
    b: 'SETTLEMENT_CONFIRMED',
    why: 'Changing where money goes and confirming it went there must be different people.',
  },
  {
    a: 'BENEFICIARY_CHANGED',
    b: 'SETTLEMENT_CONFIRMED',
    why: 'Changing a bank destination and confirming a transfer to it must be different people.',
  },
];

/** One thing a user already did to a record, as recorded in the audit trail. */
export interface PriorAct {
  duty: string;
  userId: string;
  at?: Date | string;
}

export interface SoDVerdict {
  allowed: boolean;
  code?: string;
  message?: string;
  /** Which prior act blocked it — named, so the refusal can be explained. */
  conflictingDuty?: string;
}

/**
 * May `userId` perform `duty` on a record, given what has already been done to it?
 *
 * `priorActs` comes from the record's own audit trail. This is why §33's audit
 * log is not merely a report: it is an INPUT to the control. A system that logs
 * nothing cannot enforce separation of duties at all, which is why the audit
 * write and the SoD check are built together here rather than in different phases.
 *
 * SUPER_ADMINISTRATOR IS NOT EXEMPT. It would be easy to let it through — it
 * holds every permission — but an exemption is a door, and a door in a
 * separation-of-duties control is the whole control. An institution that must
 * override this does so by policy, in the open, through the emergency procedure,
 * with a reason recorded. Not by holding a role.
 */
export function checkSeparationOfDuties(params: {
  userId: string;
  duty: string;
  priorActs: PriorAct[];
  /**
   * Set true only where institutional policy genuinely permits one person to
   * hold both duties — a single-handed night shift, for example. It does not
   * skip the check; it downgrades the refusal to a recorded warning, and the
   * caller MUST persist that warning.
   */
  policyAllowsSelfService?: boolean;
}): SoDVerdict {
  const { userId, duty, priorActs, policyAllowsSelfService = false } = params;

  for (const pair of INCOMPATIBLE_DUTIES) {
    const other = pair.a === duty ? pair.b : pair.b === duty ? pair.a : null;
    if (!other) continue;

    const conflict = priorActs.find((act) => act.duty === other && act.userId === userId);
    if (!conflict) continue;

    if (policyAllowsSelfService) {
      return {
        allowed: true,
        code: 'SOD_OVERRIDDEN',
        message: `${pair.why} This has been permitted under the single-operator policy and must be recorded and reviewed.`,
        conflictingDuty: other,
      };
    }

    return {
      allowed: false,
      code: 'SEPARATION_OF_DUTIES',
      message: `${pair.why} You already performed ${other} on this record, so somebody else must carry out ${duty}.`,
      conflictingDuty: other,
    };
  }

  return { allowed: true };
}

/**
 * Does this set of roles concentrate too much power in one person, regardless of
 * any particular record?
 *
 * For the administration screen that assigns roles: it is better to refuse the
 * combination at assignment time than to discover it during an audit. §25's list
 * is the source of the pairs.
 */
export function reviewRoleCombination(roles: RevenueRole[]): { safe: boolean; concerns: string[] } {
  const held = permissionsFor(roles);
  const concerns: string[] = [];

  const conflicts: [PermissionValue, PermissionValue, string][] = [
    [P.PAYMENT_CONFIRM, P.ALLOCATION_RULE_MANAGE, 'confirm payments and decide where revenue is allocated'],
    [P.PAYMENT_CONFIRM, P.ACCOUNT_MANAGE, 'confirm payments and change the bank accounts money is sent to'],
    [P.PAYMENT_CONFIRM, P.CATALOGUE_MANAGE, 'confirm payments and set the prices being charged'],
    [P.REFUND_REQUEST, P.REFUND_APPROVE, 'both request and approve refunds'],
    [P.DISCOUNT_REQUEST, P.DISCOUNT_APPROVE, 'both request and approve discounts'],
    [P.SETTLEMENT_CONFIRM, P.BENEFICIARY_MANAGE, 'change a beneficiary and confirm a settlement to it'],
    [P.INVOICE_CREATE, P.PAYMENT_CONFIRM, 'raise an invoice and confirm its payment'],
  ];

  for (const [a, b, description] of conflicts) {
    if (held.has(a) && held.has(b)) {
      concerns.push(`This combination lets one person ${description}. §25 requires these to be separate people.`);
    }
  }

  if (roles.includes('AUDITOR') && roles.length > 1) {
    concerns.push('An auditor with any other role is auditing their own work. Give the auditor role alone.');
  }

  return { safe: concerns.length === 0, concerns };
}

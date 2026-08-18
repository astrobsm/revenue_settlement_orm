// ============================================================
// The consolidated bill (§4, §6, §7, §20, §22, §23, §40, §44)
// ------------------------------------------------------------
// §1's whole point: a surgical patient must not queue seven times. Theatre,
// surgeon, anaesthetist, drugs, fluids, consumables and admission arrive here as
// separate charge requests from separate departments and leave as ONE invoice
// with ONE total.
//
// Assembly is a PURE FUNCTION of plain rows. No database, no session, no clock
// except the one passed in. That is what lets the arithmetic on a patient's bill
// be tested exhaustively — and a bill is the one thing in a hospital that a
// patient will check by hand.
//
// Two rules are load-bearing and must not be softened:
//
//   1. THE PRICE IS THE ONE CAPTURED WHEN THE CHARGE WAS RAISED, never today's.
//      A patient agreed a figure; a tariff revised between booking and surgery
//      must not move their bill. (§40)
//
//   2. THE PATIENT IS BILLED FOR WHAT WAS USED, never for what was requested,
//      issued or wasted. A dropped vial is the hospital's loss, not a line on
//      somebody's bill. Callers pass quantityUsed; this module never infers a
//      quantity from a request.
// ============================================================

import { applyBasisPoints, assertKobo, BASIS_POINTS_TOTAL, formatNaira } from './money';

/** §5's categories, as charge kinds. Configurable in the catalogue; these are the routing keys. */
export type ChargeKind =
  | 'PROFESSIONAL_SURGEON'
  | 'PROFESSIONAL_ANAESTHETIST'
  | 'PROFESSIONAL_OTHER'
  | 'THEATRE'
  | 'ANAESTHESIA_DRUG'
  | 'ANAESTHESIA_CONSUMABLE'
  | 'DRUG'
  | 'IV_FLUID'
  | 'CONSUMABLE'
  | 'IMPLANT'
  | 'CSSD'
  | 'ADMISSION_DEPOSIT'
  | 'BED_CHARGE'
  | 'NURSING'
  | 'INVESTIGATION_LAB'
  | 'INVESTIGATION_IMAGING'
  | 'BLOOD'
  | 'OXYGEN'
  | 'RECOVERY'
  | 'POSTOP_SERVICE'
  | 'OTHER';

/**
 * Charge kinds that are a DEPOSIT rather than a service rendered (§21).
 *
 * Money taken against one of these is a liability the hospital owes the patient
 * until services are actually consumed. Booking it as earned revenue overstates
 * income and is the accounting defect §21 exists to prevent — so the invoice
 * builder separates it out and the allocation engine is never given it as
 * revenue.
 */
const DEPOSIT_KINDS: ChargeKind[] = ['ADMISSION_DEPOSIT'];

export function isDepositKind(kind: ChargeKind): boolean {
  return DEPOSIT_KINDS.includes(kind);
}

/** A charge as raised by a department, already priced. */
export interface ChargeRequest {
  /** Stable id from the requesting module, so a charge can be traced back. */
  sourceRef: string;
  /** Which ORM module or desk raised it — 'ORM_RESERVATION', 'PHARMACY', 'MANUAL'. */
  sourceKind: string;
  kind: ChargeKind;
  description: string;
  /** What was USED. Never what was requested. */
  quantity: number;
  /** Kobo, captured when the charge was raised. */
  unitPrice: number;
  /** The tariff row this price came from, for re-derivation. */
  tariffId?: string | null;
  /** A named beneficiary overriding the generic rule — consignment vendor, etc. */
  overrideAccountId?: string | null;
  /** Set when a price override was authorised. Both figures are kept (§22). */
  override?: {
    originalUnitPrice: number;
    reason: string;
    requestedByUserId: string;
    approvedByUserId: string;
  } | null;
}

export interface InvoiceLineDraft {
  sourceRef: string;
  sourceKind: string;
  kind: ChargeKind;
  description: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  tariffId: string | null;
  overrideAccountId: string | null;
  isDeposit: boolean;
}

export interface InvoiceDraft {
  lines: InvoiceLineDraft[];
  /** Sum of all service lines and deposit lines. */
  subtotal: number;
  discount: number;
  /** Tax is computed on the discounted SERVICE total only — a deposit is not a sale. */
  tax: number;
  total: number;
  /** How much of `total` is deposit rather than earned revenue (§21). */
  depositComponent: number;
  /** How much of `total` is for services rendered. */
  serviceComponent: number;
  /** Grouped for printing, in the order a patient expects to read them (§7). */
  sections: { kind: ChargeKind; label: string; lines: InvoiceLineDraft[]; subtotal: number }[];
}

/**
 * The order sections appear on a printed bill.
 *
 * A patient reading their bill expects the operation at the top, not the
 * fourteenth packet of gauze. Deposits go last because they are not a charge for
 * anything and explaining them mid-bill invites confusion.
 */
const SECTION_ORDER: ChargeKind[] = [
  'PROFESSIONAL_SURGEON', 'PROFESSIONAL_ANAESTHETIST', 'PROFESSIONAL_OTHER',
  'THEATRE', 'RECOVERY', 'CSSD',
  'ANAESTHESIA_DRUG', 'ANAESTHESIA_CONSUMABLE',
  'DRUG', 'IV_FLUID',
  'CONSUMABLE', 'IMPLANT',
  'INVESTIGATION_LAB', 'INVESTIGATION_IMAGING', 'BLOOD', 'OXYGEN',
  'BED_CHARGE', 'NURSING', 'POSTOP_SERVICE',
  'OTHER',
  'ADMISSION_DEPOSIT',
];

export const SECTION_LABELS: Record<ChargeKind, string> = {
  PROFESSIONAL_SURGEON: 'Surgical professional fee',
  PROFESSIONAL_ANAESTHETIST: 'Anaesthetist fee',
  PROFESSIONAL_OTHER: 'Other professional fees',
  THEATRE: 'Theatre',
  ANAESTHESIA_DRUG: 'Anaesthetic drugs',
  ANAESTHESIA_CONSUMABLE: 'Anaesthetic consumables',
  DRUG: 'Medications',
  IV_FLUID: 'IV fluids',
  CONSUMABLE: 'Consumables',
  IMPLANT: 'Implants and devices',
  CSSD: 'CSSD',
  ADMISSION_DEPOSIT: 'Admission deposit',
  BED_CHARGE: 'Bed charges',
  NURSING: 'Nursing',
  INVESTIGATION_LAB: 'Laboratory',
  INVESTIGATION_IMAGING: 'Imaging',
  BLOOD: 'Blood and blood products',
  OXYGEN: 'Oxygen',
  RECOVERY: 'Recovery',
  POSTOP_SERVICE: 'Post-operative services',
  OTHER: 'Other approved charges',
};

export class InvoiceError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'InvoiceError';
    this.code = code;
  }
}

/**
 * Turn charge requests into one bill.
 *
 * A zero-quantity charge produces NO line. A reservation returned in full cost
 * the patient nothing, and a zero line on a bill invites the reasonable question
 * "why am I being charged for this?".
 */
export function buildInvoice(params: {
  charges: ChargeRequest[];
  /** Kobo. Capped at the service subtotal — a discount cannot exceed the bill. */
  discount?: number;
  /** Basis points, e.g. 750 for 7.5%. Zero where hospital services are exempt. */
  taxBasisPoints?: number;
}): InvoiceDraft {
  const { charges, discount = 0, taxBasisPoints = 0 } = params;

  if (!Number.isInteger(taxBasisPoints) || taxBasisPoints < 0) {
    throw new InvoiceError('INVALID_TAX', `Tax must be a non-negative integer number of basis points, got ${taxBasisPoints}.`);
  }

  const lines: InvoiceLineDraft[] = [];

  for (const charge of charges) {
    if (!Number.isInteger(charge.quantity) || charge.quantity < 0) {
      throw new InvoiceError(
        'INVALID_QUANTITY',
        `"${charge.description}" has a quantity of ${charge.quantity}. A quantity must be a whole number and cannot be negative.`
      );
    }
    if (charge.quantity === 0) continue;

    assertKobo(charge.unitPrice, `unit price for "${charge.description}"`);
    if (charge.unitPrice < 0) {
      throw new InvoiceError('INVALID_PRICE', `"${charge.description}" has a negative unit price. Use a credit note instead (§23).`);
    }

    lines.push({
      sourceRef: charge.sourceRef,
      sourceKind: charge.sourceKind,
      kind: charge.kind,
      description: charge.description,
      quantity: charge.quantity,
      unitPrice: charge.unitPrice,
      lineTotal: charge.unitPrice * charge.quantity,
      tariffId: charge.tariffId ?? null,
      overrideAccountId: charge.overrideAccountId ?? null,
      isDeposit: isDepositKind(charge.kind),
    });
  }

  const depositComponent = lines.filter((l) => l.isDeposit).reduce((s, l) => s + l.lineTotal, 0);
  const serviceSubtotal = lines.filter((l) => !l.isDeposit).reduce((s, l) => s + l.lineTotal, 0);
  const subtotal = serviceSubtotal + depositComponent;

  // A discount reduces services, never a deposit: discounting a deposit is
  // simply asking for a smaller deposit, which is a different decision.
  assertKobo(discount, 'discount');
  if (discount < 0) throw new InvoiceError('INVALID_DISCOUNT', 'A discount cannot be negative.');
  const cappedDiscount = Math.min(discount, serviceSubtotal);

  const taxable = serviceSubtotal - cappedDiscount;
  const tax = applyBasisPoints(taxable, taxBasisPoints);
  const total = taxable + tax + depositComponent;

  // Sections, in reading order.
  const sections = SECTION_ORDER
    .map((kind) => {
      const sectionLines = lines.filter((l) => l.kind === kind);
      return {
        kind,
        label: SECTION_LABELS[kind],
        lines: sectionLines,
        subtotal: sectionLines.reduce((s, l) => s + l.lineTotal, 0),
      };
    })
    .filter((s) => s.lines.length > 0);

  return {
    lines,
    subtotal,
    discount: cappedDiscount,
    tax,
    total,
    depositComponent,
    serviceComponent: taxable + tax,
    sections,
  };
}

// ---------------------------------------------------------------------------
// Invoice status
// ---------------------------------------------------------------------------

export type InvoiceStatus =
  | 'DRAFT'
  | 'AWAITING_APPROVAL'
  | 'ISSUED'
  | 'PARTIALLY_PAID'
  | 'PAID'
  | 'OVERPAID'
  | 'CANCELLED'
  | 'REFUNDED';

/** What is still owed. Never negative — an overpayment is a credit, not a debt. */
export function balanceOf(invoice: { total: number; amountPaid: number }): number {
  return Math.max(0, invoice.total - invoice.amountPaid);
}

/** Paid beyond the bill. Named so it can be refunded rather than quietly kept. */
export function overpaymentOf(invoice: { total: number; amountPaid: number }): number {
  return Math.max(0, invoice.amountPaid - invoice.total);
}

/**
 * The status a payment leaves an invoice in.
 *
 * A cancelled or refunded invoice stays as it is: taking money against a
 * cancelled bill is a mistake to be corrected, not a state change to record
 * silently.
 */
export function statusAfterPayment(params: { current: InvoiceStatus; total: number; amountPaid: number }): InvoiceStatus {
  const { current, total, amountPaid } = params;
  if (current === 'CANCELLED' || current === 'REFUNDED') return current;
  if (amountPaid <= 0) return current === 'DRAFT' || current === 'AWAITING_APPROVAL' ? current : 'ISSUED';
  if (amountPaid > total) return 'OVERPAID';
  if (amountPaid === total) return 'PAID';
  return 'PARTIALLY_PAID';
}

/**
 * An invoice becomes read-only once money has been taken against it or it has
 * been cancelled (§23, §44). Correcting one after that is an adjustment or a
 * credit note — a NEW financial record — never an edit to the old one.
 */
export function isLocked(status: InvoiceStatus): boolean {
  return status === 'PAID' || status === 'OVERPAID' || status === 'PARTIALLY_PAID' || status === 'CANCELLED' || status === 'REFUNDED';
}

export interface PaymentAcceptance {
  allowed: boolean;
  code?: string;
  message?: string;
}

/**
 * May this payment be accepted against this invoice?
 *
 * Overpayment is REFUSED rather than taken and refunded later. At a hospital
 * cash desk the commonest cause of an overpayment is keying the wrong invoice
 * number, and taking the money makes that far harder to unpick — for the patient
 * most of all — than declining it does.
 */
export function canAcceptPayment(params: {
  status: InvoiceStatus;
  total: number;
  amountPaid: number;
  payment: number;
}): PaymentAcceptance {
  const { status, total, amountPaid, payment } = params;

  if (!Number.isInteger(payment) || payment <= 0) {
    return { allowed: false, code: 'INVALID_AMOUNT', message: 'A payment must be a whole number of kobo greater than zero.' };
  }
  if (status === 'CANCELLED') {
    return { allowed: false, code: 'INVOICE_CANCELLED', message: 'This invoice has been cancelled. No payment can be taken against it.' };
  }
  if (status === 'REFUNDED') {
    return { allowed: false, code: 'INVOICE_REFUNDED', message: 'This invoice has been refunded. Raise a new invoice rather than paying this one.' };
  }
  if (status === 'DRAFT' || status === 'AWAITING_APPROVAL') {
    return { allowed: false, code: 'INVOICE_NOT_ISSUED', message: 'This invoice has not been issued yet. It must be reviewed and issued before payment is taken (§39).' };
  }
  if (status === 'PAID' || status === 'OVERPAID') {
    return { allowed: false, code: 'ALREADY_PAID', message: 'This invoice is already paid in full.' };
  }

  const outstanding = total - amountPaid;
  if (payment > outstanding) {
    return {
      allowed: false,
      code: 'EXCEEDS_BALANCE',
      message: `Only ${formatNaira(outstanding)} is outstanding on this invoice, but ${formatNaira(payment)} was tendered. Check the invoice number before taking the money.`,
    };
  }

  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Allocation timing (§20)
// ---------------------------------------------------------------------------

export type AllocationTiming = 'ON_FULL_PAYMENT' | 'PRO_RATA';

/**
 * How much of the invoice should be allocated now, given a payment?
 *
 * ON_FULL_PAYMENT (the recommended default) allocates nothing until the invoice
 * is settled, then allocates the whole thing once. A split computed repeatedly
 * against a moving balance has to be unwound if any instalment is later
 * reversed, and unwinding a partially settled distribution is the single
 * fiddliest thing in a revenue system.
 *
 * PRO_RATA allocates each instalment as it arrives, which some institutions
 * require so departments are not kept waiting on a patient's last instalment.
 * It is exact — each instalment is allocated in full, so the shares always sum
 * to money actually received — but reversal must then recover from accounts
 * that may already have been settled (§19).
 */
export function amountToAllocate(params: {
  timing: AllocationTiming;
  paymentAmount: number;
  totalPaidAfter: number;
  invoiceTotal: number;
}): number {
  const { timing, paymentAmount, totalPaidAfter, invoiceTotal } = params;

  if (timing === 'PRO_RATA') {
    // Allocate exactly what arrived, never more than the bill.
    return Math.min(paymentAmount, Math.max(0, invoiceTotal - (totalPaidAfter - paymentAmount)));
  }

  // ON_FULL_PAYMENT: nothing until settled, then the whole invoice at once.
  return totalPaidAfter >= invoiceTotal ? invoiceTotal : 0;
}

// ---------------------------------------------------------------------------
// Overrides and discounts (§22)
// ---------------------------------------------------------------------------

export interface OverrideCheck {
  allowed: boolean;
  code?: string;
  message?: string;
  /** True when this override must be approved by someone else before it applies. */
  requiresApproval?: boolean;
}

/**
 * Is this price override or discount acceptable, and does it need approval?
 *
 * The threshold is configuration, not a constant here: what counts as a large
 * discount at a teaching hospital is an institutional decision (§50). What is
 * NOT configurable is that a reason is always required and both figures are
 * always kept.
 */
export function checkOverride(params: {
  originalAmount: number;
  newAmount: number;
  reason: string;
  /** Basis points of the original above which approval is required. */
  approvalThresholdBasisPoints: number;
}): OverrideCheck {
  const { originalAmount, newAmount, reason, approvalThresholdBasisPoints } = params;

  assertKobo(originalAmount, 'original amount');
  assertKobo(newAmount, 'new amount');

  const trimmed = reason?.trim() ?? '';
  if (trimmed.length < 10) {
    return {
      allowed: false,
      code: 'REASON_REQUIRED',
      message: 'A price change needs a reason that will still make sense to an auditor next year. Give at least a short sentence.',
    };
  }
  if (newAmount < 0) {
    return { allowed: false, code: 'NEGATIVE_PRICE', message: 'A price cannot be negative. Use a credit note (§23).' };
  }
  if (newAmount === originalAmount) {
    return { allowed: false, code: 'NO_CHANGE', message: 'The new price is the same as the old one.' };
  }

  const reduction = originalAmount - newAmount;
  if (reduction <= 0) {
    // An increase always needs a second pair of eyes: nobody should be able to
    // raise what a patient is charged on their own authority.
    return { allowed: true, requiresApproval: true };
  }

  const thresholdKobo = Math.floor((originalAmount * approvalThresholdBasisPoints) / BASIS_POINTS_TOTAL);
  return { allowed: true, requiresApproval: reduction > thresholdKobo };
}

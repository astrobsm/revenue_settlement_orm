/**
 * The consolidated bill.
 *
 * A bill is the one thing in a hospital a patient will check by hand, so the
 * arithmetic is tested harder than anything else here. The §54 acceptance case
 * is included verbatim as the last block: seven charges from five departments,
 * one total of 910,000.00.
 */
import { describe, expect, it } from 'vitest';

import {
  amountToAllocate,
  balanceOf,
  buildInvoice,
  canAcceptPayment,
  ChargeRequest,
  checkOverride,
  isDepositKind,
  isLocked,
  InvoiceStatus,
  overpaymentOf,
  statusAfterPayment,
} from './invoice';

const charge = (over: Partial<ChargeRequest> = {}): ChargeRequest => ({
  sourceRef: 'r1',
  sourceKind: 'MANUAL',
  kind: 'THEATRE',
  description: 'Theatre fee',
  quantity: 1,
  unitPrice: 100_00,
  ...over,
});

describe('assembling one bill from many departments (§1, §7)', () => {
  it('adds line totals as quantity times unit price', () => {
    const d = buildInvoice({
      charges: [
        charge({ description: 'Sterile dressing pack', quantity: 2, unitPrice: 3_500_00, kind: 'CONSUMABLE' }),
        charge({ description: 'NPWT foam', quantity: 1, unitPrice: 12_000_00, kind: 'CONSUMABLE' }),
        charge({ description: 'Suture', quantity: 3, unitPrice: 2_250_00, kind: 'CONSUMABLE' }),
      ],
    });
    expect(d.lines.map((l) => l.lineTotal)).toEqual([7_000_00, 12_000_00, 6_750_00]);
    expect(d.total).toBe(25_750_00);
  });

  it('drops a zero-quantity charge rather than printing a puzzling zero line', () => {
    // A reservation returned in full cost the patient nothing.
    const d = buildInvoice({ charges: [charge({ quantity: 0 }), charge({ quantity: 1 })] });
    expect(d.lines).toHaveLength(1);
  });

  it('groups charges into sections with the operation first (§7)', () => {
    const d = buildInvoice({
      charges: [
        charge({ kind: 'CONSUMABLE', description: 'Gauze' }),
        charge({ kind: 'PROFESSIONAL_SURGEON', description: 'Surgical fee' }),
        charge({ kind: 'ADMISSION_DEPOSIT', description: 'Admission deposit' }),
        charge({ kind: 'DRUG', description: 'Ceftriaxone' }),
      ],
    });
    expect(d.sections.map((s) => s.kind)).toEqual([
      'PROFESSIONAL_SURGEON', 'DRUG', 'CONSUMABLE', 'ADMISSION_DEPOSIT',
    ]);
  });

  it('refuses a fractional quantity', () => {
    expect(() => buildInvoice({ charges: [charge({ quantity: 1.5 })] })).toThrow(/whole number/i);
  });

  it('refuses a negative quantity', () => {
    expect(() => buildInvoice({ charges: [charge({ quantity: -1 })] })).toThrow(/cannot be negative/i);
  });

  it('refuses a negative price and points at credit notes instead', () => {
    expect(() => buildInvoice({ charges: [charge({ unitPrice: -100 })] })).toThrow(/credit note/i);
  });

  it('refuses a fractional price — naira leaked into the arithmetic', () => {
    expect(() => buildInvoice({ charges: [charge({ unitPrice: 100.5 })] })).toThrow(/whole number of kobo/i);
  });

  it('keeps the price captured on the charge, not a live lookup (§40)', () => {
    // The builder is given a price and uses exactly that price. There is no
    // tariff lookup in here at all, which is what makes §40 structural rather
    // than a rule somebody has to remember.
    const d = buildInvoice({ charges: [charge({ unitPrice: 77_777 })] });
    expect(d.lines[0].unitPrice).toBe(77_777);
  });
});

describe('discount and tax', () => {
  it('taxes what remains after a discount', () => {
    const d = buildInvoice({
      charges: [charge({ unitPrice: 100_000_00 })],
      discount: 20_000_00,
      taxBasisPoints: 750,
    });
    expect(d.discount).toBe(20_000_00);
    // 7.5% of 80,000.00 = 6,000.00
    expect(d.tax).toBe(6_000_00);
    expect(d.total).toBe(86_000_00);
  });

  it('caps a discount at the service subtotal', () => {
    const d = buildInvoice({ charges: [charge({ unitPrice: 10_000_00 })], discount: 99_000_00 });
    expect(d.discount).toBe(10_000_00);
    expect(d.total).toBe(0);
  });

  it('does not discount a deposit — that is just a smaller deposit', () => {
    const d = buildInvoice({
      charges: [
        charge({ kind: 'THEATRE', unitPrice: 50_000_00 }),
        charge({ kind: 'ADMISSION_DEPOSIT', unitPrice: 100_000_00 }),
      ],
      discount: 999_000_00,
    });
    expect(d.discount).toBe(50_000_00);
    expect(d.depositComponent).toBe(100_000_00);
    expect(d.total).toBe(100_000_00);
  });

  it('does not tax a deposit — a deposit is not a sale', () => {
    const d = buildInvoice({
      charges: [charge({ kind: 'ADMISSION_DEPOSIT', unitPrice: 100_000_00 })],
      taxBasisPoints: 750,
    });
    expect(d.tax).toBe(0);
    expect(d.total).toBe(100_000_00);
  });

  it('charges no tax when exempt', () => {
    const d = buildInvoice({ charges: [charge({ unitPrice: 100_000_00 })], taxBasisPoints: 0 });
    expect(d.tax).toBe(0);
  });

  it('refuses a negative tax rate', () => {
    expect(() => buildInvoice({ charges: [charge()], taxBasisPoints: -1 })).toThrow();
  });
});

describe('deposits are separated from earned revenue (§21)', () => {
  it('knows which charge kinds are deposits', () => {
    expect(isDepositKind('ADMISSION_DEPOSIT')).toBe(true);
    expect(isDepositKind('BED_CHARGE')).toBe(false);
    expect(isDepositKind('THEATRE')).toBe(false);
  });

  it('reports the deposit and service components separately', () => {
    const d = buildInvoice({
      charges: [
        charge({ kind: 'THEATRE', unitPrice: 810_000_00 }),
        charge({ kind: 'ADMISSION_DEPOSIT', unitPrice: 100_000_00 }),
      ],
    });
    expect(d.depositComponent).toBe(100_000_00);
    expect(d.serviceComponent).toBe(810_000_00);
    expect(d.total).toBe(910_000_00);
  });

  it('marks the deposit line so the ledger cannot mistake it for revenue', () => {
    const d = buildInvoice({ charges: [charge({ kind: 'ADMISSION_DEPOSIT' })] });
    expect(d.lines[0].isDeposit).toBe(true);
  });
});

describe('invoice status', () => {
  it('is PARTIALLY_PAID after an instalment', () => {
    expect(statusAfterPayment({ current: 'ISSUED', total: 1_000_000, amountPaid: 400_000 })).toBe('PARTIALLY_PAID');
  });

  it('is PAID on the exact total', () => {
    expect(statusAfterPayment({ current: 'PARTIALLY_PAID', total: 1_000_000, amountPaid: 1_000_000 })).toBe('PAID');
  });

  it('is OVERPAID beyond the total, so it can be refunded rather than hidden', () => {
    expect(statusAfterPayment({ current: 'PARTIALLY_PAID', total: 1_000_000, amountPaid: 1_100_000 })).toBe('OVERPAID');
  });

  it('leaves a cancelled invoice cancelled', () => {
    expect(statusAfterPayment({ current: 'CANCELLED', total: 100, amountPaid: 100 })).toBe('CANCELLED');
  });

  it('leaves a refunded invoice refunded', () => {
    expect(statusAfterPayment({ current: 'REFUNDED', total: 100, amountPaid: 100 })).toBe('REFUNDED');
  });

  it('reports balance and overpayment without going negative', () => {
    expect(balanceOf({ total: 1_000, amountPaid: 1_200 })).toBe(0);
    expect(overpaymentOf({ total: 1_000, amountPaid: 1_200 })).toBe(200);
    expect(overpaymentOf({ total: 1_000, amountPaid: 900 })).toBe(0);
  });

  it('locks an invoice as soon as money has touched it (§23, §44)', () => {
    for (const s of ['PARTIALLY_PAID', 'PAID', 'OVERPAID', 'CANCELLED', 'REFUNDED'] as InvoiceStatus[]) {
      expect(isLocked(s)).toBe(true);
    }
    for (const s of ['DRAFT', 'AWAITING_APPROVAL', 'ISSUED'] as InvoiceStatus[]) {
      expect(isLocked(s)).toBe(false);
    }
  });
});

describe('accepting a payment', () => {
  const base = { status: 'ISSUED' as InvoiceStatus, total: 910_000_00, amountPaid: 0 };

  it('accepts the exact outstanding amount', () => {
    expect(canAcceptPayment({ ...base, payment: 910_000_00 }).allowed).toBe(true);
  });

  it('accepts a part payment (§20)', () => {
    expect(canAcceptPayment({ ...base, payment: 400_000_00 }).allowed).toBe(true);
  });

  it('refuses more than is outstanding, and says to check the invoice number', () => {
    // At a cash desk the commonest cause is keying the wrong invoice.
    const v = canAcceptPayment({ ...base, payment: 910_000_01 });
    expect(v.allowed).toBe(false);
    expect(v.code).toBe('EXCEEDS_BALANCE');
    expect(v.message).toContain('Check the invoice number');
  });

  it('shows both figures in naira in the refusal', () => {
    const v = canAcceptPayment({ ...base, payment: 1_000_000_00 });
    expect(v.message).toContain('₦910,000.00');
    expect(v.message).toContain('₦1,000,000.00');
  });

  it('refuses payment against a draft — it must be reviewed and issued first', () => {
    expect(canAcceptPayment({ ...base, status: 'DRAFT', payment: 100 }).code).toBe('INVOICE_NOT_ISSUED');
    expect(canAcceptPayment({ ...base, status: 'AWAITING_APPROVAL', payment: 100 }).code).toBe('INVOICE_NOT_ISSUED');
  });

  it('refuses payment against a cancelled invoice', () => {
    expect(canAcceptPayment({ ...base, status: 'CANCELLED', payment: 100 }).code).toBe('INVOICE_CANCELLED');
  });

  it('refuses a second payment on a settled invoice', () => {
    expect(canAcceptPayment({ status: 'PAID', total: 100, amountPaid: 100, payment: 1 }).code).toBe('ALREADY_PAID');
  });

  it('refuses zero, negative and fractional amounts', () => {
    for (const payment of [0, -1, 1.5]) {
      expect(canAcceptPayment({ ...base, payment }).code).toBe('INVALID_AMOUNT');
    }
  });
});

describe('allocation timing is configurable (§20)', () => {
  it('ON_FULL_PAYMENT allocates nothing until the invoice is settled', () => {
    expect(amountToAllocate({
      timing: 'ON_FULL_PAYMENT', paymentAmount: 400_000, totalPaidAfter: 400_000, invoiceTotal: 1_000_000,
    })).toBe(0);
  });

  it('ON_FULL_PAYMENT allocates the whole invoice on the final instalment', () => {
    expect(amountToAllocate({
      timing: 'ON_FULL_PAYMENT', paymentAmount: 300_000, totalPaidAfter: 1_000_000, invoiceTotal: 1_000_000,
    })).toBe(1_000_000);
  });

  it('PRO_RATA allocates each instalment as it arrives', () => {
    expect(amountToAllocate({
      timing: 'PRO_RATA', paymentAmount: 400_000, totalPaidAfter: 400_000, invoiceTotal: 1_000_000,
    })).toBe(400_000);
  });

  it('PRO_RATA instalments sum to exactly the invoice total', () => {
    // Three instalments of 400/300/300 on a 1,000,000 bill.
    const instalments = [400_000, 300_000, 300_000];
    let paid = 0;
    let allocated = 0;
    for (const amount of instalments) {
      paid += amount;
      allocated += amountToAllocate({
        timing: 'PRO_RATA', paymentAmount: amount, totalPaidAfter: paid, invoiceTotal: 1_000_000,
      });
    }
    expect(allocated).toBe(1_000_000);
  });

  it('PRO_RATA never allocates beyond the bill on an overpayment', () => {
    expect(amountToAllocate({
      timing: 'PRO_RATA', paymentAmount: 200_000, totalPaidAfter: 1_100_000, invoiceTotal: 1_000_000,
    })).toBe(100_000);
  });
});

describe('price overrides and discounts need a reason and often a second person (§22)', () => {
  const base = { originalAmount: 100_000_00, approvalThresholdBasisPoints: 1000 };

  it('refuses a change with no usable reason', () => {
    expect(checkOverride({ ...base, newAmount: 90_000_00, reason: 'x' }).code).toBe('REASON_REQUIRED');
    expect(checkOverride({ ...base, newAmount: 90_000_00, reason: '   ' }).code).toBe('REASON_REQUIRED');
  });

  it('allows a small reduction on the officer\'s own authority', () => {
    // 5% off, threshold 10%.
    const v = checkOverride({ ...base, newAmount: 95_000_00, reason: 'Approved staff concession per policy 4.2.' });
    expect(v.allowed).toBe(true);
    expect(v.requiresApproval).toBe(false);
  });

  it('requires approval for a large reduction', () => {
    const v = checkOverride({ ...base, newAmount: 50_000_00, reason: 'Indigent patient, CMD approval sought.' });
    expect(v.requiresApproval).toBe(true);
  });

  it('always requires approval to RAISE what a patient is charged', () => {
    // Nobody increases a patient's bill on their own authority.
    const v = checkOverride({ ...base, newAmount: 120_000_00, reason: 'Corrected tariff band after review.' });
    expect(v.requiresApproval).toBe(true);
  });

  it('refuses a negative price', () => {
    expect(checkOverride({ ...base, newAmount: -1, reason: 'Some sufficiently long reason.' }).code).toBe('NEGATIVE_PRICE');
  });

  it('refuses a no-op change', () => {
    expect(checkOverride({ ...base, newAmount: 100_000_00, reason: 'Some sufficiently long reason.' }).code).toBe('NO_CHANGE');
  });
});

// ---------------------------------------------------------------------------
describe('the §54 acceptance criterion', () => {
  // Patient MR X, major surgery. Seven charges raised by five departments.
  const charges: ChargeRequest[] = [
    { sourceRef: 'orm-surg-1', sourceKind: 'ORM_BOOKING', kind: 'PROFESSIONAL_SURGEON', description: 'Surgical fee', quantity: 1, unitPrice: 500_000_00 },
    { sourceRef: 'orm-anae-1', sourceKind: 'ORM_ANAESTHESIA', kind: 'PROFESSIONAL_ANAESTHETIST', description: 'Anaesthetist fee', quantity: 1, unitPrice: 100_000_00 },
    { sourceRef: 'orm-anae-2', sourceKind: 'ORM_ANAESTHESIA', kind: 'ANAESTHESIA_DRUG', description: 'Anaesthetic drugs', quantity: 1, unitPrice: 75_000_00 },
    { sourceRef: 'orm-pharm-1', sourceKind: 'ORM_PHARMACY', kind: 'DRUG', description: 'Procedure drugs', quantity: 1, unitPrice: 40_000_00 },
    { sourceRef: 'orm-pharm-2', sourceKind: 'ORM_PHARMACY', kind: 'IV_FLUID', description: 'IV fluids', quantity: 1, unitPrice: 15_000_00 },
    { sourceRef: 'orm-store-1', sourceKind: 'ORM_RESERVATION', kind: 'CONSUMABLE', description: 'Surgical consumables', quantity: 1, unitPrice: 80_000_00 },
    { sourceRef: 'orm-adm-1', sourceKind: 'ORM_ADMISSION', kind: 'ADMISSION_DEPOSIT', description: 'Admission deposit', quantity: 1, unitPrice: 100_000_00 },
  ];

  const draft = buildInvoice({ charges });

  it('produces ONE bill with ONE total of ₦910,000.00', () => {
    expect(draft.total).toBe(910_000_00);
    expect(draft.lines).toHaveLength(7);
  });

  it('the patient pays once, and that settles the whole bill', () => {
    const verdict = canAcceptPayment({ status: 'ISSUED', total: draft.total, amountPaid: 0, payment: 910_000_00 });
    expect(verdict.allowed).toBe(true);
    expect(statusAfterPayment({ current: 'ISSUED', total: draft.total, amountPaid: 910_000_00 })).toBe('PAID');
  });

  it('holds ₦100,000 of it as a deposit rather than earned revenue', () => {
    expect(draft.depositComponent).toBe(100_000_00);
    expect(draft.serviceComponent).toBe(810_000_00);
  });

  it('every line names the ORM record that caused it (§38)', () => {
    for (const line of draft.lines) {
      expect(line.sourceRef.length).toBeGreaterThan(0);
      expect(line.sourceKind.length).toBeGreaterThan(0);
    }
  });
});

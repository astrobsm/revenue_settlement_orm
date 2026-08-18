// ============================================================
// Vendor supply agreements — the levy, and the consent it rests on
// ------------------------------------------------------------
// A vendor that takes over supply of a consumable agrees to pay the hospital a
// share of the revenue from it. That share is a COMMERCIAL TERM, negotiated per
// vendor, and this module exists to make three things impossible.
//
//   1. A levy applying to a vendor who never agreed to one.
//   2. A levy applying at a percentage different from the one they signed.
//   3. A signed agreement being edited so that (2) happens quietly.
//
// The rules below are all consequences of those three. The most important is
// that AMENDING A PERCENTAGE IS NOT AN EDIT — it raises a new version that both
// parties must sign, and closes the old one. Editing a signed number in place
// would mean a supplier signed 15% and is charged 20%, which is not a
// configuration change; it is a misrepresentation.
//
// None of this touches the ALLOCATION arithmetic. The engine is handed a levy in
// basis points and splits exactly; what this module decides is whether there is
// a levy to hand it at all.
// ============================================================

import { BASIS_POINTS_TOTAL } from './money';

export type AgreementStatus =
  | 'DRAFT'
  | 'AWAITING_SIGNATURES'
  | 'ACTIVE'
  | 'SUSPENDED'
  | 'SUPERSEDED'
  | 'TERMINATED'
  | 'EXPIRED';

export type SignatoryParty = 'HOSPITAL' | 'VENDOR' | 'WITNESS';

export interface SignatureRecord {
  party: SignatoryParty;
  consentGiven: boolean;
  agreedLevyBasisPoints: number;
  signedAt?: Date | string | null;
  revokedAt?: Date | string | null;
}

export interface AgreementSnapshot {
  id?: string;
  levyBasisPoints: number;
  status: AgreementStatus;
  effectiveFrom: Date | string;
  effectiveTo?: Date | string | null;
  coveredKinds: string[];
  signatures: SignatureRecord[];
}

export class AgreementError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AgreementError';
    this.code = code;
  }
}

/** Both parties that must sign before any levy applies. A witness is optional. */
const REQUIRED_PARTIES: SignatoryParty[] = ['HOSPITAL', 'VENDOR'];

/** A live, unrevoked signature from this party at this percentage. */
function validSignature(
  signatures: SignatureRecord[],
  party: SignatoryParty,
  levyBasisPoints: number
): SignatureRecord | undefined {
  return signatures.find(
    (s) =>
      s.party === party &&
      s.consentGiven &&
      s.signedAt != null &&
      s.revokedAt == null &&
      // The crux: the signature must be for THIS percentage. A signature
      // collected against 15% does not consent to 20%.
      s.agreedLevyBasisPoints === levyBasisPoints
  );
}

export interface SignatureStatus {
  complete: boolean;
  signed: SignatoryParty[];
  outstanding: SignatoryParty[];
  /** Set where a party signed, but for a different percentage than now stands. */
  staleSignatures: SignatoryParty[];
  message?: string;
}

/**
 * Who has signed, and for what.
 *
 * A signature given against an earlier percentage is reported as STALE rather
 * than counted. That is the case this whole module exists to catch: the
 * agreement was signed, then the number moved.
 */
export function signatureStatus(agreement: AgreementSnapshot): SignatureStatus {
  const signed: SignatoryParty[] = [];
  const outstanding: SignatoryParty[] = [];
  const staleSignatures: SignatoryParty[] = [];

  for (const party of REQUIRED_PARTIES) {
    if (validSignature(agreement.signatures, party, agreement.levyBasisPoints)) {
      signed.push(party);
      continue;
    }
    const anySignature = agreement.signatures.find(
      (s) => s.party === party && s.consentGiven && s.signedAt != null && s.revokedAt == null
    );
    if (anySignature) staleSignatures.push(party);
    outstanding.push(party);
  }

  const complete = outstanding.length === 0;
  return {
    complete,
    signed,
    outstanding,
    staleSignatures,
    message: complete
      ? undefined
      : staleSignatures.length > 0
        ? `${staleSignatures.join(' and ')} signed for a different percentage than the agreement now states. The agreement must be re-signed at the current figure before any levy applies.`
        : `Awaiting signature from ${outstanding.join(' and ')}. No levy applies until both parties have signed.`,
  };
}

/** May the percentage still be changed on this agreement, in place? */
export function canEditLevy(status: AgreementStatus): boolean {
  // Only while it is still a draft. Once it has gone out for signature the
  // number is what the vendor is being asked to agree to.
  return status === 'DRAFT';
}

export interface LevyChangeVerdict {
  allowed: boolean;
  code?: string;
  message?: string;
  /** True when the change must be made by superseding rather than editing. */
  requiresNewVersion?: boolean;
}

/**
 * May this agreement's percentage be changed to `newBasisPoints`?
 *
 * A draft may simply be edited. Anything further along must be SUPERSEDED — a
 * new version, signed afresh — which is the answer this returns rather than a
 * flat refusal, because amending a commercial term is a normal thing to want.
 */
export function checkLevyChange(params: {
  status: AgreementStatus;
  currentBasisPoints: number;
  newBasisPoints: number;
  reason?: string;
}): LevyChangeVerdict {
  const { status, currentBasisPoints, newBasisPoints, reason } = params;

  if (!Number.isInteger(newBasisPoints) || newBasisPoints < 0 || newBasisPoints > BASIS_POINTS_TOTAL) {
    return {
      allowed: false,
      code: 'INVALID_SHARE',
      message: `A levy must be a whole number of basis points between 0 and ${BASIS_POINTS_TOTAL} (0% to 100%). ${newBasisPoints} is not.`,
    };
  }
  if (newBasisPoints === currentBasisPoints) {
    return { allowed: false, code: 'NO_CHANGE', message: 'That is the percentage the agreement already states.' };
  }
  if (status === 'TERMINATED' || status === 'SUPERSEDED' || status === 'EXPIRED') {
    return {
      allowed: false,
      code: 'AGREEMENT_CLOSED',
      message: `This agreement is ${status.toLowerCase()} and is kept as a record. Raise a new agreement with the vendor instead.`,
    };
  }

  if (canEditLevy(status)) {
    if (!reason || reason.trim().length < 10) {
      return { allowed: false, code: 'REASON_REQUIRED', message: 'Give a reason for the change that will still make sense later.' };
    }
    return { allowed: true };
  }

  return {
    allowed: true,
    requiresNewVersion: true,
    code: 'REQUIRES_NEW_VERSION',
    message:
      'This agreement has already gone out for signature, so the percentage cannot be changed on it. A new version will be raised at the new figure and both parties must sign it; the current agreement stays in force until they do.',
  };
}

export interface ActivationVerdict {
  allowed: boolean;
  code?: string;
  message?: string;
}

/** May this agreement be activated — that is, may the levy start applying? */
export function canActivate(agreement: AgreementSnapshot): ActivationVerdict {
  if (agreement.status === 'ACTIVE') {
    return { allowed: false, code: 'ALREADY_ACTIVE', message: 'This agreement is already in force.' };
  }
  if (['SUPERSEDED', 'TERMINATED', 'EXPIRED'].includes(agreement.status)) {
    return { allowed: false, code: 'AGREEMENT_CLOSED', message: `A ${agreement.status.toLowerCase()} agreement cannot be brought back into force.` };
  }

  const signatures = signatureStatus(agreement);
  if (!signatures.complete) {
    return { allowed: false, code: 'SIGNATURES_INCOMPLETE', message: signatures.message };
  }
  return { allowed: true };
}

/**
 * The levy that applies to a vendor line today, or NONE.
 *
 * This is the function the payment route calls, and its default is the safe one:
 * anything other than a live, fully signed, in-date agreement covering this
 * charge kind yields no levy at all, and the vendor is paid in full.
 */
export function levyInForce(params: {
  agreement: AgreementSnapshot | null | undefined;
  chargeKind: string;
  asOf?: Date;
}): { basisPoints: number; reason: string } {
  const { agreement, chargeKind, asOf = new Date() } = params;

  if (!agreement) return { basisPoints: 0, reason: 'This vendor has no supply agreement, so no levy applies.' };
  if (agreement.status !== 'ACTIVE') {
    return { basisPoints: 0, reason: `The supply agreement is ${agreement.status.toLowerCase()}, so no levy applies.` };
  }

  // Signatures are re-checked here rather than trusted from the status. A row
  // could have been activated before a signature was revoked, and the vendor's
  // money is the wrong place to discover that.
  const signatures = signatureStatus(agreement);
  if (!signatures.complete) {
    return { basisPoints: 0, reason: signatures.message ?? 'The agreement is not fully signed, so no levy applies.' };
  }

  const from = new Date(agreement.effectiveFrom);
  if (asOf < from) {
    return { basisPoints: 0, reason: 'The supply agreement has not taken effect yet, so no levy applies.' };
  }
  if (agreement.effectiveTo && asOf > new Date(agreement.effectiveTo)) {
    return { basisPoints: 0, reason: 'The supply agreement has expired, so no levy applies.' };
  }

  if (agreement.coveredKinds.length > 0 && !agreement.coveredKinds.includes(chargeKind)) {
    return { basisPoints: 0, reason: `This agreement does not cover ${chargeKind}, so no levy applies to it.` };
  }

  return {
    basisPoints: agreement.levyBasisPoints,
    reason: `Supply agreement levy of ${(agreement.levyBasisPoints / 100).toFixed(2)}%, signed by both parties.`,
  };
}

/** Wording shown to each party at the point of signing, so consent is informed. */
export function consentStatementFor(params: {
  party: SignatoryParty;
  vendorName: string;
  levyBasisPoints: number;
  coveredKinds: string[];
}): string {
  const pct = (params.levyBasisPoints / 100).toFixed(2);
  const scope = params.coveredKinds.length > 0 ? params.coveredKinds.join(', ') : 'all supplied items';

  if (params.party === 'VENDOR') {
    return (
      `I sign on behalf of ${params.vendorName} and agree that the hospital shall retain ${pct}% of the revenue ` +
      `billed to patients for ${scope} supplied by us under this agreement, deducted at the point each payment is ` +
      `allocated, with the balance settled to our nominated account. I confirm I am authorised to enter into this ` +
      `agreement and that this percentage may not be varied without a new agreement signed by both parties.`
    );
  }
  return (
    `I sign on behalf of the hospital and agree that ${params.vendorName} shall supply ${scope}, and that the ` +
    `hospital shall retain ${pct}% of the revenue billed to patients for those items, settling the balance to the ` +
    `vendor's nominated account. I confirm this percentage may not be varied without a new agreement signed by ` +
    `both parties.`
  );
}

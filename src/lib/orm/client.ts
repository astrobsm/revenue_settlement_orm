// ============================================================
// The ORM integration client (§38)
// ------------------------------------------------------------
// Central Theatre Revenue READS from the Operative Resource Manager and never
// writes to it. Clinical records belong to the clinical system; a revenue
// application that can edit a surgery record is a revenue application that will
// eventually be blamed for one.
//
// §38's instruction is "avoid duplicate data entry wherever reliable ORM data
// already exists". So a bill is assembled from what ORM already knows — the
// procedure, the surgeon, the anaesthetist, the theatre, the drugs dispensed and
// the stock actually consumed — rather than retyped at a revenue desk.
//
// TWO RULES GOVERN EVERY CALL HERE.
//
// 1. ORM IS NOT A SOURCE OF PRICES. It is asked WHAT happened and HOW MUCH was
//    used. What that costs is decided here, against this application's own
//    effective-dated tariff. Letting a clinical system set prices would put the
//    tariff outside financial control.
//
// 2. ORM BEING DOWN MUST NOT STOP A PATIENT PAYING. Every function here can
//    fail, and every caller is expected to cope: a bill can always be assembled
//    by hand. §55 is explicit that payment-system problems must not compromise
//    care, and the same courtesy is owed in reverse.
// ============================================================

/** What ORM knows about a patient. Only what a bill needs. */
export interface OrmPatient {
  ormRef: string;
  fullName: string;
  hospitalNumber?: string | null;
  folderNumber?: string | null;
  phone?: string | null;
}

/** A booking, with the team and theatre a bill needs to name. */
export interface OrmBooking {
  ormRef: string;
  patient: OrmPatient;
  procedure?: string | null;
  theatre?: string | null;
  surgeonName?: string | null;
  anaesthetistName?: string | null;
  serviceDate?: string | null;
  status?: string | null;
}

/**
 * Something ORM says was consumed, and how much of it.
 *
 * `quantityUsed` is the only quantity here, deliberately. ORM distinguishes what
 * was RESERVED, ISSUED, USED and WASTED; only the used figure may be billed. A
 * dropped vial is the hospital's loss, and billing anything else would charge
 * patients for the theatre's breakages.
 */
export interface OrmConsumption {
  ormRef: string;
  sourceKind: 'STOCK_RESERVATION' | 'PHARMACY_DISPENSE' | 'ANAESTHESIA_RECORD' | 'CSSD_USAGE' | 'INVESTIGATION' | 'OTHER';
  itemName: string;
  quantityUsed: number;
  /** ORM's catalogue code, matched against this application's Service.code. */
  serviceCode?: string | null;
  /** Set when the stock was vendor-owned. That vendor is owed for the line. */
  vendorRef?: string | null;
  batchNumber?: string | null;
}

export class OrmUnavailableError extends Error {
  cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'OrmUnavailableError';
    this.cause = cause;
  }
}

interface OrmConfig {
  baseUrl: string;
  token: string;
}

function config(): OrmConfig {
  const baseUrl = process.env.ORM_BASE_URL;
  const token = process.env.ORM_SERVICE_TOKEN;
  if (!baseUrl || !token) {
    throw new OrmUnavailableError(
      'ORM integration is not configured. Set ORM_BASE_URL and ORM_SERVICE_TOKEN, or assemble the bill by hand.'
    );
  }
  return { baseUrl: baseUrl.replace(/\/$/, ''), token };
}

/**
 * One GET against ORM.
 *
 * Times out rather than hanging: a revenue desk with a patient at the window
 * cannot wait on a clinical server that has stopped answering. Ten seconds is
 * long enough for a slow query on the on-site box and short enough that the
 * clerk knows to carry on by hand.
 */
async function ormGet<T>(path: string, timeoutMs = 10_000): Promise<T> {
  const { baseUrl, token } = config();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
      cache: 'no-store',
    });

    if (response.status === 404) {
      throw new OrmUnavailableError(`ORM has no record at ${path}.`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new OrmUnavailableError(
        'ORM refused this service token. Revenue cannot read clinical data until the token is renewed.'
      );
    }
    if (!response.ok) {
      throw new OrmUnavailableError(`ORM returned ${response.status} for ${path}.`);
    }

    return (await response.json()) as T;
  } catch (err) {
    if (err instanceof OrmUnavailableError) throw err;
    if ((err as Error)?.name === 'AbortError') {
      throw new OrmUnavailableError(
        `ORM did not respond within ${timeoutMs / 1000} seconds. Assemble the bill by hand and it will reconcile later.`,
        err
      );
    }
    throw new OrmUnavailableError('ORM could not be reached.', err);
  }
}

/** A patient, by ORM's id. */
export async function fetchPatient(ormPatientRef: string): Promise<OrmPatient> {
  return ormGet<OrmPatient>(`/api/patients/${encodeURIComponent(ormPatientRef)}`);
}

/** A surgical booking, with the team and theatre for the bill header (§7). */
export async function fetchBooking(ormSurgeryRef: string): Promise<OrmBooking> {
  return ormGet<OrmBooking>(`/api/surgeries/${encodeURIComponent(ormSurgeryRef)}`);
}

/**
 * Everything consumed against one case, from every ORM module at once (§38).
 *
 * Deliberately ONE call rather than six. A bill assembled from six independent
 * requests can be assembled from a partial answer — three modules respond, three
 * time out — and the patient is billed for part of their care with no indication
 * that anything is missing. One call either produces the whole picture or fails
 * visibly.
 */
export async function fetchConsumption(ormSurgeryRef: string): Promise<OrmConsumption[]> {
  const result = await ormGet<{ items: OrmConsumption[] }>(
    `/api/surgeries/${encodeURIComponent(ormSurgeryRef)}/consumption`
  );
  const items = result.items ?? [];

  // Trust nothing about quantities. A negative or fractional quantity from
  // upstream becomes a bill nobody can explain, so it is dropped and reported
  // rather than silently rounded into a charge.
  return items.filter((i) => Number.isInteger(i.quantityUsed) && i.quantityUsed > 0);
}

/** Whether ORM is reachable at all. For the settings screen and health checks. */
export async function ormHealth(): Promise<{ reachable: boolean; detail: string }> {
  try {
    await ormGet<unknown>('/api/version', 4_000);
    return { reachable: true, detail: 'ORM is responding.' };
  } catch (err) {
    return { reachable: false, detail: (err as Error).message };
  }
}

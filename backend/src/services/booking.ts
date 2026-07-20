import { evaluateConflicts, resolveBooking, weekdayOf } from '../../../shared/src/ssot/domain';
import type { ConflictVerdict } from '../../../shared/src/ssot/domain';
import { getServiceDefaults, getClientOverridePrice } from '../db/catalog';
import { getBlockServiceForSlot, resourceExistsInBusiness } from '../db/scheduling';
import { findUser } from '../db/users';
import { withTransaction, type Queryable, type TransactionClient, type TransactionPool } from '../db/core';
import { recheckConflictsInTx, loadConflictInputs, toAggregatorOwner } from './scheduling';
import { DATE_RE, HHMM_RE, addMinutes, crossesMidnight, buildStartsAt } from '../time';
import type { ErrorDetail } from '../../../shared/src/ssot/envelope';

// Booking input as the endpoints expect it; every field is still format-checked at runtime.
export type BookingBody = {
  professional_user_id?: number | string;
  service_id?: number | string;
  date?: string;
  start?: string;
  duration_minutes?: number | string;
  resource_id?: number | string | null;
  client_user_id?: number | string | null;
  name?: string | null;
  description?: string | null;
};

export type RecheckInput = {
  businessId: number;
  professionalUserId: number;
  resourceId?: number;
  date: string;
  start: string;
  durationMinutes: number;
  serviceId: number;
  excludeAppointmentId?: number;
};

export type SaveResult<T> =
  | { kind: 'verdict'; verdict: ConflictVerdict }
  | { kind: 'ok'; result: T };

// The sobreturno-aware save shared by schedule/approve/reschedule. `forced` is set only when an
// override actually bypassed a real conflict — a redundant override on a clean slot must not mark
// the row. Returns the verdict without writing when an override is needed but not granted. The
// write may throw httpError to abort; guardRoute maps that and recheck's structured errors.
export async function saveWithConflictRecheck<T>(
  pool: TransactionPool,
  recheck: RecheckInput,
  override: boolean,
  write: (tx: TransactionClient, forced: boolean) => Promise<T>,
): Promise<SaveResult<T>> {
  return withTransaction(pool, async (tx) => {
    const verdict = await recheckConflictsInTx(tx, { ...recheck, callerIsStaff: true });
    if (verdict.requires_override && !override) {
      return { kind: 'verdict', verdict };
    }
    const forced = override && verdict.requires_override;
    const result = await write(tx, forced);
    return { kind: 'ok', result };
  });
}

// One format validator for every booking-shaped input. Id checks run only when the caller
// supplies the value (reschedule validates only what the body may override); the resource
// check runs only when a resource was named at all.
export function validateBookingFields(parts: {
  professionalUserId?: number;
  serviceId?: number;
  resourceId?: number;
  date: string;
  start: string;
  durationMinutes: number;
}): { fields: Record<string, string>; fieldDetails: Record<string, ErrorDetail> } {
  const fields: Record<string, string> = {};
  const fieldDetails: Record<string, ErrorDetail> = {};
  const reject = (field: string, message: string, key: string) => {
    fields[field] = message;
    fieldDetails[field] = { key };
  };

  if (parts.professionalUserId !== undefined && (!Number.isInteger(parts.professionalUserId) || parts.professionalUserId <= 0))
    reject('professional_user_id', 'required', 'required');
  if (parts.serviceId !== undefined && (!Number.isInteger(parts.serviceId) || parts.serviceId <= 0))
    reject('service_id', 'required', 'required');
  if (parts.resourceId !== undefined && (!Number.isInteger(parts.resourceId) || parts.resourceId <= 0))
    reject('resource_id', 'must be a valid id', 'invalidId');
  if (!DATE_RE.test(parts.date)) reject('date', 'must be YYYY-MM-DD', 'dateFormat');
  if (!HHMM_RE.test(parts.start)) reject('start', 'must be HH:MM', 'timeOfDayFormat');
  if (!Number.isInteger(parts.durationMinutes) || parts.durationMinutes <= 0)
    reject('duration_minutes', 'must be a positive integer', 'positiveInteger');
  if (!fields.start && !fields.duration_minutes && crossesMidnight(parts.start, parts.durationMinutes)) {
    reject('duration_minutes', 'start + duration must not cross midnight', 'crossesMidnight');
  }
  return { fields, fieldDetails };
}

// Validates and resolves a booking request into the concrete values a write needs: format-checks
// the body, business-scopes the service/resource/client (404 to hide cross-tenant existence), and
// resolves the effective price/duration. No write, no conflict check — the caller owns those.
export async function resolveAndLoadService(
  pool: Queryable,
  businessId: number,
  body: BookingBody,
  callerIsStaff: boolean,
  invalidMessage = 'Invalid appointment input',
): Promise<
  | {
      ok: true;
      professionalUserId: number;
      serviceId: number;
      date: string;
      start: string;
      durationMinutes: number;
      resourceId: number | undefined;
      clientUserId: number | null;
      name: string | null;
      description: string | null;
      startsAt: string;
      effective_price: string;
      effective_duration_minutes: number;
      serviceDefaultPriceArs: string;
    }
  | { ok: false; status: number; code: string; message: string; fields?: Record<string, string>; fieldDetails?: Record<string, ErrorDetail> }
> {
  const professionalUserId = Number(body.professional_user_id);
  const serviceId = Number(body.service_id);
  const date = typeof body.date === 'string' ? body.date : '';
  const start = typeof body.start === 'string' ? body.start : '';
  const durationMinutes = Number(body.duration_minutes);
  const resourceId =
    body.resource_id == null || body.resource_id === ''
      ? undefined
      : Number(body.resource_id);
  const clientUserId =
    body.client_user_id != null ? Number(body.client_user_id) : null;
  const name = typeof body.name === 'string' ? body.name : null;
  const description = typeof body.description === 'string' ? body.description : null;

  const { fields, fieldDetails } = validateBookingFields({ professionalUserId, serviceId, resourceId, date, start, durationMinutes });
  if (Object.keys(fields).length > 0) {
    return { ok: false, status: 422, code: 'invalid_request', message: invalidMessage, fields, fieldDetails };
  }

  const serviceDefaults = await getServiceDefaults(pool, serviceId, businessId);
  if (serviceDefaults == null) {
    return { ok: false, status: 404, code: 'not_found', message: 'Service not found in this business' };
  }
  const serviceDefaultPriceArs = serviceDefaults.default_price_ars;

  // Resource (when supplied) must belong to the session's business — an explicit
  // check independent of the conflict loader so a future override bypass cannot
  // write a foreign resource_id.
  if (resourceId !== undefined && Number.isInteger(resourceId)) {
    if (!(await resourceExistsInBusiness(pool, resourceId, businessId))) {
      return { ok: false, status: 404, code: 'not_found', message: 'Resource not found in this business' };
    }
  }

  // Client (when supplied) must be an active Client of the session's business — a cross-tenant
  // or deactivated client is rejected identically (404, existence hidden) before the INSERT.
  if (clientUserId != null && Number.isInteger(clientUserId)) {
    if (!(await findUser(pool, { id: clientUserId, businessId, role: 'Client', activeOnly: true }))) {
      return { ok: false, status: 404, code: 'not_found', message: 'Client not found in this business' };
    }
  }

  let clientOverridePriceArs: string | null = null;
  if (clientUserId != null && Number.isInteger(clientUserId)) {
    clientOverridePriceArs = await getClientOverridePrice(pool, clientUserId, professionalUserId, serviceId, businessId);
  }

  // Per-block override for the slot's block (null when off-lattice or the block doesn't offer it).
  const blockService = await getBlockServiceForSlot(pool, professionalUserId, serviceId, weekdayOf(date), start);

  const { effective_price, effective_duration_minutes } = resolveBooking({
    serviceDefaultPriceArs,
    serviceDefaultDurationMinutes: serviceDefaults.default_duration_minutes,
    clientOverridePriceArs,
    blockServicePriceArs: blockService?.price_ars ?? null,
    blockServiceDurationMinutes: blockService?.duration_minutes ?? null,
    // A staff caller may set a custom-length sobreturno; a client's echoed body duration never wins.
    sobreturnoDurationMinutes: callerIsStaff ? durationMinutes : undefined,
  });

  const startsAt = buildStartsAt(date, start);

  return {
    ok: true,
    professionalUserId,
    serviceId,
    date,
    start,
    durationMinutes,
    resourceId,
    clientUserId,
    name,
    description,
    startsAt,
    effective_price,
    effective_duration_minutes,
    serviceDefaultPriceArs,
  };
}

// Read-only conflict verdict for a proposed slot — same loader + aggregator as the in-tx
// recheck, so preview and save always agree. Never writes and takes no lock; a mere read
// must not serialize against real bookings.
export async function runConflictDryRun(
  pool: Queryable,
  businessId: number,
  params: {
    professionalUserId: number;
    resourceId?: number;
    serviceId: number;
    date: string;
    start: string;
    durationMinutes: number;
    callerIsStaff: boolean;
    excludeAppointmentId?: number;
  },
): Promise<
  | { ok: true; verdict: ConflictVerdict }
  | { ok: false; status: number; code: string; message: string }
> {
  const inputs = await loadConflictInputs(pool, businessId, {
    professionalUserId: params.professionalUserId,
    resourceId: params.resourceId,
    date: params.date,
    serviceId: params.serviceId,
  });
  if ('error' in inputs) {
    return { ok: false, ...inputs.error };
  }

  const end = addMinutes(params.start, params.durationMinutes);
  const verdict = evaluateConflicts({
    proposed: { start: params.start, end, date: params.date },
    callerIsStaff: params.callerIsStaff,
    excludeAppointmentId: params.excludeAppointmentId,
    professional: toAggregatorOwner(inputs.professional),
    resource: inputs.resource ? toAggregatorOwner(inputs.resource) : undefined,
  });
  return { ok: true, verdict };
}

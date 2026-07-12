import type { Pool, PoolClient } from 'pg';
import { resolveBooking, weekdayOf } from '../../../shared/src/ssot/domain';
import type { ConflictVerdict } from '../../../shared/src/ssot/domain';
import { getServiceDefaults, getClientOverridePrice } from '../db/catalog';
import { getBlockServiceForSlot } from '../db/scheduling';
import { resourceExistsInBusiness, clientExistsInBusiness } from '../db/appointments';
import { withTransaction } from '../db/core';
import { recheckConflictsInTx } from './scheduling';
import { DATE_RE, HHMM_RE, crossesMidnight, buildStartsAt } from '../time';

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
  pool: Pool,
  recheck: RecheckInput,
  override: boolean,
  write: (tx: PoolClient, forced: boolean) => Promise<T>,
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

// Validates and resolves a booking request into the concrete values a write needs: format-checks
// the body, business-scopes the service/resource/client (404 to hide cross-tenant existence), and
// resolves the effective price/duration. No write, no conflict check — the caller owns those.
export async function resolveAndLoadService(
  pool: Pool,
  businessId: number,
  body: BookingBody,
  callerIsStaff: boolean,
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
  | { ok: false; status: number; code: string; message: string; fields?: Record<string, string> }
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

  const fields: Record<string, string> = {};
  if (!Number.isInteger(professionalUserId) || professionalUserId <= 0)
    fields.professional_user_id = 'required';
  if (!Number.isInteger(serviceId) || serviceId <= 0) fields.service_id = 'required';
  if (!DATE_RE.test(date)) fields.date = 'must be YYYY-MM-DD';
  if (!HHMM_RE.test(start)) fields.start = 'must be HH:MM';
  if (!Number.isInteger(durationMinutes) || durationMinutes <= 0)
    fields.duration_minutes = 'must be a positive integer';
  if (!fields.start && !fields.duration_minutes && crossesMidnight(start, durationMinutes)) {
    fields.duration_minutes = 'start + duration must not cross midnight';
  }

  if (Object.keys(fields).length > 0) {
    return { ok: false, status: 422, code: 'invalid_request', message: 'Invalid appointment input', fields };
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

  // Client (when supplied) must belong to the session's business — a body-supplied
  // client_user_id from another tenant is rejected before it reaches the INSERT.
  if (clientUserId != null && Number.isInteger(clientUserId)) {
    if (!(await clientExistsInBusiness(pool, clientUserId, businessId))) {
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

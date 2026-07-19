import { apiFetchDecoded, getApiMutationGeneration } from '@/api/client';
import { conflicts } from '@/api/contracts';
import { arrayOf, booleanValue, nullable, numberValue, object, optional, stringValue } from '@/api/decoders';
import type { ApiResult } from '@/api/client';
import type { ConflictVerdict } from '@shared/ssot/domain/conflict';
import type { TimeInterval } from '@shared/ssot/domain/availability';
import { schedulingPaths } from '@shared/ssot/api-paths';

// Row-sourced ids arrive as strings (BIGINT wire), picker-sourced as numbers; the server accepts both.
type Id = number | string;

export interface ConflictCheckBody {
  professional_user_id: Id;
  resource_id?: Id;
  service_id: Id;
  client_user_id?: Id;
  date: string;
  start: string;
  // Caller MUST supply duration_minutes — the endpoint does not derive it from the service.
  duration_minutes: number;
}

export interface ConflictCheckResult extends ConflictVerdict {
  effective_price: string;
  effective_duration_minutes: number;
}

export async function checkConflict(
  body: ConflictCheckBody,
): Promise<ApiResult<ConflictCheckResult>> {
  return apiFetchDecoded(conflictCheckResult, schedulingPaths.conflictCheck(), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export interface AvailabilityResult {
  date: string;
  slots: TimeInterval[];
  // False = the owner does not work that day; true with empty slots = fully booked.
  open: boolean;
  // Set for a Client asking about a date beyond the booking window: no slots, distinct from "closed".
  outside_window?: boolean;
}

export interface BookingWindowResult {
  min_date: string;
  max_date: string | null;
}

const timeInterval = object<TimeInterval>({
  start: stringValue, end: stringValue, granularity_minutes: optional(numberValue),
});
const availabilityResult = object<AvailabilityResult>({
  date: stringValue, slots: arrayOf(timeInterval), open: booleanValue,
  outside_window: optional(booleanValue),
});
const bookingWindowResult = object<BookingWindowResult>({ min_date: stringValue, max_date: nullable(stringValue) });
const conflictCheckResult = object<ConflictCheckResult>({
  can_save: booleanValue, requires_override: booleanValue, can_override: booleanValue,
  conflicts,
  effective_price: stringValue, effective_duration_minutes: numberValue,
});

const AVAILABILITY_CACHE_MS = 15_000;
const availabilityCache = new Map<string, {
  expiresAt: number;
  mutationGeneration: number;
  result: ApiResult<AvailabilityResult[]>;
}>();
const availabilityInFlight = new Map<string, {
  signal?: AbortSignal;
  request: Promise<ApiResult<AvailabilityResult[]>>;
}>();

export function invalidateAvailabilityCache(): void {
  availabilityCache.clear();
}

// Concrete booking-window bounds for one (professional, service), so the portal can clamp the date
// picker. Client-facing; staff callers may ignore the window.
export async function getBookingWindow(
  professional: Id,
  service: Id,
): Promise<ApiResult<BookingWindowResult>> {
  const params = new URLSearchParams({ professional: String(professional), service: String(service) });
  return apiFetchDecoded(bookingWindowResult, `${schedulingPaths.bookingWindow()}?${params.toString()}`);
}

// How many open, future turnos a not-yet-saved time-off would put in conflict — powers the
// warn-then-confirm dialog. Naming professional_user_id previews a personal exception; omitting it
// previews a whole-business closure. Absent start/end ⇒ a full-day block.
export interface TimeOffPreviewBody {
  date: string;
  start?: string | null;
  end?: string | null;
  professional_user_id?: Id;
}

export async function previewTimeOffConflicts(
  body: TimeOffPreviewBody,
): Promise<ApiResult<{ count: number }>> {
  return apiFetchDecoded(object<{ count: number }>({ count: numberValue }), schedulingPaths.timeOffConflictPreview(), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// owner = 'prof:<id>' or 'res:<id>'. exclude drops that appointment from "booked" so a dragged
// block's own span reads as free.
export async function getAvailability(
  owner: string,
  date: string,
  service?: Id,  // required by the API for a professional owner (slots are service-sized)
  exclude?: Id,
): Promise<ApiResult<AvailabilityResult>> {
  const params = new URLSearchParams({ owner, date });
  if (service !== undefined) params.set('service', String(service));
  if (exclude !== undefined) params.set('exclude', String(exclude));
  return apiFetchDecoded(availabilityResult, `${schedulingPaths.availability()}?${params.toString()}`);
}

export async function getAvailabilityRange(
  owner: string,
  dateFrom: string,
  dateTo: string,
  exclude?: Id,
  options: { signal?: AbortSignal; bypassCache?: boolean } = {},
): Promise<ApiResult<AvailabilityResult[]>> {
  const params = new URLSearchParams({ owner, date_from: dateFrom, date_to: dateTo });
  if (exclude !== undefined) params.set('exclude', String(exclude));
  const path = `${schedulingPaths.availability()}?${params.toString()}`;
  const cached = availabilityCache.get(path);
  if (
    !options.bypassCache &&
    cached &&
    cached.expiresAt > Date.now() &&
    cached.mutationGeneration === getApiMutationGeneration()
  ) return cached.result;

  const pending = availabilityInFlight.get(path);
  if (pending && pending.signal === options.signal) return pending.request;

  const mutationGeneration = getApiMutationGeneration();
  const request = apiFetchDecoded(arrayOf(availabilityResult), path, { signal: options.signal })
    .then((result) => {
      if (result.ok) {
        availabilityCache.set(path, {
          expiresAt: Date.now() + AVAILABILITY_CACHE_MS,
          mutationGeneration,
          result,
        });
      }
      return result;
    })
    .finally(() => {
      if (availabilityInFlight.get(path)?.request === request) availabilityInFlight.delete(path);
    });
  availabilityInFlight.set(path, { signal: options.signal, request });
  return request;
}

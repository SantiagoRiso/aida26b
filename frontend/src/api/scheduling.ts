import { apiFetch } from '@/api/client';
import type { ApiResult } from '@/api/client';
import type { ConflictVerdict } from '@shared/ssot/domain/conflict';
import type { TimeInterval } from '@shared/ssot/domain/scheduling';

export interface ConflictCheckBody {
  professional_user_id: number;
  resource_id?: number;
  service_id: number;
  client_user_id?: number;
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
  return apiFetch<ConflictCheckResult>('/conflict-check', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export interface AvailabilityResult {
  date: string;
  slots: TimeInterval[];
  // False = the owner does not work that day; true with empty slots = fully booked.
  open: boolean;
}

// owner = 'prof:<id>' or 'res:<id>'. exclude drops that appointment from "booked" so a dragged
// block's own span reads as free.
export async function getAvailability(
  owner: string,
  date: string,
  exclude?: number,
): Promise<ApiResult<AvailabilityResult>> {
  const params = new URLSearchParams({ owner, date });
  if (exclude !== undefined) params.set('exclude', String(exclude));
  return apiFetch<AvailabilityResult>(`/availability?${params.toString()}`);
}

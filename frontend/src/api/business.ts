import { apiFetch } from '@/api/client';
import type { ApiResult } from '@/api/client';
import type { BusinessSettingsRow } from '@shared/ssot/query-types';
import { businessPaths } from '@shared/ssot/api-paths';

export type BusinessSettings = BusinessSettingsRow;

export function getSettings(
  businessId: string | number,
): Promise<ApiResult<BusinessSettings>> {
  return apiFetch<BusinessSettings>(businessPaths.settings(businessId));
}

// Session-scoped read for any authenticated user (the portal needs the cancellation cutoff).
export function getMySettings(): Promise<ApiResult<BusinessSettings>> {
  return apiFetch<BusinessSettings>(businessPaths.mySettings());
}

export function updateSettings(
  businessId: string | number,
  body: { cancellation_cutoff_hours: number; min_booking_days: number; max_booking_days: number | null },
): Promise<ApiResult<BusinessSettings>> {
  return apiFetch<BusinessSettings>(
    businessPaths.settings(businessId),
    { method: 'PATCH', body: JSON.stringify(body) },
  );
}

import { apiFetchDecoded } from '@/api/client';
import { nullable, numberValue, object, stringValue } from '@/api/decoders';
import type { ApiResult } from '@/api/client';
import type { BusinessSettingsRow } from '@shared/ssot/query-types';
import { businessPaths } from '@shared/ssot/api-paths';

export type BusinessSettings = BusinessSettingsRow;
const businessSettings = object<BusinessSettings>({
  id: stringValue,
  cancellation_cutoff_hours: numberValue,
  min_booking_days: numberValue,
  max_booking_days: nullable(numberValue),
});

export function getSettings(
  businessId: string | number,
): Promise<ApiResult<BusinessSettings>> {
  return apiFetchDecoded(businessSettings, businessPaths.settings(businessId));
}

// Session-scoped read for any authenticated user (the portal needs the cancellation cutoff).
export function getMySettings(): Promise<ApiResult<BusinessSettings>> {
  return apiFetchDecoded(businessSettings, businessPaths.mySettings());
}

export function updateSettings(
  businessId: string | number,
  body: { cancellation_cutoff_hours: number; min_booking_days: number; max_booking_days: number | null },
): Promise<ApiResult<BusinessSettings>> {
  return apiFetchDecoded(
    businessSettings,
    businessPaths.settings(businessId),
    { method: 'PATCH', body: JSON.stringify(body) },
    { toastOnForbidden: true },
  );
}

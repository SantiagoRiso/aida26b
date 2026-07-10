import { apiFetch } from '@/api/client';
import type { ApiResult } from '@/api/client';

export interface BusinessSettings {
  id: string;
  cancellation_cutoff_hours: number;
}

export function getSettings(
  businessId: string | number,
): Promise<ApiResult<BusinessSettings>> {
  return apiFetch<BusinessSettings>(`/businesses/${businessId}/settings`);
}

// Session-scoped read for any authenticated user (the portal needs the cancellation cutoff).
export function getMySettings(): Promise<ApiResult<BusinessSettings>> {
  return apiFetch<BusinessSettings>('/business/settings');
}

export function updateSettings(
  businessId: string | number,
  body: { cancellation_cutoff_hours: number },
): Promise<ApiResult<BusinessSettings>> {
  return apiFetch<BusinessSettings>(
    `/businesses/${businessId}/settings`,
    { method: 'PATCH', body: JSON.stringify(body) },
  );
}

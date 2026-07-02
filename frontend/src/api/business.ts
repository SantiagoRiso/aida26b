import { apiFetch } from '@/api/client';
import type { ApiResult } from '@/api/client';

export interface BusinessSettings {
  id: string;
  cancellation_cutoff_hours: number;
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

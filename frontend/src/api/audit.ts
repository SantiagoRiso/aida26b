import { apiFetch } from '@/api/client';
import type { ApiResult } from '@/api/client';
import type { ColumnValue } from '@shared/types/types';

export interface AuditEvent {
  id: number;
  actor_user_id: number | null;
  event_type: string;
  entity_type: string;
  entity_id: number | null;
  outcome: string;
  ip: string | null;
  // Mirrors the backend audit row's details JSONB (column-value payloads).
  details: Record<string, ColumnValue> | null;
  created_at: string;
}

export interface AuditFilters {
  entity_type?: string;
  actor_user_id?: number;
  event_type?: string;
  date_from?: string;
  date_to?: string;
  outcome?: string;
}

export function listAudit(
  filters: AuditFilters = {},
  page = 1,
  limit = 50,
): Promise<ApiResult<AuditEvent[]>> {
  const params = new URLSearchParams();
  if (filters.entity_type) params.set('entity_type', filters.entity_type);
  if (filters.actor_user_id) params.set('actor_user_id', String(filters.actor_user_id));
  if (filters.event_type) params.set('event_type', filters.event_type);
  if (filters.date_from) params.set('date_from', filters.date_from);
  if (filters.date_to) params.set('date_to', filters.date_to);
  if (filters.outcome) params.set('outcome', filters.outcome);
  if (page > 1) params.set('page', String(page));
  params.set('limit', String(limit));
  const qs = params.toString();
  return apiFetch<AuditEvent[]>(`/audit${qs ? `?${qs}` : ''}`);
}

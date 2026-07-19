import { apiFetchDecoded } from '@/api/client';
import { arrayOf, booleanValue, nullable, numberValue, object, recordOf, stringValue, union } from '@/api/decoders';
import type { ApiResult } from '@/api/client';
import type { AuditEventRow, Wire } from '@shared/ssot/query-types';
import { auditPaths } from '@shared/ssot/api-paths';

export type AuditEvent = Wire<AuditEventRow>;
// A details value is a scalar or a list of them; one unexpected shape would fail the whole page
// decode and blank the screen, so this must match what the audit writer actually records.
const scalarValue = union(union(stringValue, numberValue), union(booleanValue, nullable(stringValue)));
const columnValue = union(scalarValue, arrayOf(scalarValue));
const auditEvent = object<AuditEvent>({
  id: stringValue, actor_user_id: nullable(stringValue), event_type: stringValue,
  entity_type: nullable(stringValue), entity_id: nullable(stringValue), outcome: stringValue,
  ip: nullable(stringValue), details: nullable(recordOf(columnValue)), created_at: stringValue,
});

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
  return apiFetchDecoded(arrayOf(auditEvent), `${auditPaths.list()}${qs ? `?${qs}` : ''}`);
}

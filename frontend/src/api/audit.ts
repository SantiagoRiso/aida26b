import { apiFetchDecoded } from '@/api/client';
import { arrayOf, booleanValue, nullable, numberValue, object, optional, recordOf, stringValue, union } from '@/api/decoders';
import type { ApiResult } from '@/api/client';
import type { AuditEventRow, Wire } from '@shared/ssot/query-types';
import { auditPaths } from '@shared/ssot/api-paths';
import { listParamEntries } from '@shared/ssot/list-protocol';

export type AuditEvent = Wire<AuditEventRow>;
// A details value is a scalar or a list of them; one unexpected shape would fail the whole page
// decode and blank the screen, so this must match what the audit writer actually records.
const scalarValue = union(union(stringValue, numberValue), union(booleanValue, nullable(stringValue)));
const columnValue = union(scalarValue, arrayOf(scalarValue));
const auditEvent = object<AuditEvent>({
  // Sent only on a super-admin cross-tenant read (null marks a tenantless system event); a tenant
  // Admin's rows omit it, so the field is optional.
  id: stringValue, business_id: optional(nullable(stringValue)), actor_user_id: nullable(stringValue),
  actor_username: nullable(stringValue), entity_label: nullable(stringValue), event_type: stringValue, entity_type: nullable(stringValue), entity_id: nullable(stringValue),
  outcome: stringValue, ip: nullable(stringValue), details: nullable(recordOf(columnValue)),
  created_at: stringValue,
});

export interface AuditFilters {
  entity_type?: string;
  actor_user_id?: number;
  actor_username?: string;
  event_type?: string;
  // A `min,max` range on created_at in the shared filter grammar (either bound may be blank).
  created_at?: string;
  outcome?: string;
}

// Ordering is server-side and allowlisted there; an unknown column falls back to the default order.
export interface AuditSort {
  sort?: string;
  dir?: 'asc' | 'desc';
}

// The request and the shareable URL are serialized by the one function (listParamEntries), so the
// audit filters travel under the same `filter_` vocabulary AuditView writes into the address bar —
// there is no second, hand-maintained mapping that can drift from it.
export function listAudit(
  filters: AuditFilters = {},
  page = 1,
  limit = 50,
  order: AuditSort = {},
): Promise<ApiResult<AuditEvent[]>> {
  const record: Record<string, string> = {};
  if (filters.entity_type) record.entity_type = filters.entity_type;
  if (filters.actor_user_id) record.actor_user_id = String(filters.actor_user_id);
  if (filters.actor_username) record.actor_username = filters.actor_username;
  if (filters.event_type) record.event_type = filters.event_type;
  if (filters.outcome) record.outcome = filters.outcome;
  if (filters.created_at) record.created_at = filters.created_at;

  const entries = listParamEntries({
    page,
    limit,
    sort: order.sort,
    dir: order.sort ? (order.dir ?? 'asc') : undefined,
    filters: record,
  });
  const qs = new URLSearchParams(entries).toString();
  return apiFetchDecoded(arrayOf(auditEvent), `${auditPaths.list()}${qs ? `?${qs}` : ''}`);
}

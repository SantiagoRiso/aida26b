import { query } from './core';
import type { Queryable, SqlParam } from './core';
import type { AuditEventRow } from '../../../shared/src/ssot/query-types';
import { dateBoundConditions } from './date-bounds';
import { orderByClause } from './sort';
import type { ListSort, SortColumns } from './sort';
import type { AuditSortField } from '../../../shared/src/ssot/list-sort';
import { BUSINESS_TZ } from '../time';

// ip is null for in-transaction writes (auditInTx) that don't carry a request. businessId is null
// only for events that belong to no tenant — a login attempt on a username nobody holds.
export async function insertAuditEvent(
  db: Queryable,
  e: {
    businessId: number | null;
    actorId: number | null;
    eventType: string;
    entityType: string | null;
    entityId: number | null;
    outcome: string;
    ip: string | null;
    detailsJson: string;
  },
): Promise<void> {
  await query(
    db,
    `INSERT INTO audit_events
       (business_id, actor_user_id, event_type, entity_type, entity_id, outcome, ip, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [e.businessId, e.actorId, e.eventType, e.entityType, e.entityId, e.outcome, e.ip, e.detailsJson],
  );
}

// A tenant Admin is confined to their own business; a super-admin (Admin with no business) reads
// every tenant plus the tenantless rows, which belong to no business and so satisfy no equality.
// Spelled as a union rather than a nullable id so widening scope has to be asked for, not defaulted.
export type AuditScope =
  | { kind: 'tenant'; businessId: number }
  | { kind: 'all' };

// SQL for each sortable column the shared declaration names. Every other value falls back to the
// default order.
export const AUDIT_SORT_COLUMNS: SortColumns<AuditSortField> = {
  created_at: 'a.created_at',
  event_type: 'a.event_type',
  entity_type: 'a.entity_type',
  actor_username: personName('u'),
  outcome: 'a.outcome',
};

// Newest first: the audit log is read as a record of what just happened.
export const AUDIT_DEFAULT_SORT: ListSort<AuditSortField> = { column: 'created_at', dir: 'desc' };

// The endpoint's own filter allowlist. Audit is bespoke, so the field names a filter may name come
// from here rather than an SSoT descriptor; anything else the route drops. `created_at` reads the
// shared `min,max` range grammar, `actor_username` is a substring search over the actor's name and
// login; the rest are exact-match identity fields.
export const AUDIT_FILTER_FIELDS = ['entity_type', 'actor_user_id', 'actor_username', 'event_type', 'outcome', 'created_at'] as const;
export type AuditFilterField = (typeof AUDIT_FILTER_FIELDS)[number];

// An exact-match filter carries its `!` negation so the endpoint can honor the shared grammar
// instead of silently applying the inverse. Negation compiles to IS DISTINCT FROM, so on a nullable
// column (entity_type) "not X" keeps the NULL rows rather than dropping them.
export type AuditEqFilter<T = string> = { value: T; negated: boolean };

export type AuditListFilter = {
  scope: AuditScope;
  sort: ListSort<AuditSortField>;
  entityType?: AuditEqFilter;
  actorUserId?: AuditEqFilter<number>;
  actorUsername?: AuditEqFilter;
  eventType?: AuditEqFilter;
  outcome?: AuditEqFilter;
  dateFrom?: string;
  dateTo?: string;
  limit: number;
  offset: number;
};

// `= $n` matches nothing for a NULL column, and `<> $n` would drop NULL rows from a negated filter;
// IS DISTINCT FROM makes the negated set the exact complement of the positive one.
function matchOp(negated: boolean): string {
  return negated ? 'IS DISTINCT FROM' : '=';
}

// One answer to "what do we call this person", for whichever joined user is being named: the login
// when there is one, the display name otherwise. A contact-only client has no username, and an
// actor and an entity must not disagree about the same row. Deliberately not used by the search
// below — matching is over both identifiers, which is a wider question than what to display.
function personName(alias: string): string {
  return `coalesce(${alias}.username, ${alias}.display_name)`;
}

// A reader looking for "who did this" knows a person, not an exact login, so the actor filter
// matches a fragment of either the username or the display name. The wildcards belong to the
// grammar, not to the value: a search for `a_b` means those three characters, so an input's own
// `%`/`_` is escaped rather than left to match anything.
function escapeLikeValue(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// coalesce keeps the expression two-valued, so a negated search is the exact complement and still
// returns the tenantless events whose actor is null.
function actorMatchCondition(paramIndex: number, negated: boolean): string {
  const pattern = `'%' || $${paramIndex} || '%'`;
  const match = `(coalesce(u.username, '') ILIKE ${pattern} ESCAPE '\\'`
    + ` OR coalesce(u.display_name, '') ILIKE ${pattern} ESCAPE '\\')`;
  return negated ? `NOT ${match}` : match;
}

// Only code-controlled column names are interpolated; every filter value is a bound $N param.
// Events written in one transaction share created_at, so the id closes the sort — without a unique
// tiebreaker two pages of the same list can repeat one event and never show another.
export async function listAuditEvents(
  db: Queryable,
  f: AuditListFilter,
): Promise<{ rows: AuditEventRow[]; total: number }> {
  const conditions: string[] = [];
  const params: SqlParam[] = [];
  let p = 1;

  if (f.scope.kind === 'tenant') {
    conditions.push(`a.business_id = $${p++}`);
    params.push(f.scope.businessId);
  }

  if (f.entityType != null) { conditions.push(`a.entity_type ${matchOp(f.entityType.negated)} $${p++}`); params.push(f.entityType.value); }
  if (f.actorUserId != null) { conditions.push(`a.actor_user_id ${matchOp(f.actorUserId.negated)} $${p++}`); params.push(f.actorUserId.value); }
  if (f.actorUsername != null) { conditions.push(actorMatchCondition(p++, f.actorUsername.negated)); params.push(escapeLikeValue(f.actorUsername.value)); }
  if (f.eventType != null) { conditions.push(`a.event_type ${matchOp(f.eventType.negated)} $${p++}`); params.push(f.eventType.value); }
  if (f.outcome != null) { conditions.push(`a.outcome ${matchOp(f.outcome.negated)} $${p++}`); params.push(f.outcome.value); }

  const dates = dateBoundConditions('a.created_at', { from: f.dateFrom, to: f.dateTo }, p);
  conditions.push(...dates.conditions);
  params.push(...dates.params);
  p = dates.nextIndex;

  const where = conditions.length > 0 ? conditions.join(' AND ') : 'true';

  // The tenant column is for the super-admin's cross-tenant read only; a tenant Admin sees one
  // business and gets the same projection they always did.
  const businessCol = f.scope.kind === 'all' ? 'a.business_id, ' : '';

  // Every join is outer so an event whose subject was purged still appears — dropping it would edit
  // the record. Shared with the count query: a filter only one of them applied would report a total
  // the page can't produce. Each ON tests the entity type first, so a row only pays for the join
  // that can match it.
  //
  // `u` is who acted. The rest answer "on what", which for a reset or a cancellation is the whole
  // point of the row and which the id alone never says.
  const from = `FROM audit_events a
       LEFT JOIN auth.users_directory u ON u.id = a.actor_user_id
       LEFT JOIN auth.users_directory tgt ON a.entity_type = 'auth.users' AND tgt.id = a.entity_id
       LEFT JOIN appointments ap ON a.entity_type = 'appointments' AND ap.id = a.entity_id
       LEFT JOIN auth.users_directory apc ON apc.id = ap.client_user_id`;

  // A contact-only client has no username, so a person falls back to the display name, which is
  // NOT NULL. A turno is named by whose it is and when, because a client books more than one.
  // Whatever is left keeps its id: an entity with no natural name is better shown as the locator
  // it is than given an invented one.
  const tzParam = p;
  const entityLabel = `CASE
              WHEN a.entity_type = 'auth.users' THEN ${personName('tgt')}
              WHEN ap.id IS NOT NULL
                THEN apc.display_name || ' · ' || to_char(ap.starts_at AT TIME ZONE $${tzParam}, 'DD/MM HH24:MI')
            END AS entity_label`;

  const pageRows = await query<AuditEventRow & { total_count: string }>(
    db,
    `SELECT a.id, ${businessCol}a.actor_user_id, ${personName('u')} AS actor_username,
            ${entityLabel},
            a.event_type, a.entity_type, a.entity_id,
            a.outcome, a.ip, a.details, a.created_at,
            count(*) OVER()::text AS total_count
       ${from}
      WHERE ${where}
      ORDER BY ${orderByClause(AUDIT_SORT_COLUMNS, f.sort, 'a.id')}
      LIMIT $${p + 1} OFFSET $${p + 2}`,
    // The timezone is bound, not written into the SQL, so the wall-clock a reader sees comes from
    // the one constant the rest of the app resolves business days with.
    [...params, BUSINESS_TZ, f.limit, f.offset],
  );
  if (pageRows.length === 0) {
    const count = await query<{ n: string }>(
      db,
      `SELECT count(*)::text AS n ${from} WHERE ${where}`,
      params,
    );
    return { rows: [], total: Number(count[0]?.n ?? 0) };
  }
  const total = Number(pageRows[0].total_count);
  const rows = pageRows.map(({ total_count: _, ...row }) => row as AuditEventRow);
  return { rows, total };
}

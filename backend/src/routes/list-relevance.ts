import { getPkFields } from '../../../shared/src/utils/utils';
import type { TableKey } from '../../../shared/src/ssot/derived';
import type { ListRequestSpec } from '../../../shared/src/ssot/list-protocol';
import type { AuthUser } from '../auth';
import type { SqlParam } from '../db/core';
import { relatedClientIdsFragment, type RelatedClientScope } from '../db/appointments';

// Relevance narrowing sits on top of the descriptor scopes, and is deliberately not one of them:
// the descriptor scopes say what a viewer may read at all and are unconditional, while this says
// which of those rows are worth showing and the viewer may waive it per request. Waiving it can
// never widen permission — the business, ownership, discriminator and grant predicates still
// apply. It is compiled into the same statement as those scopes so the counted set and the
// returned page are always the same set.

export type ListRelevance = { relevanceWhere?: string; relevanceParams?: SqlParam[] };

// Staff work with the people they have already seen. An Admin manages the whole tenant, so every
// client is relevant to them; a Client only ever sees their own row.
function relatedClientScope(user: AuthUser): RelatedClientScope | null {
  if (user.business_id == null) return null;
  if (user.role === 'Professional') return { businessId: user.business_id, professionalUserId: user.id };
  if (user.role === 'Receptionist') return { businessId: user.business_id, granteeUserId: user.id };
  return null;
}

export function resolveListRelevance(
  table: TableKey,
  user: AuthUser,
  spec: ListRequestSpec,
): ListRelevance {
  if (table !== 'clients' || spec.includeUnrelated) return {};

  const scope = relatedClientScope(user);
  if (!scope) return {};

  const { sql, params } = relatedClientIdsFragment(scope);
  return { relevanceWhere: `"${getPkFields(table)[0]}" IN (${sql})`, relevanceParams: params };
}

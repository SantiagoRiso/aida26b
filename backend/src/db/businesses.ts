import { queryOne } from './core';
import type { Queryable } from './core';
import type { BusinessSettingsRow } from '../../../shared/src/ssot/query-types';

export function getBusinessSettings(db: Queryable, businessId: number): Promise<BusinessSettingsRow | null> {
  return queryOne<BusinessSettingsRow>(
    db,
    `SELECT id, cancellation_cutoff_hours FROM businesses WHERE id = $1`,
    [businessId],
  );
}

export function updateBusinessCutoff(
  db: Queryable,
  businessId: number,
  cutoffHours: number,
): Promise<BusinessSettingsRow | null> {
  return queryOne<BusinessSettingsRow>(
    db,
    `UPDATE businesses
        SET cancellation_cutoff_hours = $1
      WHERE id = $2
      RETURNING id, cancellation_cutoff_hours`,
    [cutoffHours, businessId],
  );
}

// The cancellation cutoff for the business a given user belongs to. Null when unresolved.
export function getCancellationCutoffHours(db: Queryable, userId: number): Promise<number | null> {
  return queryOne<{ cancellation_cutoff_hours: number }>(
    db,
    `SELECT b.cancellation_cutoff_hours
       FROM businesses b
       JOIN auth.users u ON u.business_id = b.id
      WHERE u.id = $1 LIMIT 1`,
    [userId],
  ).then((r) => r?.cancellation_cutoff_hours ?? null);
}

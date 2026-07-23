import { queryOne } from './core';
import type { Queryable } from './core';

// Pricing reads over the catalog tables (services, client_professional_services). Shared by the
// booking (appointments) and conflict-check (scheduling) paths — one home for the effective-price
// lookups so the two can never diverge.

// Service default price, business-scoped; null when the service is absent/archived in this business.
export function getServiceDefaultPrice(db: Queryable, serviceId: number, businessId: number): Promise<string | null> {
  return queryOne<{ default_price_ars: string }>(
    db,
    `SELECT default_price_ars FROM services
      WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL`,
    [serviceId, businessId],
  ).then((r) => r?.default_price_ars ?? null);
}

// Service defaults (duration + price), business-scoped; null when absent/archived. duration is
// INTEGER (pg number); price is NUMERIC (kept as a decimal string, per the no-coercion contract).
export function getServiceDefaults(
  db: Queryable,
  serviceId: number,
  businessId: number,
): Promise<{ default_duration_minutes: number; default_price_ars: string } | null> {
  return queryOne<{ default_duration_minutes: number; default_price_ars: string }>(
    db,
    `SELECT default_duration_minutes, default_price_ars FROM services
      WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL`,
    [serviceId, businessId],
  );
}

// The professional's service offering as booking needs it: whether they offer this one, and whether
// they restrict at all. Business-scoped to the active professional; null when they are not one of
// this business's professionals (caller maps that to 404).
export function getProfessionalServiceOffer(
  db: Queryable,
  professionalUserId: number,
  serviceId: number,
  businessId: number,
): Promise<{ offers_service: boolean; restricts_services: boolean } | null> {
  return queryOne<{ offers_service: boolean; restricts_services: boolean }>(
    db,
    `SELECT EXISTS (SELECT 1 FROM professional_services ps
                     WHERE ps.professional_user_id = u.id AND ps.service_id = $2) AS offers_service,
            EXISTS (SELECT 1 FROM professional_services ps
                     WHERE ps.professional_user_id = u.id)                       AS restricts_services
       FROM auth.users u
      WHERE u.id = $1 AND u.business_id = $3
        AND u.role = 'Professional' AND u.is_active = true`,
    [professionalUserId, serviceId, businessId],
  );
}

// Per-client override price, business-scoped to prevent cross-tenant price reads; null when none.
export function getClientOverridePrice(
  db: Queryable,
  clientUserId: number,
  professionalUserId: number,
  serviceId: number,
  businessId: number,
): Promise<string | null> {
  return queryOne<{ price_ars: string }>(
    db,
    `SELECT cps.price_ars
       FROM client_professional_services cps
       JOIN auth.users u ON u.id = cps.client_user_id
      WHERE cps.client_user_id       = $1
        AND cps.professional_user_id = $2
        AND cps.service_id           = $3
        AND u.business_id            = $4`,
    [clientUserId, professionalUserId, serviceId, businessId],
  ).then((r) => r?.price_ars ?? null);
}

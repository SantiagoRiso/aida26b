import express from 'express';
import type { RequestHandler } from 'express';
import type { Pool } from 'pg';
import { sendData, sendError } from '../status_messages';
import { guardRoute } from '../helpers';
import { authenticatedUser } from '../session';
import type { AuditWriter } from '../audit';
import { requireBusinessContext } from './business-context';
import { adminTenantScope } from './tenant-scope';
import { getBusinessSettings, updateBusinessSettings } from '../db/businesses';
import type { ColumnValue } from '../../../shared/src/types/types';
import { BUSINESS_PATTERNS } from '../../../shared/src/ssot/api-paths';

// businesses is deliberately excluded from generic CRUD. This module owns the only
// writable surface for business config: a single settings PATCH (cutoff + booking window).
export function mountBusinessSettingsRoutes(
  app: express.Application,
  pool: Pool,
  guards: { auth: RequestHandler; passwordReady: RequestHandler; audit: AuditWriter },
) {
  // Admin gate for the :id routes. The :id names the target tenant: a super-admin may target any
  // business (an unknown one 404s downstream when its settings don't load); a tenant Admin only its
  // own, so a mismatched :id is cross-tenant and returns 404 to hide existence.
  async function resolveAdminBusinessTarget(
    req: express.Request,
    res: express.Response,
  ): Promise<number | null> {
    const user = authenticatedUser(req);

    if (user.role !== 'Admin') {
      await guards.audit(req, 'permission_denied', 'denied', {
        path: req.path,
        method: req.method,
      });
      sendError(res, 403, 'forbidden', 'Admin access required');
      return null;
    }

    const scope = adminTenantScope(req, res);
    if (scope == null) return null;

    const targetId = Number(req.params.id);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      sendError(res, 404, 'not_found', 'Business not found');
      return null;
    }

    if (scope.kind === 'tenant' && targetId !== scope.businessId) {
      sendError(res, 404, 'not_found', 'Business not found');
      return null;
    }
    return targetId;
  }

  async function sendSettingsOr404(res: express.Response, businessId: number) {
    const settings = await getBusinessSettings(pool, businessId);
    if (!settings) {
      return sendError(res, 404, 'not_found', 'Business not found');
    }
    return sendData(res, settings);
  }

  // Session-scoped, any authenticated role: the cancellation cutoff is business policy the portal
  // needs to show clients why a cancel is (un)available. Non-sensitive — no admin gate.
  app.get(BUSINESS_PATTERNS.mySettings, guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const businessId = requireBusinessContext(req, res);
    if (businessId == null) return;

    return sendSettingsOr404(res, businessId);
  }));

  app.get(BUSINESS_PATTERNS.settings, guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const businessId = await resolveAdminBusinessTarget(req, res);
    if (businessId == null) return;

    return sendSettingsOr404(res, businessId);
  }));

  app.patch(BUSINESS_PATTERNS.settings, guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const businessId = await resolveAdminBusinessTarget(req, res);
    if (businessId == null) return;

    const rawCutoff = req.body.cancellation_cutoff_hours;
    const cutoffHours = Number(rawCutoff);
    if (
      rawCutoff === undefined ||
      rawCutoff === null ||
      !Number.isInteger(cutoffHours) ||
      cutoffHours < 0
    ) {
      return sendError(res, 422, 'invalid_request', 'cancellation_cutoff_hours must be a non-negative integer', {
        fields: { cancellation_cutoff_hours: 'required non-negative integer' },
        fieldDetails: { cancellation_cutoff_hours: { key: 'nonNegativeInteger' } },
      });
    }

    // Non-negative integer, or undefined when the key is absent (partial update).
    const asOptInt = (raw: ColumnValue, allowNull: boolean): { ok: boolean; value?: number | null } => {
      if (raw === undefined) return { ok: true, value: undefined };
      if (raw === null) return allowNull ? { ok: true, value: null } : { ok: false };
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) return { ok: false };
      return { ok: true, value: n };
    };

    const minParsed = asOptInt(req.body.min_booking_days, false);
    if (!minParsed.ok || minParsed.value === null) {
      return sendError(res, 422, 'invalid_request', 'min_booking_days must be a non-negative integer', {
        fields: { min_booking_days: 'non-negative integer' },
        fieldDetails: { min_booking_days: { key: 'nonNegativeInteger' } },
      });
    }
    const maxParsed = asOptInt(req.body.max_booking_days, true);
    if (!maxParsed.ok) {
      return sendError(res, 422, 'invalid_request', 'max_booking_days must be a non-negative integer or null', {
        fields: { max_booking_days: 'non-negative integer or null' },
        fieldDetails: { max_booking_days: { key: 'nonNegativeIntegerOrEmpty' } },
      });
    }

    const current = await getBusinessSettings(pool, businessId);
    if (!current) {
      return sendError(res, 404, 'not_found', 'Business not found');
    }
    const minDays = minParsed.value === undefined ? current.min_booking_days : minParsed.value;
    const maxDays = maxParsed.value === undefined ? current.max_booking_days : maxParsed.value;
    if (maxDays !== null && maxDays < minDays) {
      return sendError(res, 422, 'invalid_request', 'max_booking_days must be greater than or equal to min_booking_days', {
        fields: { max_booking_days: 'must be ≥ min_booking_days' },
        fieldDetails: { max_booking_days: { key: 'maxBookingBelowMin' } },
      });
    }

    const updated = await updateBusinessSettings(pool, businessId, {
      cancellation_cutoff_hours: cutoffHours,
      min_booking_days: minDays,
      max_booking_days: maxDays,
    });
    if (!updated) {
      return sendError(res, 404, 'not_found', 'Business not found');
    }

    // No data-integrity dependency on the audit row, so guards.audit (pool) is fine here. Attributed
    // to the tenant being edited, not the actor — a super-admin has no business of its own.
    await guards.audit(req, 'business_settings_updated', 'success', {
      business_id: businessId,
      cancellation_cutoff_hours: cutoffHours,
      min_booking_days: minDays,
      max_booking_days: maxDays,
    }, { businessId });

    return sendData(res, updated);
  }));
}

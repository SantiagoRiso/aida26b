import express from 'express';
import type { RequestHandler } from 'express';
import type { Pool } from 'pg';
import { sendData, sendError } from '../status_messages';
import { guardRoute } from '../helpers';
import { type AuthedRequest } from '../session';
import type { AuditWriter } from '../audit';
import { requireBusinessContext } from './business-context';
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
  // Admin gate for the :id routes. A mismatched :id is cross-tenant — returns 404 to hide existence.
  async function resolveAdminBusinessTarget(
    req: express.Request,
    res: express.Response,
  ): Promise<number | null> {
    const user = (req as AuthedRequest).user!;

    if (user.role !== 'Admin') {
      await guards.audit(req, 'permission_denied', 'denied', {
        path: req.path,
        method: req.method,
      });
      sendError(res, 403, 'forbidden', 'Admin access required');
      return null;
    }

    const businessId = requireBusinessContext(req, res);
    if (businessId == null) return null;

    if (Number(req.params.id) !== businessId) {
      sendError(res, 404, 'not_found', 'Business not found');
      return null;
    }
    return businessId;
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
        cancellation_cutoff_hours: 'required non-negative integer',
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
    if (!minParsed.ok) {
      return sendError(res, 422, 'invalid_request', 'min_booking_days must be a non-negative integer', {
        min_booking_days: 'non-negative integer',
      });
    }
    const maxParsed = asOptInt(req.body.max_booking_days, true);
    if (!maxParsed.ok) {
      return sendError(res, 422, 'invalid_request', 'max_booking_days must be a non-negative integer or null', {
        max_booking_days: 'non-negative integer or null',
      });
    }

    const current = await getBusinessSettings(pool, businessId);
    if (!current) {
      return sendError(res, 404, 'not_found', 'Business not found');
    }
    const minDays = minParsed.value === undefined ? current.min_booking_days : (minParsed.value as number);
    const maxDays = maxParsed.value === undefined ? current.max_booking_days : maxParsed.value;
    if (maxDays !== null && maxDays < minDays) {
      return sendError(res, 422, 'invalid_request', 'max_booking_days must be greater than or equal to min_booking_days', {
        max_booking_days: 'must be ≥ min_booking_days',
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

    // No data-integrity dependency on the audit row, so guards.audit (pool) is fine here.
    await guards.audit(req, 'business_settings_updated', 'success', {
      business_id: businessId,
      cancellation_cutoff_hours: cutoffHours,
      min_booking_days: minDays,
      max_booking_days: maxDays,
    });

    return sendData(res, updated);
  }));
}

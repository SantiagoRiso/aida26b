import express from 'express';
import type { Request, RequestHandler } from 'express';
import type { Pool } from 'pg';
import { sendData, sendError, sendList } from '../status_messages';
import { guardRoute } from '../helpers';
import type { AuthUser } from '../auth';
import { LEDGER_ENTRY_TYPES } from '../../../shared/src/ssot/domain';
import {
  assertLedgerWriteAllowed,
  assertLedgerReadAllowed,
  auditInTx,
} from './appointment-authz';
import { withTransaction } from '../db/core';
import { activeClientInBusiness } from '../db/users';
import {
  getAppointmentChargeAmount,
  insertLedgerEntry,
  getClientBalance,
  listClientLedger,
} from '../db/ledger';
import type { ColumnValue } from '../../../shared/src/types/types';

type AuthedRequest = Request & { user?: AuthUser };

type AuditFn = (
  req: Request,
  eventType: string,
  outcome: string,
  details?: Record<string, ColumnValue>,
) => Promise<void>;

// Amount must be non-negative with at most two decimal places (mirrors amount_ars CHECK in DB).
const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;

// Plain string set avoids type narrowing issues on user input.
const VALID_ENTRY_TYPES: Set<string> = new Set(LEDGER_ENTRY_TYPES.map((t) => t.value));

export function mountLedgerRoutes(
  app: express.Application,
  pool: Pool,
  guards: { auth: RequestHandler; passwordReady: RequestHandler; audit: AuditFn },
) {
  // The authz check runs inside the transaction so the grant check and INSERT are atomic.
  app.post('/api/ledger', guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = (req as AuthedRequest).user!;

    if (user.business_id == null) {
      return sendError(res, 400, 'no_business', 'A business context is required');
    }
    const businessId = user.business_id;

    const fields: Record<string, string> = {};

    const clientUserId = Number(req.body.client_user_id);
    if (!Number.isInteger(clientUserId) || clientUserId <= 0) {
      fields.client_user_id = 'required positive integer';
    }

    const entryType: string = req.body.entry_type ?? '';
    if (!VALID_ENTRY_TYPES.has(entryType)) {
      fields.entry_type = `must be one of: ${[...VALID_ENTRY_TYPES].join(', ')}`;
    }

    const rawAmount: string | undefined = req.body.amount_ars;
    if (rawAmount !== undefined && rawAmount !== null && !AMOUNT_RE.test(String(rawAmount))) {
      fields.amount_ars = 'must be a non-negative amount (e.g. 1500 or 1500.00)';
    }

    if (Object.keys(fields).length > 0) {
      return sendError(res, 422, 'invalid_request', 'Invalid request', fields);
    }

    const appointmentId: number | null =
      req.body.appointment_id != null ? Number(req.body.appointment_id) : null;
    const description: string | null = req.body.description ?? null;

    if (!(await activeClientInBusiness(pool, clientUserId, businessId))) {
      return sendError(res, 404, 'not_found', 'Client not found in this business');
    }

    const outcome = await withTransaction(pool, async (tx) => {
      const authz = await assertLedgerWriteAllowed(tx, user, {
        clientUserId,
        appointmentId,
        entryType,
      });
      if (!authz.ok) return { kind: 'denied' as const, authz };

      // Prefill amount from the appointment's booked price for charges when the caller omitted
      // amount_ars. An explicitly supplied amount takes precedence.
      let amountArs: string;
      if (rawAmount !== undefined && rawAmount !== null) {
        amountArs = String(rawAmount);
      } else if (appointmentId != null && entryType === 'charge') {
        const price = await getAppointmentChargeAmount(tx, appointmentId, clientUserId, businessId);
        if (price == null) return { kind: 'appt_not_found' as const };
        amountArs = price;
      } else {
        return { kind: 'amount_required' as const };
      }

      const row = await insertLedgerEntry(tx, {
        clientUserId,
        appointmentId,
        entryType,
        amountArs,
        description,
        actorUserId: user.id,
      });
      await auditInTx(tx, user, `ledger_${entryType}_created`, 'success', Number(row!.id), 'ledger_entries');
      return { kind: 'ok' as const, row: row! };
    });

    if (outcome.kind === 'denied') {
      // Denial audit is best-effort; guards.audit uses the pool, not the committed transaction.
      await guards.audit(req, 'ledger_write_denied', 'denied', {
        reason: outcome.authz.code,
        entry_type: entryType,
        client_user_id: clientUserId,
      });
      return sendError(res, outcome.authz.status, outcome.authz.code, outcome.authz.message);
    }
    if (outcome.kind === 'appt_not_found') {
      return sendError(res, 404, 'not_found', 'Referenced appointment not found');
    }
    if (outcome.kind === 'amount_required') {
      return sendError(res, 422, 'invalid_request', 'amount_ars is required', {
        amount_ars: 'required when no appointment_id is supplied or entry_type is not charge',
      });
    }
    return sendData(res, outcome.row, 201);
  }));

  // Read authz runs on the pool — no write follows, so TOCTOU is not a concern here.
  app.get('/api/clients/:id/balance', guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = (req as AuthedRequest).user!;

    const clientUserId = Number(req.params.id);
    if (!Number.isInteger(clientUserId) || clientUserId <= 0) {
      return sendError(res, 400, 'invalid_request', 'Valid client id required');
    }

    const authz = await assertLedgerReadAllowed(pool, user, clientUserId);
    if (!authz.ok) {
      return sendError(res, authz.status, authz.code, authz.message);
    }

    const balanceArs = await getClientBalance(pool, clientUserId);

    return sendData(res, {
      client_user_id: clientUserId,
      balance_ars: balanceArs,
    });
  }));

  app.get('/api/clients/:id/ledger', guards.auth, guards.passwordReady, guardRoute(async (req, res) => {
    const user = (req as AuthedRequest).user!;

    const clientUserId = Number(req.params.id);
    if (!Number.isInteger(clientUserId) || clientUserId <= 0) {
      return sendError(res, 400, 'invalid_request', 'Valid client id required');
    }

    const authz = await assertLedgerReadAllowed(pool, user, clientUserId);
    if (!authz.ok) {
      return sendError(res, authz.status, authz.code, authz.message);
    }

    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const offset = (page - 1) * limit;

    const { rows, total } = await listClientLedger(pool, clientUserId, { limit, offset });

    return sendList(res, rows, { page, limit, total });
  }));
}

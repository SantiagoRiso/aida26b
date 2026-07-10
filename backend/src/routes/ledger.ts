import express from 'express';
import type { Request, RequestHandler } from 'express';
import { Pool } from 'pg';
import { sendData, sendError, sendList } from '../status_messages';
import { guardRoute } from '../helpers';
import type { AuthUser } from '../auth';
import { LEDGER_ENTRY_TYPES } from '../../../shared/src/ssot/domain';
import {
  assertLedgerWriteAllowed,
  assertLedgerReadAllowed,
  auditInTx,
} from './appointment-authz';
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

    const clientCheck = await pool.query<{ id: string }>(
      `SELECT id FROM auth.users
       WHERE id = $1 AND role = 'Client' AND business_id = $2 AND is_active = true`,
      [clientUserId, user.business_id],
    );
    if (clientCheck.rows.length === 0) {
      return sendError(res, 404, 'not_found', 'Client not found in this business');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const authz = await assertLedgerWriteAllowed(client, user, {
        clientUserId,
        appointmentId,
        entryType,
      });

      if (!authz.ok) {
        await client.query('ROLLBACK');
        // Denial audit is best-effort; guards.audit uses pool, not the rolled-back client.
        await guards.audit(req, 'ledger_write_denied', 'denied', {
          reason: authz.code,
          entry_type: entryType,
          client_user_id: clientUserId,
        });
        return sendError(res, authz.status, authz.code, authz.message);
      }

      // Prefill amount from the appointment's booked price for charges when the caller
      // omitted amount_ars. An explicitly supplied amount takes precedence.
      let amountArs: string;
      if (rawAmount !== undefined && rawAmount !== null) {
        amountArs = String(rawAmount);
      } else if (appointmentId != null && entryType === 'charge') {
        // Constrain to the appointment owned by the charged client and the caller's
        // business — prevents sourcing an amount from a cross-tenant appointment.
        const appt = await client.query<{ price: string }>(
          `SELECT a.price
           FROM appointments a
           JOIN auth.users c ON c.id = a.client_user_id
           WHERE a.id = $1 AND a.client_user_id = $2 AND c.business_id = $3`,
          [appointmentId, clientUserId, user.business_id],
        );
        if (appt.rows.length === 0) {
          await client.query('ROLLBACK');
          return sendError(res, 404, 'not_found', 'Referenced appointment not found');
        }
        amountArs = appt.rows[0].price;
      } else {
        await client.query('ROLLBACK');
        return sendError(res, 422, 'invalid_request', 'amount_ars is required', {
          amount_ars: 'required when no appointment_id is supplied or entry_type is not charge',
        });
      }

      const result = await client.query(
        `INSERT INTO ledger_entries
           (client_user_id, appointment_id, entry_type, amount_ars, description, actor_user_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [clientUserId, appointmentId, entryType, amountArs, description, user.id],
      );

      const row = result.rows[0];

      const eventType = `ledger_${entryType}_created`;
      await auditInTx(client, user, eventType, 'success', Number(row.id), 'ledger_entries');

      await client.query('COMMIT');

      return sendData(res, row, 201);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
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

    const result = await pool.query<{ balance_ars: string }>(
      `SELECT
         COALESCE(SUM(amount_ars) FILTER (WHERE entry_type IN ('charge', 'adjustment_debit')),  0)
         -
         COALESCE(SUM(amount_ars) FILTER (WHERE entry_type IN ('payment', 'adjustment_credit')), 0)
         AS balance_ars
       FROM ledger_entries
       WHERE client_user_id = $1`,
      [clientUserId],
    );

    return sendData(res, {
      client_user_id: clientUserId,
      balance_ars: result.rows[0].balance_ars,
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

    const [rows, count] = await Promise.all([
      pool.query(
        `SELECT * FROM ledger_entries
         WHERE client_user_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [clientUserId, limit, offset],
      ),
      pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ledger_entries WHERE client_user_id = $1`,
        [clientUserId],
      ),
    ]);

    return sendList(res, rows.rows, { page, limit, total: Number(count.rows[0].n) });
  }));
}

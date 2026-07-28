import type { TableStructure } from '../../types/types';
import type { Role } from '../../types/roles';
import { pkColumn } from './business';
import { AMOUNT_PATTERN, AMOUNT_PATTERN_MESSAGE, AMOUNT_PATTERN_KEY } from './catalog';

// Each entry's sign drives the balance: debits increase the client's debt, credits reduce it.
// Balance = Σ(debits) − Σ(credits) — the one place the debit/credit split is declared.
export const LEDGER_ENTRY_TYPES = [
  { value: 'charge',             label: { es: 'Cargo',              en: 'Charge' },              sign: 'debit' },
  { value: 'payment',            label: { es: 'Pago',               en: 'Payment' },             sign: 'credit' },
  { value: 'adjustment_debit',   label: { es: 'Ajuste (débito)',    en: 'Adjustment (debit)' },  sign: 'debit' },
  { value: 'adjustment_credit',  label: { es: 'Ajuste (crédito)',   en: 'Adjustment (credit)' }, sign: 'credit' },
] as const;

export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number]['value'];

export const LEDGER_DEBIT_TYPES = LEDGER_ENTRY_TYPES.filter((t) => t.sign === 'debit').map((t) => t.value);
export const LEDGER_CREDIT_TYPES = LEDGER_ENTRY_TYPES.filter((t) => t.sign === 'credit').map((t) => t.value);

// Roles that may create a ledger entry at all. The server refines this per-role (a Professional
// only for own clients, a Receptionist only for granted appointment charges); Clients never can.
// ledger_entries has no descriptor roleRequired — authz is bespoke — so this list is the shared
// source the server's check and the frontend gate both read.
export const LEDGER_WRITE_ROLES: Role[] = ['Admin', 'Professional', 'Receptionist'];

// The front desk collects money for sessions, so a Receptionist recording a charge or a payment
// must name the turno it settles, on a calendar they hold a grant for. An adjustment settles no
// session by definition and so has no turno to name: it is scoped instead to the clients whose
// ledger the Receptionist may already read. Declared here so the server's check and the form's
// type list cannot drift.
export const RECEPTIONIST_APPOINTMENT_LINKED_TYPES: LedgerEntryType[] = ['charge', 'payment'];

export const financeTables = {
  // Immutable: balance is SUM over entries; corrections are new adjustment rows.
  // business_id is derived via the client (auth.users.business_id).
  ledger_entries: {
    columns: {
      id: pkColumn,
      client_user_id: {
        type: 'string',
        label: { es: 'Cliente', en: 'Client' },
        input: 'select',
        validator: { required: true },
        filterable: true,
        sortable: false,
        foreignKey: { table: 'clients', valueField: 'id', labelField: 'display_name' },
      },
      appointment_id: {
        type: 'string',
        label: { es: 'Turno', en: 'Appointment' },
        input: 'select',
        validator: { nullable: true },
        filterable: true,
        sortable: false,
        foreignKey: { table: 'appointments', valueField: 'id', labelField: 'name' },
      },
      entry_type: {
        type: 'string',
        label: { es: 'Tipo', en: 'Type' },
        input: 'select',
        validator: { required: true },
        filterable: true,
        sortable: true,
        options: LEDGER_ENTRY_TYPES.map((t) => ({ value: t.value, label: t.label })),
      },
      amount_ars: {
        type: 'string',
        label: { es: 'Monto (ARS)', en: 'Amount (ARS)' },
        validator: {
          required: true,
          pattern: AMOUNT_PATTERN,
          patternMessage: AMOUNT_PATTERN_MESSAGE,
          patternKey: AMOUNT_PATTERN_KEY,
        },
        filterable: false,
        sortable: true,
      },
      description: {
        type: 'string',
        label: { es: 'Descripción', en: 'Description' },
        input: 'textarea',
        validator: { nullable: true },
        filterable: false,
        sortable: false,
      },
      actor_user_id: {
        type: 'string',
        label: { es: 'Registrado por', en: 'Recorded By' },
        input: 'select',
        validator: { nullable: true },
        filterable: false,
        sortable: false,
        foreignKey: { table: 'users', valueField: 'id', labelField: 'username' },
      },
    },
    pk: 'id',
    uiName: { es: 'Movimiento', en: 'Ledger Entry' },
    title: { es: 'Cuenta corriente', en: 'Ledger' },
    protected: true,
    status: {
      column: 'entry_type',
      values: LEDGER_ENTRY_TYPES.map((t) => ({ value: t.value, label: t.label })),
    },
    businessJoin: {
      paths: [{ parentTable: 'auth.users', localFk: 'client_user_id', parentPk: 'id' }],
    },
    // No roleRequired/ownership: ledger authorization is bespoke (assertLedgerWriteAllowed /
    // assertLedgerReadAllowed in appointment-authz.ts), not generic-CRUD-driven — a Professional
    // may bill their own clients, which the declarative role list cannot express. Declaring
    // inert metadata here would misstate who the backend actually permits.
  } satisfies TableStructure,
};

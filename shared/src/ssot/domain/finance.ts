import type { TableStructure } from '../../types/types';
import { pkColumn } from './business';

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
        foreignKey: { table: 'clients', valueField: 'user_id', labelField: 'display_name' },
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
          pattern: '^\\d+(\\.\\d{1,2})?$',
          patternMessage: 'must be a non-negative amount',
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

import type { TableStructure } from '../../types/types';
import { pkColumn } from './business';

// Two adjustment subtypes replace the single 'adjustment': debit increases debt,
// credit decreases it. Balance = SUM(charge + adjustment_debit) - SUM(payment + adjustment_credit).
export const LEDGER_ENTRY_TYPES = [
  { value: 'charge',             label: { es: 'Cargo',              en: 'Charge' } },
  { value: 'payment',            label: { es: 'Pago',               en: 'Payment' } },
  { value: 'adjustment_debit',   label: { es: 'Ajuste (débito)',    en: 'Adjustment (debit)' } },
  { value: 'adjustment_credit',  label: { es: 'Ajuste (crédito)',   en: 'Adjustment (credit)' } },
] as const;

export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number]['value'];

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
    title: { es: 'Cuenta Corriente', en: 'Ledger' },
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

import type { ColumnDef, ForeignKeyDef, TableStructure } from '../../types/types';

// Every business_id column resolves against businesses the same way, whatever its
// nullability/derivability at the declaring site.
export const businessForeignKey: ForeignKeyDef = { table: 'businesses', valueField: 'id', labelField: 'name' };

// filterable so a caller holding ids can ask for exactly those rows instead of paging the table
// looking for them. It narrows only: the scope predicates are ANDed in regardless, so an id the
// viewer may not read still comes back empty rather than confirming it exists.
export const pkColumn = {
  type: 'string',
  label: { es: 'ID', en: 'ID' },
  editable: false,
  filterable: true,
  sortable: true,
  derivable: { originTable: '', sqlGenerationStatement: 'id' },
} satisfies ColumnDef;

// business_id only on direct owners; derived elsewhere.
// editable: false — never expected in request body (server stamps from session).
// derivable — excluded from getNotDerivableFields so the businessScoped branch
//             in post.ts can append it cleanly without duplication.
export const businessIdColumn = {
  type: 'string',
  label: { es: 'Negocio', en: 'Business' },
  input: 'select',
  editable: false,
  derivable: { originTable: 'auth.users', sqlGenerationStatement: 'business_id' },
  validator: { required: true },
  filterable: true,
  sortable: false,
  foreignKey: businessForeignKey,
} satisfies ColumnDef;

export const AUDIT_OUTCOMES = [
  { value: 'success', label: { es: 'Éxito', en: 'Success' } },
  { value: 'failure', label: { es: 'Fallo', en: 'Failure' } },
  { value: 'denied', label: { es: 'Denegado', en: 'Denied' } },
] as const;

export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number]['value'];

// The SSOT set for validating an audit outcome filter value.
export const AUDIT_OUTCOME_VALUES = new Set<string>(AUDIT_OUTCOMES.map((o) => o.value));

export const businessTables = {
  // Admin-only configuration; never exposed through generic CRUD.
  businesses: {
    columns: {
      id: pkColumn,
      name: {
        type: 'string',
        label: { es: 'Nombre', en: 'Name' },
        validator: { required: true },
        filterable: true,
        sortable: true,
      },
      timezone: {
        type: 'string',
        label: { es: 'Zona horaria', en: 'Timezone' },
        validator: { required: true },
        filterable: false,
        sortable: false,
      },
      currency_code: {
        type: 'string',
        label: { es: 'Moneda', en: 'Currency' },
        validator: { required: true, pattern: '^ARS$', patternMessage: 'must be ARS', patternKey: 'currencyArsFormat' },
        filterable: false,
        sortable: false,
      },
      // Booking window: a client may request a turno from today+min up to today+max days.
      min_booking_days: {
        type: 'number',
        label: { es: 'Anticipación mínima (días)', en: 'Min booking days' },
        input: 'number',
        validator: { nullable: true, integer: true, minValue: 0 },
        filterable: false,
        sortable: false,
      },
      max_booking_days: {
        type: 'number',
        label: { es: 'Anticipación máxima (días)', en: 'Max booking days' },
        input: 'number',
        validator: { nullable: true, integer: true, minValue: 0 },
        filterable: false,
        sortable: false,
      },
    },
    pk: 'id',
    uiName: { es: 'Negocio', en: 'Business' },
    title: { es: 'Negocios', en: 'Businesses' },
    protected: true,
  } satisfies TableStructure,

  // Append-only audit log; business_id is the event scope.
  audit_events: {
    columns: {
      id: pkColumn,
      business_id: businessIdColumn,
      actor_user_id: {
        type: 'string',
        label: { es: 'Usuario', en: 'User' },
        input: 'select',
        validator: { nullable: true },
        filterable: true,
        sortable: false,
        foreignKey: { table: 'users', valueField: 'id', labelField: 'username' },
      },
      event_type: {
        type: 'string',
        label: { es: 'Evento', en: 'Event' },
        validator: { required: true },
        filterable: true,
        sortable: true,
      },
      entity_type: {
        type: 'string',
        label: { es: 'Entidad', en: 'Entity' },
        validator: { nullable: true },
        filterable: true,
        sortable: true,
      },
      entity_id: {
        type: 'string',
        label: { es: 'ID de entidad', en: 'Entity ID' },
        validator: { nullable: true },
        filterable: true,
        sortable: false,
      },
      outcome: {
        type: 'string',
        label: { es: 'Resultado', en: 'Outcome' },
        input: 'select',
        validator: { required: true },
        filterable: true,
        sortable: true,
        options: AUDIT_OUTCOMES.map((o) => ({ ...o })),
      },
    },
    pk: 'id',
    uiName: { es: 'Evento de auditoría', en: 'Audit Event' },
    title: { es: 'Auditoría', en: 'Audit Log' },
    businessScoped: true,
    protected: true,
    status: {
      column: 'outcome',
      values: AUDIT_OUTCOMES.map((o) => ({ ...o })),
    },
  } satisfies TableStructure,
};

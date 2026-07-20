import type { BusinessJoinDescriptor, TableStructure } from '../../types/types';
import { pkColumn, businessForeignKey } from './business';
import { receptionistGrantScope } from './people';
import { AMOUNT_PATTERN, AMOUNT_PATTERN_MESSAGE, AMOUNT_PATTERN_KEY } from './catalog';
import { HHMM_PATTERN, HHMM_PATTERN_MESSAGE, HHMM_PATTERN_KEY, WEEKDAY_OPTIONS } from './availability';
import { APPOINTMENT_STATES } from './appointment-lifecycle';

// Business is derived via whichever owner is set (professional XOR resource).
const dualOwnerBusinessJoin: BusinessJoinDescriptor = {
  paths: [
    { parentTable: 'auth.users', localFk: 'professional_user_id', parentPk: 'id' },
    { parentTable: 'resources',  localFk: 'resource_id',           parentPk: 'id' },
  ],
};

export const schedulingTables = {
  // One working block for exactly one owner (professional XOR resource, DB-enforced). Several
  // blocks per owner/weekday express morning+afternoon. business_id is derived via the owner.
  // A professional edits own blocks; a granted receptionist edits granted ones; admin all.
  schedule_blocks: {
    columns: {
      id: pkColumn,
      professional_user_id: {
        type: 'string',
        label: { es: 'Profesional', en: 'Professional' },
        input: 'select',
        validator: { nullable: true },
        filterable: true,
        sortable: false,
        foreignKey: { table: 'professionals', valueField: 'id', labelField: 'display_name' },
        referencesUserRole: 'Professional',
      },
      resource_id: {
        type: 'string',
        label: { es: 'Sala', en: 'Room' },
        input: 'select',
        validator: { nullable: true },
        filterable: true,
        sortable: false,
        foreignKey: { table: 'resources', valueField: 'id', labelField: 'name' },
      },
      weekday: {
        type: 'string',
        label: { es: 'Día', en: 'Weekday' },
        input: 'select',
        validator: { required: true },
        filterable: true,
        sortable: true,
        options: WEEKDAY_OPTIONS,
      },
      start_time: {
        type: 'string',
        label: { es: 'Hora inicio', en: 'Start Time' },
        validator: { required: true, pattern: HHMM_PATTERN, patternMessage: HHMM_PATTERN_MESSAGE, patternKey: HHMM_PATTERN_KEY },
        filterable: false,
        sortable: true,
      },
      end_time: {
        type: 'string',
        label: { es: 'Hora fin', en: 'End Time' },
        validator: { required: true, pattern: HHMM_PATTERN, patternMessage: HHMM_PATTERN_MESSAGE, patternKey: HHMM_PATTERN_KEY },
        filterable: false,
        sortable: false,
      },
    },
    pk: 'id',
    uiName: { es: 'Bloque de horario', en: 'Schedule Block' },
    title: { es: 'Bloques de horario', en: 'Schedule Blocks' },
    addButtonLabel: { es: 'Agregar bloque', en: 'Add Block' },
    crud: { create: true, read: true, update: true, delete: true },
    businessJoin: dualOwnerBusinessJoin,
    ownership: { ownerColumn: 'professional_user_id', role: 'Professional' },
    grantScope: receptionistGrantScope,
    roleRequired: {
      create: ['Admin', 'Professional', 'Receptionist'],
      read:   ['Admin', 'Professional', 'Receptionist'],
      update: ['Admin', 'Professional', 'Receptionist'],
      delete: ['Admin', 'Professional', 'Receptionist'],
    },
  } satisfies TableStructure,

  // Which services a professional block offers, with optional per-block duration/price overrides
  // (null → service default). Only professional blocks have these (resource blocks are bare
  // windows). professional_user_id is denormalized from the block so the row scopes exactly like
  // schedule_blocks (business via the owner, own-only, grant-aware); it must equal the block owner.
  schedule_block_services: {
    columns: {
      id: pkColumn,
      professional_user_id: {
        type: 'string',
        label: { es: 'Profesional', en: 'Professional' },
        input: 'select',
        validator: { required: true },
        filterable: true,
        sortable: false,
        foreignKey: { table: 'professionals', valueField: 'id', labelField: 'display_name' },
        referencesUserRole: 'Professional',
      },
      schedule_block_id: {
        type: 'string',
        label: { es: 'Bloque', en: 'Block' },
        input: 'select',
        validator: { required: true },
        filterable: true,
        sortable: false,
        foreignKey: { table: 'schedule_blocks', valueField: 'id', labelField: 'id' },
      },
      service_id: {
        type: 'string',
        label: { es: 'Servicio', en: 'Service' },
        input: 'select',
        validator: { required: true },
        filterable: true,
        sortable: false,
        foreignKey: { table: 'services', valueField: 'id', labelField: 'name' },
      },
      duration_minutes: {
        type: 'number',
        label: { es: 'Duración (min)', en: 'Duration (min)' },
        input: 'number',
        validator: { nullable: true, integer: true, minValue: 1 },
        filterable: false,
        sortable: false,
      },
      price_ars: {
        type: 'string',
        label: { es: 'Precio (ARS)', en: 'Price (ARS)' },
        validator: { nullable: true, pattern: AMOUNT_PATTERN, patternMessage: AMOUNT_PATTERN_MESSAGE, patternKey: AMOUNT_PATTERN_KEY },
        filterable: false,
        sortable: true,
      },
    },
    pk: 'id',
    uiName: { es: 'Servicio del bloque', en: 'Block Service' },
    title: { es: 'Servicios del bloque', en: 'Block Services' },
    addButtonLabel: { es: 'Agregar servicio', en: 'Add Service' },
    crud: { create: true, read: true, update: true, delete: true },
    businessJoin: {
      paths: [{ parentTable: 'auth.users', localFk: 'professional_user_id', parentPk: 'id' }],
    },
    ownership: { ownerColumn: 'professional_user_id', role: 'Professional' },
    grantScope: receptionistGrantScope,
    roleRequired: {
      create: ['Admin', 'Professional', 'Receptionist'],
      read:   ['Admin', 'Professional', 'Receptionist'],
      update: ['Admin', 'Professional', 'Receptionist'],
      delete: ['Admin', 'Professional', 'Receptionist'],
    },
  } satisfies TableStructure,

  schedule_exceptions: {
    columns: {
      id: pkColumn,
      professional_user_id: {
        type: 'string',
        label: { es: 'Profesional', en: 'Professional' },
        input: 'select',
        validator: { nullable: true },
        filterable: true,
        sortable: false,
        foreignKey: { table: 'professionals', valueField: 'id', labelField: 'display_name' },
        referencesUserRole: 'Professional',
      },
      resource_id: {
        type: 'string',
        label: { es: 'Sala', en: 'Room' },
        input: 'select',
        validator: { nullable: true },
        filterable: true,
        sortable: false,
        foreignKey: { table: 'resources', valueField: 'id', labelField: 'name' },
      },
      // The third owner: a business-wide closure. Set only when both owners are null, stamped
      // server-side by the closures endpoint — never accepted from a request body (editable: false),
      // so the generic write path leaves it null and a per-owner row keeps deriving business via its
      // owner. Exactly one of professional_user_id / resource_id / business_id is non-null (DB CHECK).
      business_id: {
        type: 'string',
        label: { es: 'Negocio', en: 'Business' },
        editable: false,
        validator: { nullable: true },
        filterable: true,
        sortable: false,
        foreignKey: businessForeignKey,
      },
      exception_date: {
        type: 'string',
        label: { es: 'Fecha', en: 'Date' },
        input: 'date',
        validator: { required: true },
        filterable: true,
        sortable: true,
      },
      is_unavailable: {
        type: 'boolean',
        label: { es: 'No disponible', en: 'Unavailable' },
        validator: { nullable: true },
        filterable: true,
        sortable: false,
      },
      start_time: {
        type: 'string',
        label: { es: 'Hora inicio', en: 'Start Time' },
        validator: { nullable: true, pattern: HHMM_PATTERN, patternMessage: HHMM_PATTERN_MESSAGE, patternKey: HHMM_PATTERN_KEY },
        filterable: false,
        sortable: false,
      },
      end_time: {
        type: 'string',
        label: { es: 'Hora fin', en: 'End Time' },
        validator: { nullable: true, pattern: HHMM_PATTERN, patternMessage: HHMM_PATTERN_MESSAGE, patternKey: HHMM_PATTERN_KEY },
        filterable: false,
        sortable: false,
      },
      // Required only for a changed-hours "available" exception; null for full-day/blocked (DB CHECK).
      granularity_minutes: {
        type: 'number',
        label: { es: 'Intervalo (min)', en: 'Interval (min)' },
        input: 'number',
        validator: { nullable: true, integer: true, minValue: 1 },
        filterable: false,
        sortable: false,
      },
      reason: {
        type: 'string',
        label: { es: 'Motivo', en: 'Reason' },
        input: 'textarea',
        validator: { nullable: true },
        filterable: false,
        sortable: false,
      },
    },
    pk: 'id',
    uiName: { es: 'Licencia', en: 'Time off' },
    title: { es: 'Licencias', en: 'Time off' },
    addButtonLabel: { es: 'Agregar licencia', en: 'Add time off' },
    crud: { create: true, read: true, update: true, delete: true },
    businessJoin: dualOwnerBusinessJoin,
    roleRequired: {
      create: ['Admin', 'Professional', 'Receptionist'],
      read:   ['Admin', 'Professional', 'Receptionist', 'Client'],
      update: ['Admin', 'Professional', 'Receptionist'],
      delete: ['Admin', 'Professional', 'Receptionist'],
    },
  } satisfies TableStructure,

  // The appointment lifecycle is workflow-owned. ends_at is trigger-maintained and price is
  // captured at booking. business_id is derived.
  appointments: {
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
      professional_user_id: {
        type: 'string',
        label: { es: 'Profesional', en: 'Professional' },
        input: 'select',
        validator: { required: true },
        filterable: true,
        sortable: false,
        foreignKey: { table: 'professionals', valueField: 'id', labelField: 'display_name' },
      },
      resource_id: {
        type: 'string',
        label: { es: 'Sala', en: 'Room' },
        input: 'select',
        validator: { nullable: true },
        filterable: true,
        sortable: false,
        foreignKey: { table: 'resources', valueField: 'id', labelField: 'name' },
      },
      service_id: {
        type: 'string',
        label: { es: 'Servicio', en: 'Service' },
        input: 'select',
        validator: { required: true },
        filterable: true,
        sortable: false,
        foreignKey: { table: 'services', valueField: 'id', labelField: 'name' },
      },
      starts_at: {
        type: 'date',
        label: { es: 'Inicio', en: 'Start' },
        input: 'date',
        validator: { required: true },
        filterable: true,
        sortable: true,
      },
      duration_minutes: {
        type: 'number',
        label: { es: 'Duración (min)', en: 'Duration (min)' },
        input: 'number',
        validator: { required: true, integer: true, minValue: 1 },
        filterable: false,
        sortable: false,
      },
      ends_at: {
        type: 'date',
        label: { es: 'Fin', en: 'End' },
        editable: false,
        filterable: false,
        sortable: true,
      },
      state: {
        type: 'string',
        label: { es: 'Estado', en: 'State' },
        input: 'select',
        validator: { required: true },
        filterable: true,
        sortable: true,
        options: APPOINTMENT_STATES.map((s) => ({ value: s.value, label: s.label })),
      },
      name: {
        type: 'string',
        label: { es: 'Título', en: 'Title' },
        validator: { nullable: true },
        filterable: true,
        sortable: false,
      },
      description: {
        type: 'string',
        label: { es: 'Descripción', en: 'Description' },
        input: 'textarea',
        validator: { nullable: true },
        filterable: false,
        sortable: false,
      },
      price: {
        type: 'string',
        label: { es: 'Precio (ARS)', en: 'Price (ARS)' },
        validator: {
          required: true,
          pattern: AMOUNT_PATTERN,
          patternMessage: AMOUNT_PATTERN_MESSAGE,
          patternKey: AMOUNT_PATTERN_KEY,
        },
        filterable: false,
        sortable: true,
      },
      override_conflict: {
        type: 'boolean',
        label: { es: 'Conflicto forzado', en: 'Conflict Override' },
        filterable: true,
        sortable: false,
      },
      override_actor_id: {
        type: 'string',
        label: { es: 'Autorizó', en: 'Overridden By' },
        input: 'select',
        validator: { nullable: true },
        filterable: false,
        sortable: false,
        foreignKey: { table: 'users', valueField: 'id', labelField: 'username' },
      },
      // Staff-only memo field. Writable in any state; once terminal it is the only editable field.
      staff_note: {
        type: 'string',
        label: { es: 'Nota de staff', en: 'Staff Note' },
        input: 'textarea',
        validator: { nullable: true },
        filterable: false,
        sortable: false,
      },
      // NULL for a standalone turno. Set by materialize-on-touch when a recurring occurrence is
      // first acted on; the row then wins over its virtual twin.
      series_id: {
        type: 'string',
        label: { es: 'Serie', en: 'Series' },
        editable: false,
        validator: { nullable: true },
        filterable: true,
        sortable: false,
        foreignKey: { table: 'appointment_series', valueField: 'id', labelField: 'id' },
      },
      // The on-pattern date a materialized row stands for; NULL for standalone turnos. Stays the
      // pattern anchor even after a single-occurrence move, so it keeps de-duping its virtual twin.
      occurrence_date: {
        type: 'string',
        label: { es: 'Fecha de ocurrencia', en: 'Occurrence Date' },
        input: 'date',
        editable: false,
        validator: { nullable: true },
        filterable: true,
        sortable: false,
      },
    },
    pk: 'id',
    uiName: { es: 'Turno', en: 'Appointment' },
    title: { es: 'Turnos', en: 'Appointments' },
    protected: true,
    status: {
      column: 'state',
      values: APPOINTMENT_STATES.map((s) => ({ value: s.value, label: s.label })),
    },
  } satisfies TableStructure,

  // A professional sharing calendar access with another user. Managed through explicit
  // grant endpoints; not exposed through generic CRUD.
  calendar_grants: {
    columns: {
      id: pkColumn,
      professional_user_id: {
        type: 'string',
        label: { es: 'Profesional', en: 'Professional' },
        input: 'select',
        validator: { required: true },
        filterable: true,
        sortable: false,
        foreignKey: { table: 'professionals', valueField: 'id', labelField: 'display_name' },
      },
      grantee_user_id: {
        type: 'string',
        label: { es: 'Usuario autorizado', en: 'Grantee' },
        input: 'select',
        validator: { required: true },
        filterable: true,
        sortable: false,
        foreignKey: { table: 'users', valueField: 'id', labelField: 'username' },
      },
    },
    pk: 'id',
    uiName: { es: 'Permiso de calendario', en: 'Calendar Grant' },
    title: { es: 'Permisos de calendario', en: 'Calendar Grants' },
    protected: true,
    businessJoin: {
      paths: [{ parentTable: 'auth.users', localFk: 'professional_user_id', parentPk: 'id' }],
    },
  } satisfies TableStructure,
};

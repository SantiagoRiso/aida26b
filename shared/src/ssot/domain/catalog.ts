import type { TableStructure } from '../../types/types';
import { pkColumn, businessIdColumn } from './business';
import { softDelete } from './people';

// Shared by every decimal money column (services, block/client price overrides, appointments,
// ledger) so the "up to 2 decimals, non-negative" rule can't drift between them.
export const AMOUNT_PATTERN = '^\\d+(\\.\\d{1,2})?$';
export const AMOUNT_PATTERN_MESSAGE = 'must be a non-negative amount';
export const AMOUNT_PATTERN_KEY = 'amountFormat';

const priceColumn = {
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
} as const;

export const catalogTables = {
  services: {
    columns: {
      id: pkColumn,
      business_id: businessIdColumn,
      name: {
        type: 'string',
        label: { es: 'Nombre', en: 'Name' },
        validator: { required: true },
        filterable: true,
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
      default_duration_minutes: {
        type: 'number',
        label: { es: 'Duración (min)', en: 'Duration (min)' },
        input: 'number',
        validator: { required: true, integer: true, minValue: 1 },
        filterable: true,
        sortable: true,
      },
      default_price_ars: priceColumn,
    },
    pk: 'id',
    uiName: { es: 'Servicio', en: 'Service' },
    title: { es: 'Servicios', en: 'Services' },
    addButtonLabel: { es: 'Agregar servicio', en: 'Add Service' },
    businessScoped: true,
    crud: { create: true, read: true, update: true, delete: true },
    softDelete,
    roleRequired: {
      create: ['Admin'],
      read:   ['Admin', 'Receptionist', 'Professional', 'Client'],
      update: ['Admin'],
      delete: ['Admin'],
    },
  } satisfies TableStructure,

  // Per-client price override for a professional's service. business_id is derived via client.
  // No soft-delete columns and no DELETE grant, so generic delete is withheld.
  client_professional_services: {
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
        referencesUserRole: 'Client',
      },
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
      service_id: {
        type: 'string',
        label: { es: 'Servicio', en: 'Service' },
        input: 'select',
        validator: { required: true },
        filterable: true,
        sortable: false,
        foreignKey: { table: 'services', valueField: 'id', labelField: 'name' },
      },
      price_ars: priceColumn,
    },
    pk: 'id',
    uiName: { es: 'Precio por cliente', en: 'Client Price' },
    title: { es: 'Precios por cliente', en: 'Client Prices' },
    addButtonLabel: { es: 'Agregar precio', en: 'Add Price' },
    crud: { create: true, read: true, update: true, delete: false },
    businessJoin: {
      paths: [{ parentTable: 'auth.users', localFk: 'client_user_id', parentPk: 'id' }],
    },
    roleRequired: {
      create: ['Admin', 'Receptionist'],
      read:   ['Admin', 'Receptionist', 'Professional', 'Client'],
      update: ['Admin', 'Receptionist'],
      delete: [],
    },
  } satisfies TableStructure,

  // Which services a professional offers. A pure link table; business derived via the professional.
  // Update is scoped to the per-service booking-window override only (the FK pair is readonlyOnEdit:
  // set at create, frozen after); reassigning owner/service is still remove + add, not an update.
  professional_services: {
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
        readonlyOnEdit: true,
      },
      service_id: {
        type: 'string',
        label: { es: 'Servicio', en: 'Service' },
        input: 'select',
        validator: { required: true },
        filterable: true,
        sortable: false,
        foreignKey: { table: 'services', valueField: 'id', labelField: 'name' },
        readonlyOnEdit: true,
      },
      // Per-service booking-window override; null → falls back to the business window.
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
    uiName: { es: 'Servicio del profesional', en: 'Professional Service' },
    title: { es: 'Servicios del profesional', en: 'Professional Services' },
    addButtonLabel: { es: 'Agregar servicio', en: 'Add Service' },
    crud: { create: true, read: true, update: true, delete: true },
    businessJoin: {
      paths: [{ parentTable: 'auth.users', localFk: 'professional_user_id', parentPk: 'id' }],
    },
    roleRequired: {
      create: ['Admin'],
      read:   ['Admin', 'Receptionist', 'Professional', 'Client'],
      update: ['Admin', 'Professional', 'Receptionist'],
      delete: ['Admin'],
    },
    // Update is the scoped per-service booking-window edit: Admin any in-business, a Professional
    // their own, a granted Receptionist within their grant. create/delete stay Admin-only.
    professionalOwnerGuard: { ops: ['update'] },
  } satisfies TableStructure,
};

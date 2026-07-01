import type { SoftDeletePolicy, TableStructure } from '../../types/types';
import { pkColumn, businessIdColumn } from './business';

const softDelete: SoftDeletePolicy = {
  deletedAtColumn: 'deleted_at',
  deletedByColumn: 'deleted_by_user_id',
};

const priceColumn = {
  type: 'string',
  label: { es: 'Precio (ARS)', en: 'Price (ARS)' },
  validator: {
    required: true,
    pattern: '^\\d+(\\.\\d{1,2})?$',
    patternMessage: 'must be a non-negative amount',
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
    addButtonLabel: { es: 'Agregar Servicio', en: 'Add Service' },
    businessScoped: true,
    crud: { create: true, read: true, update: true, delete: true },
    softDelete,
    roleRequired: {
      create: ['Admin', 'Receptionist'],
      read:   ['Admin', 'Receptionist', 'Professional', 'Client'],
      update: ['Admin', 'Receptionist'],
      delete: ['Admin', 'Receptionist'],
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
        foreignKey: { table: 'clients', valueField: 'user_id', labelField: 'display_name' },
        referencesUserRole: 'Client',
      },
      professional_user_id: {
        type: 'string',
        label: { es: 'Profesional', en: 'Professional' },
        input: 'select',
        validator: { required: true },
        filterable: true,
        sortable: false,
        foreignKey: { table: 'professionals', valueField: 'user_id', labelField: 'display_name' },
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
    uiName: { es: 'Precio por Cliente', en: 'Client Price' },
    title: { es: 'Precios por Cliente', en: 'Client Prices' },
    addButtonLabel: { es: 'Agregar Precio', en: 'Add Price' },
    crud: { create: true, read: true, update: true, delete: false },
    // Business is derived via the client's auth.users record.
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
};

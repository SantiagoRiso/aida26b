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
  // No update (change = remove + add), so generic update is withheld.
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
    },
    pk: 'id',
    uiName: { es: 'Servicio del Profesional', en: 'Professional Service' },
    title: { es: 'Servicios del Profesional', en: 'Professional Services' },
    addButtonLabel: { es: 'Agregar Servicio', en: 'Add Service' },
    crud: { create: true, read: true, update: false, delete: true },
    businessJoin: {
      paths: [{ parentTable: 'auth.users', localFk: 'professional_user_id', parentPk: 'id' }],
    },
    roleRequired: {
      create: ['Admin'],
      read:   ['Admin', 'Receptionist', 'Professional', 'Client'],
      update: [],
      delete: ['Admin'],
    },
  } satisfies TableStructure,
};

// Resolves the booking's captured price and duration. Price = per-client override else the
// service default. Duration = the staff-provided sobreturno duration when set, else the chosen
// slot's granularity. The dry-run and the save call this so preview never drifts from
// the saved value. Prices stay decimal strings matching priceColumn's '^\d+(\.\d{1,2})?$'.
export function resolveBooking(input: {
  serviceDefaultPriceArs: string;
  clientOverridePriceArs?: string | null;
  slotGranularityMinutes?: number | null;
  sobreturnoDurationMinutes?: number | null;
}): { effective_price: string; effective_duration_minutes: number } {
  const override = input.clientOverridePriceArs;
  const effective_price =
    override !== null && override !== undefined && override !== '' ? override : input.serviceDefaultPriceArs;

  const sobreturno = input.sobreturnoDurationMinutes;
  const slot = input.slotGranularityMinutes;
  let effective_duration_minutes: number;
  if (typeof sobreturno === 'number' && Number.isInteger(sobreturno) && sobreturno > 0) {
    effective_duration_minutes = sobreturno;
  } else if (typeof slot === 'number' && Number.isInteger(slot) && slot > 0) {
    effective_duration_minutes = slot;
  } else {
    throw new Error(
      'resolveBooking requires a duration source: slotGranularityMinutes or sobreturnoDurationMinutes',
    );
  }

  return { effective_price, effective_duration_minutes };
}

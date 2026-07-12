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
  // Update is scoped to the per-service booking-window override only (FKs are editable:false);
  // reassigning owner/service is still remove + add, not an update.
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
        editable: false,
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
        editable: false,
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
    uiName: { es: 'Servicio del Profesional', en: 'Professional Service' },
    title: { es: 'Servicios del Profesional', en: 'Professional Services' },
    addButtonLabel: { es: 'Agregar Servicio', en: 'Add Service' },
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

// Resolves the booking's captured price and duration.
//   Price    = client override > per-block/service override > service default.
//   Duration = staff sobreturno > per-block/service override > service default > (legacy) slot.
// The dry-run and the save call this so preview never drifts from the saved value. Prices stay
// decimal strings matching priceColumn's '^\d+(\.\d{1,2})?$'. slotGranularityMinutes is a legacy
// fallback for pre-block callers and is retained until every caller supplies a service default.
export function resolveBooking(input: {
  serviceDefaultPriceArs: string;
  serviceDefaultDurationMinutes?: number | null;
  clientOverridePriceArs?: string | null;
  blockServicePriceArs?: string | null;
  blockServiceDurationMinutes?: number | null;
  slotGranularityMinutes?: number | null;
  sobreturnoDurationMinutes?: number | null;
}): { effective_price: string; effective_duration_minutes: number } {
  const price = (v?: string | null): string | undefined =>
    v !== null && v !== undefined && v !== '' ? v : undefined;
  const effective_price =
    price(input.clientOverridePriceArs) ??
    price(input.blockServicePriceArs) ??
    input.serviceDefaultPriceArs;

  const dur = (v?: number | null): number | undefined =>
    typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
  const effective_duration_minutes =
    dur(input.sobreturnoDurationMinutes) ??
    dur(input.blockServiceDurationMinutes) ??
    dur(input.serviceDefaultDurationMinutes) ??
    dur(input.slotGranularityMinutes);
  if (effective_duration_minutes === undefined) {
    throw new Error(
      'resolveBooking requires a duration source: service default, block override, slot, or sobreturno',
    );
  }

  return { effective_price, effective_duration_minutes };
}

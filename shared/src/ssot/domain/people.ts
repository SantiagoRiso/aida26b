import type { SoftDeletePolicy, SchedulableCapability, TableStructure } from '../../types/types';
import { pkColumn, businessIdColumn } from './business';

// Column allow-list for client/professional views of auth.users.
// password_hash, password_salt, and username are deliberately excluded from the exposed set.
// username stays out of the generic layer because it is auth-sensitive (login identity).
const authUsersAllowedColumns = [
  'id', 'business_id', 'role', 'display_name', 'email', 'phone', 'bio', 'notes',
  'is_active', 'must_change_password', 'deleted_at', 'deleted_by_user_id',
  'created_at', 'updated_at',
] as const;

const softDelete: SoftDeletePolicy = {
  deletedAtColumn: 'deleted_at',
  deletedByColumn: 'deleted_by_user_id',
};

const professionalSchedulable: SchedulableCapability = {
  calendarLabel: { es: 'Profesional', en: 'Professional' },
  identityField: 'id',
  displayField: 'display_name',
  ownerForeignKey: 'professional_user_id',
  availability: { weeklySource: 'schedules', exceptionSource: 'schedule_exceptions' },
  conflict: { overridable: true },
  rules: { availability: 'computeDailyAvailability', conflict: 'detectOverlap' },
};

const resourceSchedulable: SchedulableCapability = {
  calendarLabel: { es: 'Recurso', en: 'Resource' },
  identityField: 'id',
  displayField: 'name',
  ownerForeignKey: 'resource_id',
  availability: { weeklySource: 'schedules', exceptionSource: 'schedule_exceptions' },
  conflict: { overridable: true },
  rules: { availability: 'computeDailyAvailability', conflict: 'detectOverlap' },
};

export const peopleTables = {
  // Users are managed through auth/admin endpoints, never generic CRUD.
  // Secrets are deliberately absent from the SSOT.
  users: {
    columns: {
      id: pkColumn,
      business_id: {
        type: 'string',
        label: { es: 'Negocio', en: 'Business' },
        input: 'select',
        validator: { nullable: true },
        filterable: true,
        sortable: false,
        foreignKey: { table: 'businesses', valueField: 'id', labelField: 'name' },
      },
      username: {
        type: 'string',
        label: { es: 'Usuario', en: 'Username' },
        validator: { required: true, maxLength: 80 },
        filterable: true,
        sortable: true,
      },
      email: {
        type: 'string',
        label: { es: 'Email', en: 'Email' },
        input: 'email',
        validator: {
          required: true,
          pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
          patternMessage: 'must be a valid email address',
        },
        filterable: true,
        sortable: true,
      },
      role: {
        type: 'string',
        label: { es: 'Rol', en: 'Role' },
        input: 'select',
        validator: { required: true },
        filterable: true,
        sortable: true,
        options: [
          { value: 'Admin', label: { es: 'Admin', en: 'Admin' } },
          { value: 'Professional', label: { es: 'Profesional', en: 'Professional' } },
          { value: 'Receptionist', label: { es: 'Recepcionista', en: 'Receptionist' } },
          { value: 'Client', label: { es: 'Cliente', en: 'Client' } },
        ],
      },
      is_active: {
        type: 'boolean',
        label: { es: 'Activo', en: 'Active' },
        filterable: true,
        sortable: false,
      },
      must_change_password: {
        type: 'boolean',
        label: { es: 'Debe Cambiar Contraseña', en: 'Must Change Password' },
        filterable: false,
        sortable: false,
      },
    },
    pk: 'id',
    uiName: { es: 'Usuario', en: 'User' },
    title: { es: 'Usuarios', en: 'Users' },
    businessScoped: true,
    protected: true,
    softDelete,
  } satisfies TableStructure,

  // Session lifecycle is owned by auth; the token is secret and absent here.
  sessions: {
    columns: {
      id: pkColumn,
      user_id: {
        type: 'string',
        label: { es: 'Usuario', en: 'User' },
        input: 'select',
        validator: { required: true },
        filterable: true,
        sortable: false,
        foreignKey: { table: 'users', valueField: 'id', labelField: 'username' },
      },
      expires_at: {
        type: 'date',
        label: { es: 'Expira', en: 'Expires' },
        input: 'date',
        filterable: true,
        sortable: true,
      },
    },
    pk: 'id',
    uiName: { es: 'Sesión', en: 'Session' },
    title: { es: 'Sesiones', en: 'Sessions' },
    protected: true,
  } satisfies TableStructure,

  // Logical entity backed by auth.users WHERE role='Client'.
  // No separate table exists; sqlTable + roleDiscriminator redirect all generic SQL to auth.users.
  // Create is disabled — clients are created only via POST /api/admin/users.
  // Update is limited to profile fields (display_name, phone, notes); see updateAllowedColumns.
  clients: {
    columns: {
      id: pkColumn,
      display_name: {
        type: 'string',
        label: { es: 'Nombre', en: 'Name' },
        validator: { required: true },
        filterable: true,
        sortable: true,
      },
      email: {
        type: 'string',
        label: { es: 'Email', en: 'Email' },
        input: 'email',
        validator: {
          nullable: true,
          pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
          patternMessage: 'must be a valid email address',
        },
        filterable: true,
        sortable: true,
        // email (login identity) is readable but not updatable through generic PUT
        editable: false,
      },
      phone: {
        type: 'string',
        label: { es: 'Teléfono', en: 'Phone' },
        validator: { nullable: true },
        filterable: true,
        sortable: false,
      },
      notes: {
        type: 'string',
        label: { es: 'Notas', en: 'Notes' },
        input: 'textarea',
        validator: { nullable: true },
        filterable: false,
        sortable: false,
      },
    },
    pk: 'id',
    uiName: { es: 'Cliente', en: 'Client' },
    title: { es: 'Clientes', en: 'Clients' },
    addButtonLabel: { es: 'Agregar Cliente', en: 'Add Client' },
    // Physical table is auth.users; role discriminator limits reads/writes to Client rows.
    sqlTable: 'auth.users',
    roleDiscriminator: { column: 'role', value: 'Client' },
    // Business is on auth.users directly; the discriminated table carries business_id.
    businessScoped: true,
    // create: false — creation via POST /api/admin/users only.
    crud: { create: false, read: true, update: true, delete: true },
    softDelete,
    roleRequired: {
      create: [],
      read:   ['Admin', 'Receptionist', 'Professional', 'Client'],
      update: ['Admin', 'Receptionist', 'Client'],
      delete: ['Admin'],
    },
    ownership: { ownerColumn: 'id' },
  } satisfies TableStructure,

  // Logical entity backed by auth.users WHERE role='Professional'.
  // No separate table exists; sqlTable + roleDiscriminator redirect all generic SQL to auth.users.
  // Create is disabled — professionals are created only via POST /api/admin/users.
  // Update is limited to profile fields (display_name, bio); see updateAllowedColumns.
  professionals: {
    columns: {
      id: pkColumn,
      display_name: {
        type: 'string',
        label: { es: 'Nombre', en: 'Name' },
        validator: { required: true },
        filterable: true,
        sortable: true,
      },
      bio: {
        type: 'string',
        label: { es: 'Biografía', en: 'Bio' },
        input: 'textarea',
        validator: { nullable: true },
        filterable: false,
        sortable: false,
      },
    },
    pk: 'id',
    uiName: { es: 'Profesional', en: 'Professional' },
    title: { es: 'Profesionales', en: 'Professionals' },
    addButtonLabel: { es: 'Agregar Profesional', en: 'Add Professional' },
    // Physical table is auth.users; role discriminator limits reads/writes to Professional rows.
    sqlTable: 'auth.users',
    roleDiscriminator: { column: 'role', value: 'Professional' },
    // Business is on auth.users directly; the discriminated table carries business_id.
    businessScoped: true,
    // create: false — creation via POST /api/admin/users only.
    crud: { create: false, read: true, update: true, delete: true },
    softDelete,
    schedulable: professionalSchedulable,
    roleRequired: {
      create: [],
      read:   ['Admin', 'Receptionist', 'Professional', 'Client'],
      update: ['Admin', 'Receptionist', 'Professional'],
      delete: ['Admin'],
    },
    ownership: { ownerColumn: 'id' },
  } satisfies TableStructure,

  resources: {
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
    },
    pk: 'id',
    uiName: { es: 'Recurso', en: 'Resource' },
    title: { es: 'Recursos', en: 'Resources' },
    addButtonLabel: { es: 'Agregar Recurso', en: 'Add Resource' },
    businessScoped: true,
    crud: { create: true, read: true, update: true, delete: true },
    softDelete,
    schedulable: resourceSchedulable,
    roleRequired: {
      create: ['Admin', 'Receptionist'],
      read:   ['Admin', 'Receptionist', 'Professional', 'Client'],
      update: ['Admin', 'Receptionist'],
      delete: ['Admin', 'Receptionist'],
    },
  } satisfies TableStructure,
};

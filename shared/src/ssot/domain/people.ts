import type { SoftDeletePolicy, SchedulableCapability, TableStructure } from '../../types/types';
import { pkColumn, businessIdColumn } from './business';

const softDelete: SoftDeletePolicy = {
  deletedAtColumn: 'deleted_at',
  deletedByColumn: 'deleted_by_user_id',
};

const professionalSchedulable: SchedulableCapability = {
  calendarLabel: { es: 'Profesional', en: 'Professional' },
  identityField: 'id',
  displayField: 'display_name',
  ownerForeignKey: 'professional_id',
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

  clients: {
    columns: {
      id: pkColumn,
      business_id: businessIdColumn,
      user_id: {
        type: 'string',
        label: { es: 'Usuario', en: 'User' },
        input: 'select',
        validator: { required: true },
        filterable: true,
        sortable: false,
        foreignKey: { table: 'users', valueField: 'id', labelField: 'username' },
      },
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
    businessScoped: true,
    crud: { create: true, read: true, update: true, delete: true },
    softDelete,
  } satisfies TableStructure,

  professionals: {
    columns: {
      id: pkColumn,
      business_id: businessIdColumn,
      user_id: {
        type: 'string',
        label: { es: 'Usuario', en: 'User' },
        input: 'select',
        validator: { nullable: true },
        filterable: true,
        sortable: false,
        foreignKey: { table: 'users', valueField: 'id', labelField: 'username' },
      },
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
    businessScoped: true,
    crud: { create: true, read: true, update: true, delete: true },
    softDelete,
    schedulable: professionalSchedulable,
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
  } satisfies TableStructure,
};

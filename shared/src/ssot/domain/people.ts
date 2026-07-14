import type { GrantScopeDescriptor, SoftDeletePolicy, SchedulableCapability, TableStructure, LocalizedText } from '../../types/types';
import { ROLES, type Role } from '../../types/roles';
import { pkColumn, businessIdColumn, businessForeignKey } from './business';

export const softDelete: SoftDeletePolicy = {
  deletedAtColumn: 'deleted_at',
  deletedByColumn: 'deleted_by_user_id',
};

// A receptionist's world is the calendars they were granted, reads and writes alike — the same
// relationship on every table it scopes. db/grants.ts owns the SQL side of this shape.
export const receptionistGrantScope: GrantScopeDescriptor = {
  role: 'Receptionist',
  grantTable: 'calendar_grants',
  grantRowColumn: 'professional_user_id',
  granteeColumn: 'grantee_user_id',
};

// Same shape everywhere a user-facing email column appears (users.email, clients.email).
export const EMAIL_PATTERN = '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$';
export const EMAIL_PATTERN_MESSAGE = 'must be a valid email address';

// Role choices for the users.role column and any UI role picker. The set comes from the single
// ROLES source; Record<Role,…> forces a label for every role, so adding one is an edit in
// roles.ts plus its label here (nowhere else).
export const ROLE_LABELS: Record<Role, LocalizedText> = {
  Admin: { es: 'Administrador', en: 'Admin' },
  Professional: { es: 'Profesional', en: 'Professional' },
  Receptionist: { es: 'Recepcionista', en: 'Receptionist' },
  Client: { es: 'Cliente', en: 'Client' },
};
export const ROLE_OPTIONS = ROLES.map((value) => ({ value, label: ROLE_LABELS[value] }));

const professionalSchedulable: SchedulableCapability = {
  calendarLabel: { es: 'Profesional', en: 'Professional' },
  identityField: 'id',
  displayField: 'display_name',
  ownerForeignKey: 'professional_user_id',
  availability: { weeklySource: 'schedule_blocks', exceptionSource: 'schedule_exceptions' },
  conflict: { overridable: true },
  rules: { availability: 'computeServiceSlots', conflict: 'detectOverlap' },
};

const resourceSchedulable: SchedulableCapability = {
  calendarLabel: { es: 'Sala', en: 'Room' },
  identityField: 'id',
  displayField: 'name',
  ownerForeignKey: 'resource_id',
  availability: { weeklySource: 'schedule_blocks', exceptionSource: 'schedule_exceptions' },
  conflict: { overridable: true },
  rules: { availability: 'computeServiceSlots', conflict: 'detectOverlap' },
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
        foreignKey: businessForeignKey,
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
          pattern: EMAIL_PATTERN,
          patternMessage: EMAIL_PATTERN_MESSAGE,
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
        options: ROLE_OPTIONS.map((o) => ({ ...o })),
      },
      is_active: {
        type: 'boolean',
        label: { es: 'Activo', en: 'Active' },
        filterable: true,
        sortable: false,
      },
      must_change_password: {
        type: 'boolean',
        label: { es: 'Debe cambiar contraseña', en: 'Must Change Password' },
        filterable: false,
        sortable: false,
      },
    },
    pk: 'id',
    uiName: { es: 'Usuario', en: 'User' },
    title: { es: 'Usuarios', en: 'Users' },
    businessScoped: true,
    // Stays protected (no generic writes — creation/deactivation/reset go through the
    // dedicated /api/admin/users routes) but carves out a read-only exception so the
    // admin Usuarios screen can list accounts through generic GET.
    protected: true,
    crud: { create: false, read: true, update: false, delete: false },
    roleRequired: { read: ['Admin'] },
    // Reads go through a view, never the raw table — the generic SELECT is a literal
    // "SELECT *" and auth.users carries password_hash/password_salt.
    sqlTable: 'auth.users_directory',
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
  // Reads go through auth.users_directory (secret-free view) so a generic SELECT never projects
  // password columns; writes still hit auth.users via sqlTable.
  // Create is disabled — clients are created only via POST /api/admin/users.
  // Update is limited to profile fields (display_name, phone, dni, notes); email is read-only.
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
          pattern: EMAIL_PATTERN,
          patternMessage: EMAIL_PATTERN_MESSAGE,
        },
        filterable: true,
        sortable: true,
        // email (login identity) is readable but not updatable through generic PUT
        editable: false,
      },
      dni: {
        type: 'string',
        label: { es: 'DNI', en: 'DNI' },
        validator: { nullable: true },
        filterable: true,
        sortable: true,
      },
      username: {
        type: 'string',
        label: { es: 'Usuario', en: 'Username' },
        validator: { nullable: true },
        filterable: false,
        sortable: false,
        // Login identity; set via enable-login, never through generic PUT. Null = contact-only client.
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
    addButtonLabel: { es: 'Agregar cliente', en: 'Add Client' },
    sqlTable: 'auth.users',
    sqlReadTable: 'auth.users_directory',
    roleDiscriminator: { column: 'role', value: 'Client' },
    businessScoped: true,
    crud: { create: false, read: true, update: true, delete: true },
    softDelete,
    roleRequired: {
      create: [],
      read:   ['Admin', 'Receptionist', 'Professional', 'Client'],
      update: ['Admin', 'Receptionist', 'Client'],
      delete: ['Admin'],
    },
    // A Client is confined to their own row on every op — this is their own profile.
    ownership: { ownerColumn: 'id', role: 'Client' },
  } satisfies TableStructure,

  // Logical entity backed by auth.users WHERE role='Professional'.
  // No separate table exists; sqlTable + roleDiscriminator redirect all generic SQL to auth.users.
  // Create is disabled — professionals are created only via POST /api/admin/users.
  // Update is limited to profile fields (display_name, bio).
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
    addButtonLabel: { es: 'Agregar profesional', en: 'Add Professional' },
    sqlTable: 'auth.users',
    sqlReadTable: 'auth.users_directory',
    roleDiscriminator: { column: 'role', value: 'Professional' },
    businessScoped: true,
    crud: { create: false, read: true, update: true, delete: true },
    softDelete,
    schedulable: professionalSchedulable,
    roleRequired: {
      create: [],
      read:   ['Admin', 'Receptionist', 'Professional', 'Client'],
      update: ['Admin', 'Receptionist', 'Professional'],
      delete: ['Admin'],
    },
    // A Professional is confined to their own row only when writing (editing their own
    // profile). Reads stay unscoped for every allowed role — Clients need the full
    // professional list to book, Admin/Receptionist need it to manage the calendar.
    ownership: { ownerColumn: 'id', role: 'Professional', ops: ['update', 'delete'] },
    grantScope: receptionistGrantScope,
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
    uiName: { es: 'Sala', en: 'Room' },
    title: { es: 'Salas', en: 'Rooms' },
    addButtonLabel: { es: 'Agregar sala', en: 'Add Room' },
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

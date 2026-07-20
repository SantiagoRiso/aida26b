import type { Role } from "./roles";
import type { Language } from "./languages";

type CrudOp = 'create' | 'read' | 'update' | 'delete';

type RoleRequired = {
  [K in CrudOp]?: Role[];
};

// Column that holds this row's owner user_id, and which role/operations get self-scoped to it.
// e.g. clients self-scopes Client on every op (a client only ever sees their own row); professionals
// self-scopes Professional on writes only (editing a peer's profile), never Client reads (clients
// need the full professional list to book) — the target role/ops are what makes that distinction.
type OwnershipDescriptor = {
  ownerColumn: string;
  role: Role;
  ops?: CrudOp[];  // defaults to every op when omitted
};

// Rows visible/writable for this role are limited to those a grant row names —
// e.g. a receptionist acts only on professionals whose calendars they hold a grant on.
type GrantScopeDescriptor = {
  role: Role;
  grantTable: string;      // e.g. 'calendar_grants'
  grantRowColumn: string;  // grantTable column naming this table's owner (matched to ownership.ownerColumn, else pk), e.g. 'professional_user_id'
  granteeColumn: string;   // grantTable column naming the caller, e.g. 'grantee_user_id'
};

// Single join step used to derive business_id for tables without a direct business_id column.
type BusinessJoinPath = {
  parentTable: string;  // may be schema-qualified, e.g. 'auth.users'
  localFk:     string;
  parentPk:    string;
};

// Two paths support dual-owner tables (schedule_blocks, schedule_exceptions).
type BusinessJoinDescriptor = {
  paths: BusinessJoinPath[];
};

// Role discriminator: constrains every generic SQL operation to rows with a specific role value.
// Used by clients (role='Client') and professionals (role='Professional') whose data lives on auth.users.
type RoleDiscriminator = {
  column: string;   // e.g. 'role'
  value:  string;   // e.g. 'Client' or 'Professional'
};

type TypeMap = {
  string: string;
  number: number;
  boolean: boolean;
  date: Date;
};

type MyTypeNames = keyof TypeMap;

type ColumnValue = TypeMap[MyTypeNames] | null;

type ColumnValidator = {
  required?: boolean;
  // Literal `true` (not boolean) so descriptor literals keep it narrow and InferType
  // can derive `| null` per column; a non-nullable column just omits the flag.
  nullable?: true;
  minLength?: number;
  maxLength?: number;
  minValue?: number;
  maxValue?: number;
  integer?: boolean;
  pattern?: string;
  patternMessage?: string;
  // Names the constraint the pattern expresses (email, amount, time of day) so a violation can
  // be reported as something other than "wrong format" in whatever language the reader uses.
  patternKey?: string;
  normalize?: { pattern: string; replacement: string };
}

type ForeignKeyDef = {
  table: string;
  valueField: string;
  labelField: string;
  dependsOn?: {
    field: string;
    foreignField: string;
  };
};

type LocalizedText = Record<Language, string>;

type ColumnDef = {
  type: MyTypeNames;
  label?: LocalizedText;
  input?: 'text' | 'email' | 'date' | 'number' | 'textarea' | 'select';
  options?: Array<{ value: string; label: LocalizedText }>;
  editable?: boolean;
  required?: boolean;
  readonlyOnEdit?: boolean;
  validator?: ColumnValidator;
  filterable?: boolean;
  sortable?: boolean;
  derivable?: {originTable: string, sqlGenerationStatement: string};
  foreignKey?: ForeignKeyDef;
  referencesUserRole?: Extract<Role, 'Professional' | 'Client'>;
}

// Generic-CRUD operations a table exposes. Operations are enabled explicitly so route
// builders never expose more than was declared.
type CrudPolicy = {
  [K in CrudOp]?: boolean;
};

// Presence of this metadata turns the generic delete into an archive (set the deleted-at
// column) instead of a physical delete.
type SoftDeletePolicy = {
  deletedAtColumn: string;
  deletedByColumn?: string;
};

type StatusMeta = {
  column: string;
  values: Array<{ value: string; label: LocalizedText }>;
};

// Availability is computed in the domain layer from the weekly pattern minus dated
// exceptions minus booked appointments — never stored.
type SchedulableCapability = {
  calendarLabel: LocalizedText;
  identityField: string;
  displayField: string;
  ownerForeignKey: string;            // FK column naming this owner on schedule_blocks/appointments
  availability: {
    weeklySource: string;
    exceptionSource: string;
  };
  conflict: {
    overridable: boolean;
  };
  rules?: {
    availability?: string;
    conflict?: string;
  };
};

type TableStructure = {
  columns: Record<string, ColumnDef>
  pk: string | string[]
  uiName: LocalizedText
  title?: LocalizedText
  addButtonLabel?: LocalizedText
  referencedTables?: string[]
  businessScoped?: boolean          // carries a direct `business_id` owner column
  protected?: boolean               // workflow-owned; excluded from generic CRUD
  crud?: CrudPolicy
  softDelete?: SoftDeletePolicy
  status?: StatusMeta
  schedulable?: SchedulableCapability
  roleRequired?:  RoleRequired
  ownership?:     OwnershipDescriptor
  grantScope?:    GrantScopeDescriptor
  // Generic writes for the listed ops must pass the async professional owner+grant guard
  // (assertOwnScheduleAllowed), keyed on the row's professional_user_id — the grant-aware check
  // the synchronous scope engine can't express for a surrogate-pk owner table. Separate from the
  // schedulable-derived owner-scheduled tables (schedule_blocks/schedule_exceptions), which are
  // guarded on every write automatically.
  professionalOwnerGuard?: { ops: Array<Extract<CrudOp, 'create' | 'update' | 'delete'>> }
  businessJoin?:  BusinessJoinDescriptor
  // When set, generic SQL targets this schema-qualified table instead of the SSOT key name.
  sqlTable?:          string
  // When set, GENERIC READS (GET) target this table/view instead of sqlTable; writes still use
  // sqlTable. Used to read through a secret-free view (e.g. auth.users_directory) so a "SELECT *"
  // never projects password columns, while updates/deletes keep hitting the real table.
  sqlReadTable?:      string
  // When set, every generic SQL operation ANDs this column = value to constrain the entity type.
  roleDiscriminator?: RoleDiscriminator
}

type InferType<FieldDefs extends Record<string, ColumnDef>> = {
  [K in keyof FieldDefs]: FieldDefs[K]['validator'] extends { nullable: true }
    ? TypeMap[FieldDefs[K]['type']] | null
    : TypeMap[FieldDefs[K]['type']]
}

export type {CrudOp, RoleRequired, OwnershipDescriptor, BusinessJoinPath, BusinessJoinDescriptor, RoleDiscriminator, TypeMap, MyTypeNames, ColumnValidator, ColumnDef, CrudPolicy, SoftDeletePolicy, StatusMeta, SchedulableCapability, TableStructure, InferType, ForeignKeyDef, Language, LocalizedText, ColumnValue, GrantScopeDescriptor};

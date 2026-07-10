import { structure } from "../ssot/structure";

type Response = {
  success: boolean;
  data: undefined | any;
  message: string;
  code?: string;
}

// Canonical role union. Shared here so SSOT domain files need not import from backend.
type Role = 'Admin' | 'Professional' | 'Receptionist' | 'Client';

type RoleRequired = {
  create?: Role[];
  read?:   Role[];
  update?: Role[];
  delete?: Role[];
};

// Column that holds this row's owner user_id, and which role/operations get self-scoped to it.
// e.g. clients self-scopes Client on every op (a client only ever sees their own row); professionals
// self-scopes Professional on writes only (editing a peer's profile), never Client reads (clients
// need the full professional list to book) — the target role/ops are what makes that distinction.
type OwnershipDescriptor = {
  ownerColumn: string;
  role: Role;
  ops?: Array<'create' | 'read' | 'update' | 'delete'>;  // defaults to every op when omitted
};

// Rows visible/writable for this role are limited to those a grant row names —
// e.g. a receptionist acts only on professionals whose calendars they hold a grant on.
type GrantScopeDescriptor = {
  role: Role;
  grantTable: string;      // e.g. 'calendar_grants'
  grantRowColumn: string;  // grantTable column naming this table's pk, e.g. 'professional_user_id'
  granteeColumn: string;   // grantTable column naming the caller, e.g. 'grantee_user_id'
};

// Single join step used to derive business_id for tables without a direct business_id column.
type BusinessJoinPath = {
  parentTable: string;  // may be schema-qualified, e.g. 'auth.users'
  localFk:     string;
  parentPk:    string;
};

// Two paths support dual-owner tables (schedules, schedule_exceptions).
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

// What node-pg can serialize as a query parameter.
type SqlParam = string | number | boolean | Date | null | SqlParam[];

type ColumnValue = TypeMap[MyTypeNames] | null;

type ColumnValidator = {
  required?: boolean;
  nullable?: boolean;
  minLength?: number;
  maxLength?: number;
  minValue?: number;
  maxValue?: number;
  minDayOffset?: number;    // day-offset from today: -30 = 30 days ago, 0 = not in the past
  maxDayOffset?: number;    // day-offset from today: 0 = not in the future, 7 = up to 7 days ahead
  minDate?: string;         // ISO 'YYYY-MM-DD'
  integer?: boolean;
  pattern?: string;
  patternMessage?: string;
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

type Language = 'es' | 'en';
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
  nullable?: boolean;
  filterable?: boolean;
  sortable?: boolean;
  derivable?: {originTable: string, sqlGenerationStatement: string};
  foreignKey?: ForeignKeyDef;
  referencesUserRole?: 'Professional' | 'Client';
}

// Generic-CRUD operations a table exposes. Operations are enabled explicitly so route
// builders never expose more than was declared.
type CrudPolicy = {
  create?: boolean;
  read?: boolean;
  update?: boolean;
  delete?: boolean;
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
  ownerForeignKey: string;            // FK column naming this owner on schedules/appointments
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
  [K in keyof FieldDefs]: TypeMap[FieldDefs[K]['type']]
}

type TableKey = keyof typeof structure.tables;

type TableRecordMap = {
  [T in keyof typeof structure.tables]: InferType<(typeof structure.tables)[T]['columns']>
};

type RendererProps<K extends TableKey> = {
  id: string;
  fieldName: keyof TableRecordMap[K] & string;
  column: ColumnDef;
  record?: Partial<TableRecordMap[K]>;
  isEdit?: boolean;
};

type RendererFunc = <K extends TableKey>(props: RendererProps<K>) => HTMLElement;

export type {Role, RoleRequired, OwnershipDescriptor, BusinessJoinPath, BusinessJoinDescriptor, RoleDiscriminator, TypeMap, MyTypeNames, ColumnValidator, ColumnDef, CrudPolicy, SoftDeletePolicy, StatusMeta, SchedulableCapability, TableStructure, InferType, TableKey, TableRecordMap, Response, ForeignKeyDef, Language, LocalizedText, RendererProps, RendererFunc, SqlParam, ColumnValue, GrantScopeDescriptor};

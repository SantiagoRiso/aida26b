import { structure } from "../ssot/structure";

type Response = {
  success: boolean;
  data: undefined | any;
  message: string;
  code?: string;
}

type TypeMap = {
  string: string;
  number: number;
  boolean: boolean;
  date: Date;
};

type MyTypeNames = keyof TypeMap;

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
  schedulable?: SchedulableCapability // set on professionals and resources
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

export type {TypeMap, MyTypeNames, ColumnValidator, ColumnDef, CrudPolicy, SoftDeletePolicy, StatusMeta, SchedulableCapability, TableStructure, InferType, TableKey, TableRecordMap, Response, ForeignKeyDef, Language, LocalizedText, RendererProps, RendererFunc};

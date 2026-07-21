<script setup lang="ts" generic="K extends TableKey">
import { ref, computed, reactive } from 'vue';
import { useLabel } from '@/composables/useLabel';
import { i18n } from '@/i18n';
import { validateFieldIssue, validateFullObject } from '@shared/validation/validate';
import { fieldErrorMessage, fieldErrorMessages } from '@/i18n/api-errors';
import { createRow, updateRow } from '@/api/crud';
import { useToast } from '@/composables/useToast';
import { structure } from '@shared/ssot/structure';
import type { ColumnDef, ColumnValue } from '@shared/types/types';
import type { TableKey, TableRecordMap } from '@shared/ssot/derived';
import type { Wire } from '@shared/ssot/query-types';
import FieldError from '@/components/shared/FieldError.vue';
import AppButton from '@/components/shared/AppButton.vue';
import DateField from '@/components/shared/DateField.vue';
import ForeignKeySelect from '@/components/shared/ForeignKeySelect.vue';

const props = defineProps<{
  tableKey: K;
  mode: 'create' | 'edit';
  initial?: Partial<Wire<TableRecordMap[K]>>;
}>();

// The saved row is the server's response verbatim — uncoerced wire values, not the coerced
// record type.
const emit = defineEmits<{
  saved: [row: Wire<TableRecordMap[K]>];
  cancel: [];
}>();

const { label } = useLabel();
const { toast } = useToast();

const tableSpec = computed(() => structure.tables[props.tableKey]);

const editableColumns = computed(() => {
  const cols = tableSpec.value.columns as Record<string, ColumnDef>;
  return Object.entries(cols).filter(([, col]) => {
    if (props.mode === 'edit' && col.readonlyOnEdit) return false;
    if (col.editable === false) return false;
    return true;
  });
});

// Column names are dynamic (from the SSOT columns map), so the row is read by name.
const initialByColumn = computed(() => (props.initial ?? {}) as Partial<Record<string, ColumnValue>>);

const values = reactive<Record<string, ColumnValue | undefined>>({});
for (const [key, col] of Object.entries(tableSpec.value.columns as Record<string, ColumnDef>)) {
  values[key] = initialByColumn.value[key] ?? (col.type === 'number' ? '' : '');
}

// Inline errors are advisory only; the backend is authoritative.
const fieldErrors = reactive<Record<string, string>>({});
const submitting = ref(false);

function onBlur(field: string) {
  const issue = validateFieldIssue(props.tableKey, field, values[field]);
  if (issue) {
    fieldErrors[field] = fieldErrorMessage(issue);
  } else {
    delete fieldErrors[field];
  }
}

async function onSubmit() {
  const check = validateFullObject(props.tableKey, values as Partial<TableRecordMap[K]>);
  if ('fields' in check) {
    for (const [f, issue] of Object.entries(check.fieldDetails)) {
      fieldErrors[f] = fieldErrorMessage(issue);
    }
    // Fall through and submit anyway — the backend is authoritative.
  }

  submitting.value = true;
  try {
    const pk = tableSpec.value.pk;
    const id = typeof pk === 'string' ? values[pk] : undefined;

    const body: Record<string, ColumnValue | undefined> = {};
    for (const [key] of editableColumns.value) {
      body[key] = values[key] ?? null;
    }

    const result = props.mode === 'edit' && id
      ? await updateRow(props.tableKey, String(id), body as Partial<TableRecordMap[K]>)
      : await createRow(props.tableKey, body as Partial<TableRecordMap[K]>);

    if (result.ok) {
      toast('success', 'genericSuccess');
      emit('saved', result.data);
    } else {
      const serverFieldErrors = fieldErrorMessages(result);
      if (Object.keys(serverFieldErrors).length > 0) {
        for (const [f, msg] of Object.entries(serverFieldErrors)) {
          fieldErrors[f] = msg;
        }
      } else {
        toast('error', 'genericError');
      }
    }
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <form class="space-y-4" @submit.prevent="onSubmit" novalidate>
    <div
      v-for="[field, col] in editableColumns"
      :key="field"
      class="flex flex-col gap-1"
    >
      <label :for="field" class="text-sm font-semibold">
        {{ label(col.label) }}
        <span v-if="col.validator?.required" class="ml-1 text-destructive">*</span>
      </label>

      <textarea
        v-if="col.input === 'textarea'"
        :id="field"
        v-model="values[field] as string"
        rows="3"
        class="rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        :class="fieldErrors[field] ? 'border-destructive' : ''"
        @blur="onBlur(field)"
      />

      <ForeignKeySelect
        v-else-if="col.input === 'select' && col.foreignKey"
        :id="field"
        :foreign-key="col.foreignKey"
        :model-value="(values[field] as string) || null"
        :placeholder="i18n.global.t('generic.selectPlaceholder')"
        @update:model-value="values[field] = $event ?? ''"
        @blur="onBlur(field)"
      />

      <select
        v-else-if="col.input === 'select' && col.options"
        :id="field"
        v-model="values[field] as string"
        class="rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        :class="fieldErrors[field] ? 'border-destructive' : ''"
        @blur="onBlur(field)"
        @change="onBlur(field)"
      >
        <option value="">{{ i18n.global.t('generic.selectPlaceholder') }}</option>
        <option
          v-for="opt in col.options"
          :key="opt.value"
          :value="opt.value"
        >
          {{ label(opt.label) }}
        </option>
      </select>

      <input
        v-else-if="col.input === 'number' || col.type === 'number'"
        :id="field"
        type="number"
        v-model.number="values[field] as number"
        class="rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        :class="fieldErrors[field] ? 'border-destructive' : ''"
        @blur="onBlur(field)"
      />

      <input
        v-else-if="col.input === 'email'"
        :id="field"
        type="email"
        v-model="values[field] as string"
        class="rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        :class="fieldErrors[field] ? 'border-destructive' : ''"
        @blur="onBlur(field)"
      />

      <DateField
        v-else-if="col.input === 'date' || col.type === 'date'"
        :id="field"
        :model-value="(values[field] as string | null) ?? null"
        :invalid="!!fieldErrors[field]"
        @update:model-value="values[field] = $event as ColumnValue"
        @blur="onBlur(field)"
      />

      <input
        v-else
        :id="field"
        type="text"
        v-model="values[field] as string"
        class="rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        :class="fieldErrors[field] ? 'border-destructive' : ''"
        @blur="onBlur(field)"
      />

      <FieldError :message="fieldErrors[field]" />
    </div>

    <template v-if="mode === 'edit'">
      <div
        v-for="[field, col] in Object.entries(tableSpec.columns as Record<string, ColumnDef>).filter(([, c]) => c.editable === false)"
        :key="`ro-${field}`"
        class="flex flex-col gap-1"
      >
        <span class="text-sm font-semibold text-neutral">{{ label(col.label) }}</span>
        <span class="rounded-md bg-surface px-3 py-2 text-sm text-neutral">{{ initialByColumn[field] ?? i18n.global.t('generic.emptyValue') }}</span>
      </div>
    </template>

    <div class="flex justify-end gap-3 pt-2">
      <AppButton variant="neutral" type="button" @click="emit('cancel')">
        {{ i18n.global.t('actions.cancel') }}
      </AppButton>
      <AppButton type="submit" :loading="submitting">
        {{ i18n.global.t('actions.save') }}
      </AppButton>
    </div>
  </form>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { deleteRow } from '@/api/crud';
import { useToast } from '@/composables/useToast';
import { useCurrency } from '@/composables/useCurrency';
import { classifyException, type ExceptionRow } from '@/composables/scheduleExceptions';
import ConfirmDialog from '@/components/shared/ConfirmDialog.vue';

defineProps<{ rows: ExceptionRow[]; showEdit?: boolean }>();

const emit = defineEmits<{
  deleted: [];
  edit: [row: ExceptionRow];
}>();

const { t } = useI18n();
const toast = useToast();
const { formatDate } = useCurrency();

// One shared dialog for the whole list — the row awaiting confirmation, not a per-row flag.
const pendingDeleteId = ref<string | null>(null);
const confirmOpen = ref(false);

function requestDelete(id: string) {
  pendingDeleteId.value = id;
  confirmOpen.value = true;
}

function cancelDelete() {
  confirmOpen.value = false;
  pendingDeleteId.value = null;
}

async function confirmDelete() {
  const id = pendingDeleteId.value;
  confirmOpen.value = false;
  pendingDeleteId.value = null;
  if (id == null) return;

  const result = await deleteRow('schedule_exceptions', id);
  if (!result.ok) {
    toast.error('exceptionDeleteError');
    return;
  }
  emit('deleted');
}
</script>

<template>
  <section class="flex flex-col gap-2">
    <h2 class="text-sm font-semibold">{{ t('exception.listTitle') }}</h2>
    <p v-if="rows.length === 0" class="text-xs text-neutral">{{ t('exception.listEmpty') }}</p>
    <ul v-else class="flex flex-col gap-1">
      <li
        v-for="row in rows"
        :key="row.id"
        :data-testid="`exception-row-${row.id}`"
        class="flex items-center justify-between gap-2 rounded border border-border px-3 py-2 text-sm"
      >
        <div class="flex flex-col">
          <span class="font-medium">
            {{ formatDate(row.exception_date) }} · {{ t(`exception.kind.${classifyException(row)}`) }}
            <template v-if="row.start_time && row.end_time">
              · {{ row.start_time }}-{{ row.end_time }}
            </template>
          </span>
          <span v-if="row.reason" class="text-xs text-neutral">{{ row.reason }}</span>
        </div>
        <span class="flex items-center gap-3">
          <button
            v-if="showEdit"
            type="button"
            class="text-xs font-semibold text-accent hover:underline"
            :data-testid="`exception-edit-${row.id}`"
            @click="emit('edit', row)"
          >
            {{ t('actions.edit') }}
          </button>
          <button
            type="button"
            class="text-xs font-semibold text-destructive hover:underline"
            :data-testid="`exception-delete-${row.id}`"
            @click="requestDelete(row.id)"
          >
            {{ t('exception.delete') }}
          </button>
        </span>
      </li>
    </ul>

    <ConfirmDialog
      :open="confirmOpen"
      :title="t('exception.deleteTitle')"
      :body="t('exception.deleteConfirm')"
      :confirm-label="t('actions.confirm')"
      destructive
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    />
  </section>
</template>

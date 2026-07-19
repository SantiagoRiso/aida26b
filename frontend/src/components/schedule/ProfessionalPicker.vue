<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { listRows } from '@/api/crud';
import Selector from '@/components/shared/Selector.vue';
import { scopeProfessionalOptions } from '@/composables/useFullCalendar';
import { useAuthStore } from '@/stores/auth';

// allowAll turns the picker into a filter: it prepends an "all professionals" entry (a null
// selection) instead of auto-locking to a single professional. Default off keeps the Horario
// behavior (a lone option collapses to a read-only, auto-selected label).
const props = defineProps<{ modelValue: number | null; allowAll?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [id: number | null] }>();

const { t } = useI18n();
const auth = useAuthStore();
const proOptions = ref<{ value: string; label: string }[]>([]);

onMounted(async () => {
  const res = await listRows('professionals', { limit: 200 });
  if (!res.ok) return;
  const scoped = scopeProfessionalOptions(
    res.data.map((p) => ({ id: Number(p.id), label: p.display_name })),
    auth.user,
  );
  proOptions.value = scoped.map((o) => ({ value: String(o.id), label: o.label }));
});

// Sentinel for the "all professionals" entry; maps to a null (unfiltered) selection.
const ALL = 'all';
const options = computed(() =>
  props.allowAll
    ? [{ value: ALL, label: t('schedule.allProfessionals') }, ...proOptions.value]
    : proOptions.value,
);

// Filtering a single calendar is meaningless — the caller's list is already that professional's —
// so the "all" filter only appears once there are at least two professionals to choose between.
const visible = computed(() => !props.allowAll || proOptions.value.length > 1);

// Selector speaks string values; the editor keys blocks by numeric professional id. A lone option —
// a Professional viewing self, or a Receptionist with a single grant — collapses to a read-only
// label (and auto-selects) via Selector's labelIfSingle default.
const selected = computed<string | null>({
  get: () => (props.modelValue == null ? (props.allowAll ? ALL : null) : String(props.modelValue)),
  set: (v) => emit('update:modelValue', v == null || v === ALL ? null : Number(v)),
});
</script>

<template>
  <label v-if="visible" class="flex min-w-[220px] flex-col gap-1 text-sm">
    <span class="font-medium text-neutral">{{ t('schedule.pickProfessional') }}</span>
    <Selector
      id="schedule-professional-select"
      v-model="selected"
      :options="options"
      :label-if-single="!allowAll"
      :show-empty-option="!allowAll"
      :placeholder="allowAll ? '' : t('generic.select')"
    />
  </label>
</template>

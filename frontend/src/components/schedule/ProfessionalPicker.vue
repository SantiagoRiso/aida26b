<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { listRows } from '@/api/crud';
import Selector from '@/components/shared/Selector.vue';
import { scopeProfessionalOptions } from '@/composables/useFullCalendar';
import { useAuthStore } from '@/stores/auth';

const props = defineProps<{ modelValue: number | null }>();
const emit = defineEmits<{ 'update:modelValue': [id: number | null] }>();

const { t } = useI18n();
const auth = useAuthStore();
const options = ref<{ value: string; label: string }[]>([]);

onMounted(async () => {
  const res = await listRows('professionals', { limit: 200 });
  if (!res.ok) return;
  const scoped = scopeProfessionalOptions(
    res.data.map((p) => ({ id: Number(p.id), label: p.display_name })),
    auth.user,
  );
  options.value = scoped.map((o) => ({ value: String(o.id), label: o.label }));
});

// Selector speaks string values; the editor keys blocks by numeric professional id. A lone option —
// a Professional viewing self, or a Receptionist with a single grant — collapses to a read-only
// label (and auto-selects) via Selector's labelIfSingle default.
const selected = computed<string | null>({
  get: () => (props.modelValue == null ? null : String(props.modelValue)),
  set: (v) => emit('update:modelValue', v == null ? null : Number(v)),
});
</script>

<template>
  <label class="flex min-w-[220px] flex-col gap-1 text-sm">
    <span class="font-medium text-neutral">{{ t('schedule.pickProfessional') }}</span>
    <Selector id="schedule-professional-select" v-model="selected" :options="options" />
  </label>
</template>

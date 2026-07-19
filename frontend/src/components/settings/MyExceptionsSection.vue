<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { listRows } from '@/api/crud';
import type { ExceptionRow } from '@/composables/scheduleExceptions';
import ExceptionForm from '@/components/calendar/ExceptionForm.vue';
import ExceptionList from '@/components/calendar/ExceptionList.vue';

// A professional self-manages their own time off here. Owner is always the logged-in professional;
// business-wide closures (owner-less) are Admin-managed on Negocio and never surface in this list.
const auth = useAuthStore();
const rows = ref<ExceptionRow[]>([]);
// Non-null while editing one of the rows; the form re-mounts (keyed) so it re-initialises from it.
const editing = ref<ExceptionRow | null>(null);

async function load() {
  const id = auth.user?.id;
  if (id == null) { rows.value = []; return; }
  const res = await listRows('schedule_exceptions', { filters: { professional_user_id: String(id) }, limit: 500 });
  rows.value = res.ok ? res.data : [];
}
onMounted(load);

async function onSaved() {
  editing.value = null;
  await load();
}
</script>

<template>
  <div class="space-y-4">
    <ExceptionForm
      :key="editing?.id ?? 'new'"
      :professional-id="auth.user?.id ?? null"
      :resource-id="null"
      :exception="editing ?? undefined"
      @saved="onSaved"
      @cancel="editing = null"
    />
    <ExceptionList :rows="rows" show-edit @edit="editing = $event" @deleted="load" />
  </div>
</template>

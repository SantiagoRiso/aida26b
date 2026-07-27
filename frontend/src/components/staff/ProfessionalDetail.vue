<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { getRow, listRows, deleteRow } from '@/api/crud';
import { useForeignKeyOptions } from '@/composables/useForeignKeyOptions';
import { listAppointments } from '@/api/appointments';
import type { Appointment } from '@/api/appointments';
import { isVirtualOccurrence } from '@/composables/seriesOccurrence';
import { useCurrency } from '@/composables/useCurrency';
import { useStateLabel } from '@/composables/useStateLabel';
import { useToast } from '@/composables/useToast';
import { useAuthStore } from '@/stores/auth';
import { roleAllowedFor, descriptorWriteRoles } from '@/router/access';
import type { TableRecordMap } from '@shared/ssot/derived';
import { isOpenAppointmentState } from '@shared/ssot/domain';
import Skeleton from '@/components/shared/Skeleton.vue';
import EmptyState from '@/components/shared/EmptyState.vue';
import AppButton from '@/components/shared/AppButton.vue';
import DetailPanel from '@/components/shared/DetailPanel.vue';
import ConfirmDialog from '@/components/shared/ConfirmDialog.vue';
import GenericForm from '@/components/generic/GenericForm.vue';

const props = defineProps<{ professionalId: number }>();
const emit = defineEmits<{
  close: [];
  changed: [];
}>();

const { t } = useI18n();
const { formatDateTime } = useCurrency();
const { stateLabel } = useStateLabel();
const toast = useToast();
const auth = useAuthStore();

const professionalId = props.professionalId;

const professional = ref<TableRecordMap['professionals'] | null>(null);
const services = ref<string[]>([]);
const appointments = ref<Appointment[]>([]);
const { labelFor: clientLabelFor } = useForeignKeyOptions({ table: 'clients', valueField: 'id', labelField: 'display_name' });
const serviceNames = ref<Map<string, string>>(new Map());
const loading = ref(true);

const showEditProfile = ref(false);
const deactivateConfirmOpen = ref(false);

const role = computed(() => auth.user?.role);
const isSelf = computed(() => String(auth.user?.id) === String(professionalId));
const canEditProfile = computed(() => {
  if (!role.value) return false;
  // Admin/Receptionist manage any professional; a Professional edits only their own profile.
  if (roleAllowedFor(descriptorWriteRoles('professionals', 'update', { exclude: ['Professional'] }), role.value)) return true;
  return role.value === 'Professional' && isSelf.value && descriptorWriteRoles('professionals', 'update').includes('Professional');
});
const canDeactivate = computed(() => !!role.value && roleAllowedFor(descriptorWriteRoles('professionals', 'delete'), role.value));

const now = new Date();
// The appointments list is server-scoped: Admin/Receptionist see this professional's whole agenda,
// a Professional viewing their own row sees theirs, and a Professional viewing a colleague sees none.
const upcoming = computed(() =>
  appointments.value
    .filter((a) => new Date(a.starts_at) >= now && isOpenAppointmentState(a.state))
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at)),
);
// A busy professional can have dozens of upcoming turnos; show the soonest few and summarize the rest.
const UPCOMING_LIMIT = 8;
const visibleUpcoming = computed(() => upcoming.value.slice(0, UPCOMING_LIMIT));
const extraUpcoming = computed(() => Math.max(0, upcoming.value.length - UPCOMING_LIMIT));

const clientName = (id: number | string) => clientLabelFor(id) ?? t('generic.unresolvedReference');
const serviceName = (id: number | string) => serviceNames.value.get(String(id)) ?? t('generic.unresolvedReference');

async function loadProfile() {
  const res = await getRow('professionals', professionalId);
  if (res.ok) professional.value = res.data;
}

async function loadServices() {
  const [ps, svc] = await Promise.all([
    listRows('professional_services', {
      filters: { professional_user_id: String(professionalId) },
      limit: 200,
    }),
    listRows('services', { limit: 500 }),
  ]);
  const svcMap = new Map<string, string>();
  if (svc.ok) for (const s of svc.data) svcMap.set(String(s.id), s.name);
  serviceNames.value = svcMap;
  services.value = ps.ok
    ? ps.data.map((r) => svcMap.get(String(r.service_id))).filter((n): n is string => !!n)
    : [];
}

async function loadAppointments() {
  // Only upcoming turnos are shown, so bound the fetch from now — otherwise a long past
  // history could fill the page and push genuine upcoming appointments out of the result.
  const res = await listAppointments({
    professional_user_id: professionalId,
    date_from: new Date().toISOString(),
    limit: 200,
  });
  // Read-only upcoming list, no materialize-on-action wiring — a virtual (un-materialized)
  // occurrence is filtered out rather than shown as inert.
  appointments.value = res.ok ? res.data.filter((a): a is Appointment => !isVirtualOccurrence(a)) : [];
}

async function load() {
  loading.value = true;
  await Promise.all([loadProfile(), loadServices(), loadAppointments()]);
  loading.value = false;
}

function onProfileSaved() {
  showEditProfile.value = false;
  loadProfile();
  emit('changed');
}

async function confirmDeactivate() {
  deactivateConfirmOpen.value = false;
  const res = await deleteRow('professionals', professionalId);
  if (res.ok) {
    emit('changed');
    emit('close');
  } else {
    toast.error('genericError');
  }
}

onMounted(load);
</script>

<template>
  <div class="space-y-6">
    <div v-if="loading">
      <Skeleton variant="row" :rows="5" />
    </div>

    <template v-else-if="professional">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div class="min-w-0">
          <h1 class="text-2xl font-semibold">{{ professional.display_name }}</h1>
          <p v-if="professional.bio" class="mt-1 text-sm text-neutral">{{ professional.bio }}</p>
        </div>
        <div class="flex gap-2">
          <AppButton v-if="canEditProfile" variant="neutral" @click="showEditProfile = true">
            {{ t('users.editProfile') }}
          </AppButton>
          <AppButton v-if="canDeactivate" variant="destructive" @click="deactivateConfirmOpen = true">
            {{ t('users.deactivate') }}
          </AppButton>
        </div>
      </div>

      <div class="grid gap-6 lg:grid-cols-2">
        <section class="space-y-3">
          <h2 class="text-lg font-semibold">{{ t('professionals.servicesHeading') }}</h2>
          <div v-if="services.length > 0" class="flex flex-wrap gap-2">
            <span
              v-for="name in services"
              :key="name"
              class="rounded-full bg-surface px-3 py-1 text-sm text-neutral"
            >
              {{ name }}
            </span>
          </div>
          <p v-else class="text-sm text-neutral">
            {{ t('professionals.noServicesAssigned') }}
          </p>
        </section>

        <section class="space-y-3">
          <h2 class="text-lg font-semibold">{{ t('portal.upcomingHeading') }}</h2>
          <div v-if="upcoming.length > 0">
            <ul class="divide-y divide-border rounded-lg border border-border bg-card">
              <li v-for="appt in visibleUpcoming" :key="appt.id" class="px-4 py-3 text-sm">
                <span class="font-medium tabular-nums">{{ formatDateTime(appt.starts_at) }}</span>
                <span class="text-neutral"> · {{ serviceName(appt.service_id) }}</span>
                <span class="text-neutral"> · {{ clientName(appt.client_user_id) }}</span>
                <span class="ml-2 rounded-full bg-surface px-2 py-0.5 text-xs">{{ stateLabel(appt.state) }}</span>
              </li>
            </ul>
            <p v-if="extraUpcoming > 0" class="mt-2 text-xs text-neutral">
              {{ t('professionals.moreAppointments', { n: extraUpcoming }) }}
            </p>
          </div>
          <EmptyState
            v-else
            :heading="t('dashboard.noUpcoming')"
            :body="t('professionals.noUpcomingBody')"
          />
        </section>
      </div>
    </template>

    <template v-else>
      <EmptyState
        :heading="t('professionals.notFoundHeading')"
        :body="t('professionals.notFoundBody')"
      />
    </template>

    <DetailPanel
      :open="showEditProfile"
      :title="t('users.editProfile')"
      @close="showEditProfile = false"
    >
      <GenericForm
        v-if="professional"
        table-key="professionals"
        mode="edit"
        :initial="professional ?? undefined"
        @saved="onProfileSaved"
        @cancel="showEditProfile = false"
      />
    </DetailPanel>

    <ConfirmDialog
      :open="deactivateConfirmOpen"
      :title="t('professionals.deactivateTitle')"
      :body="t('users.deactivateBody', { name: professional?.display_name ?? '' })"
      :confirm-label="t('users.deactivate')"
      :destructive="true"
      @confirm="confirmDeactivate"
      @cancel="deactivateConfirmOpen = false"
    />
  </div>
</template>

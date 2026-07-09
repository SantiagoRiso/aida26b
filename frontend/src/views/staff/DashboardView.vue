<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { listAppointments, transitionAppointment } from '@/api/appointments';
import { createEntry } from '@/api/ledger';
import { listAudit } from '@/api/audit';
import type { Appointment } from '@/api/appointments';
import type { AuditEvent } from '@/api/audit';
import { useCurrency } from '@/composables/useCurrency';
import { useLabel } from '@/composables/useLabel';
import { useToast } from '@/composables/useToast';
import { useForeignKeyOptions } from '@/composables/useForeignKeyOptions';
import Skeleton from '@/components/shared/Skeleton.vue';
import EmptyState from '@/components/shared/EmptyState.vue';
import AppButton from '@/components/shared/AppButton.vue';

const { t } = useI18n();
const auth = useAuthStore();
const router = useRouter();
const { formatDateTime, formatARS } = useCurrency();
const { label } = useLabel();
const toast = useToast();

const role = computed(() => auth.user?.role);
const userId = computed(() => auth.user?.id);

const todayStart = new Date();
todayStart.setHours(0, 0, 0, 0);
const todayEnd = new Date();
todayEnd.setHours(23, 59, 59, 999);

const proUpcoming = ref<Appointment[]>([]);
const proPending = ref<Appointment[]>([]);
const loadingPro = ref(false);

async function loadProfessional() {
  loadingPro.value = true;
  const [upcomingRes, pendingRes] = await Promise.all([
    listAppointments({
      professional_user_id: userId.value,
      date_from: new Date().toISOString().slice(0, 10),
      limit: 5,
    }),
    listAppointments({
      professional_user_id: userId.value,
      limit: 50,
    }),
  ]);
  if (upcomingRes.ok) proUpcoming.value = upcomingRes.data.slice(0, 5);
  if (pendingRes.ok) {
    proPending.value = pendingRes.data
      .filter((a) => a.state === 'requested')
      .slice(0, 5);
  }
  loadingPro.value = false;
}

const recToday = ref<Appointment[]>([]);
const recPending = ref<Appointment[]>([]);
const loadingRec = ref(false);

async function loadReceptionist() {
  loadingRec.value = true;
  const [todayRes, pendingRes] = await Promise.all([
    listAppointments({
      date_from: todayStart.toISOString().slice(0, 10),
      date_to: todayEnd.toISOString().slice(0, 10),
      limit: 50,
    }),
    listAppointments({ limit: 50 }),
  ]);
  if (todayRes.ok) recToday.value = todayRes.data;
  if (pendingRes.ok) {
    recPending.value = pendingRes.data
      .filter((a) => a.state === 'requested')
      .slice(0, 5);
  }
  loadingRec.value = false;
}

const adminToday = ref<Appointment[]>([]);
const adminPending = ref<Appointment[]>([]);
const recentAudit = ref<AuditEvent[]>([]);
const loadingAdmin = ref(false);

async function loadAdmin() {
  loadingAdmin.value = true;
  const [todayRes, pendingRes, auditRes] = await Promise.all([
    listAppointments({
      date_from: todayStart.toISOString().slice(0, 10),
      date_to: todayEnd.toISOString().slice(0, 10),
      limit: 100,
    }),
    listAppointments({ limit: 50 }),
    listAudit({}, 1, 5),
  ]);
  if (todayRes.ok) adminToday.value = todayRes.data;
  if (pendingRes.ok) {
    adminPending.value = pendingRes.data.filter((a) => a.state === 'requested');
  }
  if (auditRes.ok) recentAudit.value = auditRes.data;
  loadingAdmin.value = false;
}

onMounted(() => {
  if (role.value === 'Professional') loadProfessional();
  else if (role.value === 'Receptionist') loadReceptionist();
  else if (role.value === 'Admin') loadAdmin();
  if (showsCard.value) {
    void loadCurrent();
    // Re-evaluate the ±5-min window as time passes so the card appears/clears on its own.
    nowTimer = window.setInterval(() => { now.value = new Date(); }, 30_000);
  }
});

onBeforeUnmount(() => {
  if (nowTimer !== undefined) window.clearInterval(nowTimer);
});

// Untitled appointments read as the client's name, not an opaque "Turno #id".
const { options: clientOptions } = useForeignKeyOptions({
  table: 'clients', valueField: 'id', labelField: 'display_name',
});
function apptLabel(appt: Appointment): string {
  if (appt.name) return appt.name;
  const clientName = appt.client_user_id != null
    ? clientOptions.value.find((o) => o.value === String(appt.client_user_id))?.label
    : undefined;
  return clientName ?? `Turno #${appt.id}`;
}

// Current-appointment payment card. Scoped to Admin/Professional — the roles that may register a
// payment (a receptionist can only post appointment charges, which completion already handles).
const { options: serviceOptions } = useForeignKeyOptions({
  table: 'services', valueField: 'id', labelField: 'name',
});
const showsCard = computed(() => role.value === 'Admin' || role.value === 'Professional');

const todays = ref<Appointment[]>([]);
const now = ref(new Date());
let nowTimer: number | undefined;
// Per-card editable payment amount and in-flight flag, keyed by appointment id.
const amounts = ref<Record<number, string>>({});
const processing = ref<Record<number, boolean>>({});

// The turno is "current" from 5 min before it starts until 5 min after it ends.
const WINDOW_MS = 5 * 60 * 1000;
function isCurrent(appt: Appointment, at: Date): boolean {
  if (appt.state !== 'scheduled') return false;
  const start = new Date(appt.starts_at).getTime();
  const end = new Date(appt.ends_at).getTime();
  const t = at.getTime();
  return t >= start - WINDOW_MS && t <= end + WINDOW_MS;
}
const currentAppointments = computed(() =>
  todays.value
    .filter((a) => isCurrent(a, now.value))
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at)),
);

// Attendance can't be marked before the turno starts (backend rejects it), so actions stay
// disabled during the pre-start part of the window.
function canSettle(appt: Appointment): boolean {
  return now.value.getTime() >= new Date(appt.starts_at).getTime();
}

async function loadCurrent() {
  // Full local day as ISO bounds — a bare date as date_to resolves to that day's midnight and
  // would exclude the whole day (the filter compares starts_at directly).
  const res = await listAppointments({
    date_from: todayStart.toISOString(),
    date_to: todayEnd.toISOString(),
    limit: 100,
  });
  if (!res.ok) return;
  todays.value = res.data;
  for (const a of todays.value) {
    if (!(a.id in amounts.value)) amounts.value[a.id] = a.price ?? '';
  }
}

function serviceNameFor(appt: Appointment): string | null {
  return serviceOptions.value.find((o) => o.value === String(appt.service_id))?.label ?? null;
}

// Registering attendance completes the turno (the backend posts the session charge once);
// "paid" additionally records the payment. "absent" marks a no_show and never charges.
async function settle(appt: Appointment, action: 'paid' | 'unpaid' | 'absent') {
  processing.value[appt.id] = true;
  try {
    const to = action === 'absent' ? 'no_show' : 'completed';
    const res = await transitionAppointment(appt.id, to);
    if (!res.ok) {
      toast.error('genericError');
      return;
    }

    if (action === 'paid' && appt.client_user_id != null) {
      const amount = (amounts.value[appt.id] ?? appt.price ?? '').trim();
      const paid = await createEntry({
        client_user_id: appt.client_user_id,
        entry_type: 'payment',
        amount_ars: amount,
        appointment_id: appt.id,
      });
      if (!paid.ok) {
        // The turno is already completed/charged; surface the payment failure and refresh.
        toast.error('genericError');
        await loadCurrent();
        return;
      }
    }

    toast.success(
      action === 'paid' ? 'paymentRegistered' : action === 'unpaid' ? 'attendanceRegistered' : 'absenceRegistered',
    );
    await loadCurrent();
  } finally {
    processing.value[appt.id] = false;
  }
}
</script>

<template>
  <div class="p-6">
    <h1 class="text-[28px] font-semibold leading-tight text-heading mb-6">
      {{ label({ es: 'Inicio', en: 'Dashboard' }) }}
    </h1>

    <div v-if="showsCard && currentAppointments.length" class="mb-6 space-y-4">
      <div
        v-for="appt in currentAppointments"
        :key="appt.id"
        class="rounded-lg border-2 border-accent bg-card p-5"
      >
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div class="min-w-0">
            <div class="text-xs font-semibold uppercase tracking-wide text-accent">
              {{ label({ es: 'Turno actual', en: 'Current appointment' }) }}
            </div>
            <h2 class="mt-1 text-lg font-semibold text-heading">{{ apptLabel(appt) }}</h2>
            <p class="text-sm text-neutral">
              {{ formatDateTime(appt.starts_at) }}
              <span v-if="serviceNameFor(appt)"> · {{ serviceNameFor(appt) }}</span>
            </p>
          </div>
          <div class="text-right">
            <div class="text-xs text-neutral">{{ label({ es: 'Precio', en: 'Price' }) }}</div>
            <div class="text-lg font-semibold tabular-nums">{{ appt.price ? formatARS(appt.price) : '—' }}</div>
          </div>
        </div>

        <div class="mt-4 flex flex-wrap items-end gap-3">
          <div class="flex flex-col gap-1">
            <label class="text-xs font-semibold text-neutral" :for="`pay-${appt.id}`">
              {{ label({ es: 'Pago (ARS)', en: 'Payment (ARS)' }) }}
            </label>
            <input
              :id="`pay-${appt.id}`"
              v-model="amounts[appt.id]"
              type="text"
              inputmode="decimal"
              :disabled="!canSettle(appt)"
              class="w-36 rounded-md border border-border bg-card px-3 py-2 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-accent disabled:bg-surface disabled:text-neutral"
            />
          </div>
          <AppButton variant="primary" :loading="processing[appt.id]" :disabled="!canSettle(appt)" @click="settle(appt, 'paid')">
            {{ label({ es: 'Pagó', en: 'Paid' }) }}
          </AppButton>
          <AppButton variant="neutral" :disabled="processing[appt.id] || !canSettle(appt)" @click="settle(appt, 'unpaid')">
            {{ label({ es: 'No pagó', en: 'Not paid' }) }}
          </AppButton>
          <AppButton variant="neutral" :disabled="processing[appt.id] || !canSettle(appt)" @click="settle(appt, 'absent')">
            {{ label({ es: 'No asistió', en: 'No-show' }) }}
          </AppButton>
          <p v-if="!canSettle(appt)" class="text-xs text-neutral">
            {{ label({ es: 'El turno todavía no empezó.', en: 'The appointment hasn’t started yet.' }) }}
          </p>
        </div>
      </div>
    </div>

    <template v-if="role === 'Professional'">
      <div v-if="loadingPro">
        <Skeleton variant="tile" :rows="2" />
      </div>
      <div v-else class="grid grid-cols-1 gap-6 md:grid-cols-2">
        <div class="rounded-lg border border-border bg-card p-5">
          <h2 class="text-lg font-semibold text-heading mb-3">
            {{ label({ es: 'Próximos turnos', en: 'Upcoming appointments' }) }}
          </h2>
          <ul v-if="proUpcoming.length" class="space-y-2">
            <li
              v-for="appt in proUpcoming"
              :key="appt.id"
              class="text-sm text-neutral border-b border-border pb-2 last:border-0 last:pb-0"
            >
              <span class="font-semibold text-heading">{{ formatDateTime(appt.starts_at) }}</span>
              <span class="ml-2">{{ apptLabel(appt) }}</span>
            </li>
          </ul>
          <EmptyState
            v-else
            :heading="label({ es: 'Sin turnos próximos', en: 'No upcoming appointments' })"
            body=""
          />
        </div>

        <div class="rounded-lg border border-border bg-card p-5">
          <h2 class="text-lg font-semibold text-heading mb-3">
            {{ label({ es: 'Solicitudes pendientes', en: 'Pending requests' }) }}
          </h2>
          <ul v-if="proPending.length" class="space-y-2">
            <li
              v-for="appt in proPending"
              :key="appt.id"
              class="text-sm text-neutral border-b border-border pb-2 last:border-0 last:pb-0"
            >
              <span class="font-semibold text-heading">{{ formatDateTime(appt.starts_at) }}</span>
              <span class="ml-2">{{ apptLabel(appt) }}</span>
            </li>
          </ul>
          <EmptyState
            v-else
            :heading="label({ es: 'Sin solicitudes', en: 'No pending requests' })"
            body=""
          />
        </div>
      </div>
    </template>

    <template v-else-if="role === 'Receptionist'">
      <div v-if="loadingRec">
        <Skeleton variant="tile" :rows="2" />
      </div>
      <div v-else class="grid grid-cols-1 gap-6 md:grid-cols-2">
        <div class="rounded-lg border border-border bg-card p-5">
          <h2 class="text-lg font-semibold text-heading mb-3">
            {{ label({ es: 'Turnos de hoy', en: "Today's appointments" }) }}
            <span class="ml-2 text-sm text-neutral">({{ recToday.length }})</span>
          </h2>
          <ul v-if="recToday.length" class="space-y-2 max-h-64 overflow-y-auto">
            <li
              v-for="appt in recToday"
              :key="appt.id"
              class="text-sm text-neutral border-b border-border pb-2 last:border-0 last:pb-0"
            >
              <span class="font-semibold text-heading">{{ formatDateTime(appt.starts_at) }}</span>
              <span class="ml-2">{{ apptLabel(appt) }}</span>
            </li>
          </ul>
          <EmptyState v-else :heading="label({ es: 'Sin turnos hoy', en: 'No appointments today' })" body="" />
        </div>

        <div class="rounded-lg border border-border bg-card p-5">
          <h2 class="text-lg font-semibold text-heading mb-3">
            {{ label({ es: 'Solicitudes a gestionar', en: 'Requests to triage' }) }}
            <span class="ml-2 text-sm text-neutral">({{ recPending.length }})</span>
          </h2>
          <ul v-if="recPending.length" class="space-y-2 max-h-48 overflow-y-auto">
            <li
              v-for="appt in recPending"
              :key="appt.id"
              class="text-sm text-neutral border-b border-border pb-2 last:border-0 last:pb-0"
            >
              <span class="font-semibold text-heading">{{ formatDateTime(appt.starts_at) }}</span>
              <span class="ml-2">{{ apptLabel(appt) }}</span>
            </li>
          </ul>
          <EmptyState v-else :heading="label({ es: 'Sin solicitudes pendientes', en: 'No pending requests' })" body="" />

          <div class="mt-4">
            <AppButton variant="primary" @click="router.push('/staff/calendar')">
              {{ t('actions.newAppointment') }}
            </AppButton>
          </div>
        </div>
      </div>
    </template>

    <template v-else-if="role === 'Admin'">
      <div v-if="loadingAdmin">
        <Skeleton variant="tile" :rows="3" />
      </div>
      <div v-else>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-3 mb-6">
          <div class="rounded-lg border border-border bg-card p-4 text-center">
            <div class="text-3xl font-semibold text-heading tabular-nums">{{ adminToday.length }}</div>
            <div class="mt-1 text-sm text-neutral">{{ label({ es: 'Turnos hoy', en: 'Appointments today' }) }}</div>
          </div>
          <div class="rounded-lg border border-border bg-card p-4 text-center">
            <div class="text-3xl font-semibold text-heading tabular-nums">{{ adminPending.length }}</div>
            <div class="mt-1 text-sm text-neutral">{{ label({ es: 'Solicitudes pendientes', en: 'Pending requests' }) }}</div>
          </div>
          <div class="rounded-lg border border-border bg-card p-4 text-center">
            <div class="text-3xl font-semibold text-heading tabular-nums">{{ recentAudit.length }}</div>
            <div class="mt-1 text-sm text-neutral">{{ label({ es: 'Eventos recientes', en: 'Recent audit events' }) }}</div>
          </div>
        </div>

        <div class="mb-6 flex flex-wrap gap-3">
          <AppButton variant="neutral" @click="router.push('/staff/users')">
            {{ label({ es: 'Usuarios', en: 'Users' }) }}
          </AppButton>
          <AppButton variant="neutral" @click="router.push('/staff/settings')">
            {{ label({ es: 'Configuración', en: 'Settings' }) }}
          </AppButton>
          <AppButton variant="neutral" @click="router.push('/staff/audit')">
            {{ label({ es: 'Ver auditoría', en: 'View audit log' }) }}
          </AppButton>
        </div>

        <div class="rounded-lg border border-border bg-card p-5">
          <h2 class="text-lg font-semibold text-heading mb-3">
            {{ label({ es: 'Actividad reciente', en: 'Recent activity' }) }}
          </h2>
          <ul v-if="recentAudit.length" class="space-y-2">
            <li
              v-for="event in recentAudit"
              :key="event.id"
              class="flex items-center justify-between text-sm border-b border-border pb-2 last:border-0 last:pb-0"
            >
              <span class="text-neutral">{{ formatDateTime(event.created_at) }}</span>
              <span class="font-mono text-xs text-heading">{{ event.event_type }}</span>
              <span
                class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold"
                :class="{
                  'bg-green-100 text-success':   event.outcome === 'success',
                  'bg-red-100 text-destructive': event.outcome === 'denied',
                  'bg-yellow-100 text-warning':  event.outcome === 'failure',
                }"
              >
                {{ event.outcome }}
              </span>
            </li>
          </ul>
          <EmptyState v-else :heading="label({ es: 'Sin actividad reciente', en: 'No recent activity' })" body="" />
        </div>
      </div>
    </template>
  </div>
</template>

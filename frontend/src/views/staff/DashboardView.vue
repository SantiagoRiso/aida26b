<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { listAppointments, transitionAppointment, approveAppointment, ignoreAppointmentConflict } from '@/api/appointments';
import { createEntry } from '@/api/ledger';
import { listAudit } from '@/api/audit';
import type { Appointment } from '@/api/appointments';
import type { AuditEvent } from '@/api/audit';
import { useCurrency } from '@/composables/useCurrency';
import { useLabel } from '@/composables/useLabel';
import { useStateLabel } from '@/composables/useStateLabel';
import { useToast } from '@/composables/useToast';
import { useConflictOverride } from '@/composables/useConflictOverride';
import { useForeignKeyOptions } from '@/composables/useForeignKeyOptions';
import { isCurrent, canSettle as canSettleAt, transitionFor, showsCurrentCard } from '@/views/staff/dashboard-current';
import type { SettleAction } from '@/views/staff/dashboard-current';
import Skeleton from '@/components/shared/Skeleton.vue';
import EmptyState from '@/components/shared/EmptyState.vue';
import AppButton from '@/components/shared/AppButton.vue';
import ConfirmDialog from '@/components/shared/ConfirmDialog.vue';
import ConflictOverrideDialog from '@/components/calendar/ConflictOverrideDialog.vue';

const { t } = useI18n();
const auth = useAuthStore();
const router = useRouter();
const { formatDateTime, formatARS } = useCurrency();
const { label } = useLabel();
const { stateLabel } = useStateLabel();
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
      state: 'requested',
      limit: 5,
    }),
  ]);
  if (upcomingRes.ok) proUpcoming.value = upcomingRes.data.slice(0, 5);
  if (pendingRes.ok) proPending.value = pendingRes.data;
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
    listAppointments({ state: 'requested', limit: 5 }),
  ]);
  if (todayRes.ok) recToday.value = todayRes.data;
  if (pendingRes.ok) recPending.value = pendingRes.data;
  loadingRec.value = false;
}

// Stat tiles show totals, so they read the server's count (meta.total), not a capped page length.
const adminTodayCount = ref(0);
const adminPendingCount = ref(0);
const recentAudit = ref<AuditEvent[]>([]);
const loadingAdmin = ref(false);

async function loadAdmin() {
  loadingAdmin.value = true;
  const [todayRes, pendingRes, auditRes] = await Promise.all([
    listAppointments({
      date_from: todayStart.toISOString().slice(0, 10),
      date_to: todayEnd.toISOString().slice(0, 10),
      limit: 1,
    }),
    listAppointments({ state: 'requested', limit: 1 }),
    listAudit({}, 1, 5),
  ]);
  if (todayRes.ok) adminTodayCount.value = todayRes.meta?.total ?? 0;
  if (pendingRes.ok) adminPendingCount.value = pendingRes.meta?.total ?? 0;
  if (auditRes.ok) recentAudit.value = auditRes.data;
  loadingAdmin.value = false;
}

// Open, future turnos that now overlap active time-off (a closure or the professional's licencia).
// Server role-scopes the list; every staff role sees the ones they own so nobody's conflicts hide.
const conflictTurnos = ref<Appointment[]>([]);
const conflictTotal = ref(0);

async function loadConflicts() {
  const res = await listAppointments({ conflicting: true, limit: 50 });
  if (res.ok) {
    conflictTurnos.value = res.data;
    conflictTotal.value = res.meta?.total ?? res.data.length;
  }
}

const conflictBusy = ref<Record<string, boolean>>({});
// A pending turno is denied (rejected); a booked one is canceled — same destructive confirm, two verbs.
const resolveTarget = ref<{ appt: Appointment; to: 'canceled' | 'rejected' } | null>(null);

// Accept the turno as-is: it stays booked but stops being flagged (reversible from the calendar).
async function ignoreConflict(appt: Appointment) {
  conflictBusy.value[appt.id] = true;
  const res = await ignoreAppointmentConflict(appt.id, true);
  conflictBusy.value[appt.id] = false;
  if (res.ok) await loadConflicts();
  else toast.error('genericError');
}

// Rescheduling needs the calendar's slot UI; send them there to move it off the time-off.
function goReschedule() {
  router.push('/staff/calendar');
}

async function confirmResolve() {
  const target = resolveTarget.value;
  resolveTarget.value = null;
  if (!target) return;
  const res = await transitionAppointment(target.appt.id, target.to);
  if (res.ok) await loadConflicts();
  else toast.error('genericError');
}

// Approving a conflicting request books it over the time-off — the same conflict-aware path the
// calendar uses, so an availability conflict surfaces the override dialog rather than failing silently.
const { conflictOpen, conflictVerdict, conflictRevert, raiseConflict, onOverrideConfirm, onOverrideCancel } =
  useConflictOverride();

async function approveConflict(appt: Appointment, override = false) {
  const res = await approveAppointment(appt.id, override);
  if (!res.ok) { toast.error('genericError'); return; }
  if (!res.data.saved) {
    raiseConflict(res.data.verdict, (ov: boolean) => approveConflict(appt, ov));
  } else {
    await loadConflicts();
  }
}

onMounted(() => {
  if (role.value === 'Professional') loadProfessional();
  else if (role.value === 'Receptionist') loadReceptionist();
  else if (role.value === 'Admin') loadAdmin();
  if (role.value !== 'Client') void loadConflicts();
  if (showsCard.value) {
    void loadCurrent();
    // Re-evaluate the card window as time passes so cards appear on their own.
    nowTimer = window.setInterval(() => { now.value = new Date(); }, 30_000);
    // New bookings must surface without a page reload.
    refetchTimer = window.setInterval(() => { void loadCurrent(); }, 60_000);
  }
});

onBeforeUnmount(() => {
  if (nowTimer !== undefined) window.clearInterval(nowTimer);
  if (refetchTimer !== undefined) window.clearInterval(refetchTimer);
});

// Untitled appointments read as the client's name, not an opaque "Turno #id".
const { labelFor: clientLabelFor } = useForeignKeyOptions({
  table: 'clients', valueField: 'id', labelField: 'display_name',
});
function apptLabel(appt: Appointment): string {
  if (appt.name) return appt.name;
  return clientLabelFor(appt.client_user_id) ?? `Turno #${appt.id}`;
}

// Pending requests are triaged by who's asking, so they show the client (name-first; the
// free-text request title is noise here) plus DNI to disambiguate same-named clients.
const { labelFor: clientDniFor } = useForeignKeyOptions({
  table: 'clients', valueField: 'id', labelField: 'dni',
});
function pendingClientName(appt: Appointment): string {
  return clientLabelFor(appt.client_user_id) ?? appt.name ?? `Turno #${appt.id}`;
}

// Current-appointment settle card. Visible to the session's own professional and to
// receptionists (server scopes their list to granted calendars); admins never see it.
const { labelFor: serviceLabelFor } = useForeignKeyOptions({
  table: 'services', valueField: 'id', labelField: 'name',
});
const showsCard = computed(() => role.value === 'Professional' || role.value === 'Receptionist');

const settleCandidates = ref<Appointment[]>([]);
const now = ref(new Date());
let nowTimer: number | undefined;
let refetchTimer: number | undefined;
const amounts = ref<Record<string, string>>({});
const processing = ref<Record<string, boolean>>({});

const currentAppointments = computed(() =>
  settleCandidates.value
    .filter((a) => showsCurrentCard(auth.user, a) && isCurrent(a, now.value))
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at)),
);

function canSettle(appt: Appointment): boolean {
  return canSettleAt(appt, now.value);
}

// Cards never expire, so recently-forgotten unresolved sessions must surface too.
// 7 days back is the product knob for "recent"; anything older is stale noise.
const LOOKBACK_DAYS = 7;

async function loadCurrent() {
  // Full local day as ISO bounds — a bare date as date_to resolves to that day's midnight and
  // would exclude the whole day (the filter compares starts_at directly).
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  from.setDate(from.getDate() - LOOKBACK_DAYS);
  const to = new Date();
  to.setHours(23, 59, 59, 999);
  const res = await listAppointments({
    date_from: from.toISOString(),
    date_to: to.toISOString(),
    // Only unresolved turnos can hold a card; don't spend the page budget on settled ones.
    state: 'scheduled',
    limit: 200,
  });
  if (!res.ok) return;
  settleCandidates.value = res.data;
  for (const a of settleCandidates.value) {
    if (!(a.id in amounts.value)) amounts.value[a.id] = a.price ?? '';
  }
}

function serviceNameFor(appt: Appointment): string | null {
  return serviceLabelFor(appt.service_id);
}

// Receptionists see many professionals' turnos — each row must say whose it is.
const { labelFor: professionalLabelFor } = useForeignKeyOptions({
  table: 'professionals', valueField: 'id', labelField: 'display_name',
});
function professionalNameFor(appt: Appointment): string | null {
  return professionalLabelFor(appt.professional_user_id);
}

// Registering attendance completes the turno (the backend posts the session charge once);
// "paid" additionally records the payment. "absent" marks a no_show and never charges.
async function settle(appt: Appointment, action: SettleAction) {
  processing.value[appt.id] = true;
  try {
    const res = await transitionAppointment(appt.id, transitionFor(action));
    if (!res.ok) {
      toast.error(res.code === 'too_early' ? 'completeTooEarly' : 'genericError');
      return;
    }

    if (action === 'paid') {
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
  <div>
    <h1 class="text-2xl font-semibold mb-6">
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
              <span v-if="role === 'Receptionist' && professionalNameFor(appt)"> · {{ professionalNameFor(appt) }}</span>
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
            {{ stateLabel('no_show') }}
          </AppButton>
          <p v-if="!canSettle(appt)" class="text-xs text-neutral">
            {{ label({ es: 'El turno todavía no empezó.', en: 'The appointment hasn’t started yet.' }) }}
          </p>
        </div>
      </div>
    </div>

    <div v-if="conflictTurnos.length" class="mb-6 rounded-lg border-2 border-destructive bg-card p-5">
      <h2 class="text-lg font-semibold text-heading">
        {{ label({ es: 'Turnos en conflicto', en: 'Appointments in conflict' }) }}
        <span class="ml-2 text-sm font-normal text-destructive">({{ conflictTotal }})</span>
      </h2>
      <p class="mt-1 text-sm text-neutral">
        {{ label({ es: 'Se superponen con una licencia o feriado. Reprogramá o cancelá cada uno.', en: 'These overlap time off or a holiday. Reschedule or cancel each one.' }) }}
      </p>
      <ul class="mt-3 max-h-72 space-y-2 overflow-y-auto">
        <li
          v-for="appt in conflictTurnos"
          :key="appt.id"
          class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border pb-2 text-sm last:border-0 last:pb-0"
        >
          <span class="flex flex-wrap items-center gap-2">
            <span class="font-semibold text-heading">{{ formatDateTime(appt.starts_at) }}</span>
            <span>{{ apptLabel(appt) }}</span>
            <span v-if="role !== 'Professional' && professionalNameFor(appt)" class="text-neutral">
              · {{ professionalNameFor(appt) }}
            </span>
          </span>
          <span class="flex items-center gap-3 text-xs font-semibold">
            <button type="button" class="text-neutral hover:underline disabled:opacity-50" :disabled="conflictBusy[appt.id]" @click="ignoreConflict(appt)">
              {{ label({ es: 'Ignorar', en: 'Ignore' }) }}
            </button>
            <button v-if="appt.state === 'requested'" type="button" class="text-success hover:underline" @click="approveConflict(appt)">
              {{ label({ es: 'Aprobar', en: 'Approve' }) }}
            </button>
            <button type="button" class="text-accent hover:underline" @click="goReschedule">
              {{ label({ es: 'Reprogramar', en: 'Reschedule' }) }}
            </button>
            <button
              type="button"
              class="text-destructive hover:underline"
              @click="resolveTarget = { appt, to: appt.state === 'requested' ? 'rejected' : 'canceled' }"
            >
              {{ appt.state === 'requested' ? label({ es: 'Denegar', en: 'Deny' }) : label({ es: 'Cancelar', en: 'Cancel' }) }}
            </button>
          </span>
        </li>
      </ul>
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
              <span class="ml-2">{{ pendingClientName(appt) }}</span>
              <span v-if="clientDniFor(appt.client_user_id)" class="ml-2 text-xs">
                DNI {{ clientDniFor(appt.client_user_id) }}
              </span>
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
              <span v-if="professionalNameFor(appt)" class="ml-2">· {{ professionalNameFor(appt) }}</span>
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
            <div class="text-3xl font-semibold text-heading tabular-nums">{{ adminTodayCount }}</div>
            <div class="mt-1 text-sm text-neutral">{{ label({ es: 'Turnos hoy', en: 'Appointments today' }) }}</div>
          </div>
          <div class="rounded-lg border border-border bg-card p-4 text-center">
            <div class="text-3xl font-semibold text-heading tabular-nums">{{ adminPendingCount }}</div>
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

    <ConfirmDialog
      :open="resolveTarget !== null"
      :title="resolveTarget?.to === 'rejected'
        ? label({ es: 'Denegar solicitud', en: 'Deny request' })
        : label({ es: 'Cancelar turno', en: 'Cancel appointment' })"
      :body="resolveTarget?.to === 'rejected'
        ? label({ es: '¿Denegar esta solicitud en conflicto?', en: 'Deny this conflicting request?' })
        : label({ es: '¿Cancelar este turno en conflicto?', en: 'Cancel this conflicting appointment?' })"
      :confirm-label="resolveTarget?.to === 'rejected'
        ? label({ es: 'Denegar', en: 'Deny' })
        : label({ es: 'Cancelar turno', en: 'Cancel appointment' })"
      destructive
      @confirm="confirmResolve"
      @cancel="resolveTarget = null"
    />

    <ConflictOverrideDialog
      :open="conflictOpen"
      :verdict="conflictVerdict"
      :revert="conflictRevert"
      @confirm="onOverrideConfirm"
      @cancel="onOverrideCancel"
    />
  </div>
</template>

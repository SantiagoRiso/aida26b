<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useStateLabel } from '@/composables/useStateLabel';
import { useCurrency } from '@/composables/useCurrency';
import { useToast } from '@/composables/useToast';
import { useConflictOverride } from '@/composables/useConflictOverride';
import { useForeignKeyOptions } from '@/composables/useForeignKeyOptions';
import { getRow } from '@/api/crud';
import { getBalance } from '@/api/ledger';
import { getAvailability } from '@/api/scheduling';
import { listAppointments, approveAppointment, transitionAppointment } from '@/api/appointments';
import type { Appointment } from '@/api/appointments';
import { toMinutes } from '@shared/ssot/domain/availability';
import { structure } from '@shared/ssot/structure';
import { nextDay } from '@/composables/scheduleExceptions';
import type { TableRecordMap } from '@shared/ssot/derived';
import { useLabel } from '@/composables/useLabel';
import { useAppointmentCalendar } from '@/composables/useFullCalendar';
import { fetchProfessionalBlocks } from '@/composables/useProfessionalBlocks';
import type { ProfessionalBlock } from '@/composables/useProfessionalBlocks';
import { dayISO, bookedIntervalsByDate, availabilityWashEvents, pastWashEvent, slotOutlineEventsForDay } from '@/composables/availabilityShading';
import type { AuthUser } from '@/stores/auth';
import type { EventContentArg, EventInput } from '@fullcalendar/core';
import AppButton from '@/components/shared/AppButton.vue';
import Skeleton from '@/components/shared/Skeleton.vue';
import EmptyState from '@/components/shared/EmptyState.vue';
import DetailPanel from '@/components/shared/DetailPanel.vue';
import CalendarView from '@/components/calendar/CalendarView.vue';
import ConfirmDialog from '@/components/shared/ConfirmDialog.vue';
import ConflictOverrideDialog from '@/components/calendar/ConflictOverrideDialog.vue';
import ProfessionalPicker from '@/components/schedule/ProfessionalPicker.vue';

// The server scopes /appointments by role (Admin: all, Professional: own,
// Receptionist: granted), so the requested rows returned here already respect
// who may see which requests.
const { t, locale } = useI18n();
const { stateLabel } = useStateLabel();
const { formatDateTime, formatARS } = useCurrency();
const { label } = useLabel();
const toast = useToast();
const appointmentColumns = structure.tables.appointments.columns;

const requests = ref<Appointment[]>([]);
const loading = ref(false);
const acting = ref(false);

async function load() {
  loading.value = true;
  const res = await listAppointments({ state: 'requested', limit: 200 });
  loading.value = false;
  if (res.ok) {
    requests.value = res.data
      .slice()
      .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime());
  }
}
onMounted(load);

// Filter the already-loaded (role-scoped) list by professional, client-side — no refetch. The
// picker self-hides unless more than one professional is in scope, so a Professional / single-grant
// Receptionist never sees it and keeps their full list (which is already only their requests).
const selectedProfessionalId = ref<number | null>(null);
const clientQuery = ref('');
const filteredRequests = computed(() => {
  const sel = selectedProfessionalId.value;
  const query = clientQuery.value.trim().toLocaleLowerCase(locale.value);
  // Wire rows serialize ids as strings, so compare as strings (a strict number === always misses).
  return requests.value.filter((a) => {
    if (sel != null && String(a.professional_user_id) !== String(sel)) return false;
    if (!query) return true;
    return clientName(a).toLocaleLowerCase(locale.value).includes(query)
      || (clientDniFor(a.client_user_id) ?? '').toLocaleLowerCase(locale.value).includes(query);
  });
});

const { labelFor: clientLabelFor } = useForeignKeyOptions({ table: 'clients', valueField: 'id', labelField: 'display_name' });
const { labelFor: clientDniFor } = useForeignKeyOptions({ table: 'clients', valueField: 'id', labelField: 'dni' });
const { labelFor: professionalLabelFor } = useForeignKeyOptions({ table: 'professionals', valueField: 'id', labelField: 'display_name' });
const { labelFor: serviceLabelFor } = useForeignKeyOptions({ table: 'services', valueField: 'id', labelField: 'name' });
const { labelFor: resourceLabelFor } = useForeignKeyOptions({ table: 'resources', valueField: 'id', labelField: 'name' });

function clientName(a: Appointment): string {
  return clientLabelFor(a.client_user_id) ?? a.name ?? t('portal.appointmentFallback', { id: a.id });
}
function professionalName(a: Appointment): string {
  return professionalLabelFor(a.professional_user_id) ?? '—';
}
function serviceName(a: Appointment): string {
  return serviceLabelFor(a.service_id) ?? '—';
}
function resourceName(a: Appointment): string | null {
  return resourceLabelFor(a.resource_id);
}

// Detail drawer: full client context so a request can be triaged without leaving the list.
const detailAppt = ref<Appointment | null>(null);
const detailOpen = ref(false);
const clientProfile = ref<TableRecordMap['clients'] | null>(null);
const clientBalance = ref<string | null>(null);
const clientAppts = ref<Appointment[]>([]);
const loadingDetail = ref(false);

// The professional's whole day around the requested slot — shown as a read-only day calendar
// so the request can be judged against that day's existing schedule.
const dayAppts = ref<Appointment[]>([]);
// That day's free windows + working blocks, to reproduce the main calendar's availability
// background (off-hours hatch, occupied/requested washes, free-slot outlines) around the request.
const dayFreeSlots = ref<{ start: number; end: number }[]>([]);
const dayBlocks = ref<ProfessionalBlock[]>([]);

const dayHeading = computed(() => {
  const appt = detailAppt.value;
  if (!appt) return '';
  const d = new Date(`${appt.starts_at.slice(0, 10)}T00:00:00`);
  const weekday = d.toLocaleDateString(locale.value === 'en' ? 'en-US' : 'es-AR', { weekday: 'long' });
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${weekday} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
});

async function openDetail(appt: Appointment) {
  detailAppt.value = appt;
  detailOpen.value = true;
  clientProfile.value = null;
  clientBalance.value = null;
  clientAppts.value = [];
  dayAppts.value = [];
  dayFreeSlots.value = [];
  dayBlocks.value = [];
  const cid = appt.client_user_id;
  loadingDetail.value = true;
  const day = appt.starts_at.slice(0, 10);
  // Ledger reads are allowed for anyone who can see the request (the request itself is the
  // relationship). The appointment history is the caller's own scoped view of this client.
  // The professional's availability + working blocks drive the day calendar's background shading.
  const [prof, bal, appts, proDay, avail, blocks] = await Promise.all([
    cid != null ? getRow('clients', cid) : Promise.resolve(null),
    cid != null ? getBalance(cid) : Promise.resolve(null),
    cid != null ? listAppointments({ client_user_id: cid, limit: 500 }) : Promise.resolve(null),
    listAppointments({
      professional_user_id: appt.professional_user_id,
      date_from: day,
      date_to: nextDay(day),
      limit: 200,
    }),
    getAvailability(`prof:${appt.professional_user_id}`, day),
    fetchProfessionalBlocks(appt.professional_user_id),
  ]);
  if (prof && prof.ok) clientProfile.value = prof.data;
  clientBalance.value = bal && bal.ok ? bal.data.balance_ars : null;
  clientAppts.value = appts && appts.ok ? appts.data : [];
  dayAppts.value = proDay.ok ? proDay.data : [];
  dayFreeSlots.value = avail.ok
    ? avail.data.slots.map((s) => ({ start: toMinutes(s.start), end: toMinutes(s.end) }))
    : [];
  dayBlocks.value = blocks;
  loadingDetail.value = false;
}

function closeDetail() {
  detailOpen.value = false;
}

// Clear the loaded data only after the close animation, so the panel keeps its content
// through the leave transition instead of blanking mid-close.
function onDetailAfterLeave() {
  detailAppt.value = null;
  clientProfile.value = null;
  clientBalance.value = null;
  clientAppts.value = [];
  dayAppts.value = [];
  dayFreeSlots.value = [];
  dayBlocks.value = [];
}

// Reproduce the staff calendar's availability background for the request's day and professional:
// off-hours grey hatch, occupied/requested washes, a flat past wash, and dotted free-slot outlines.
// Same classNames as the main calendar — styled by CalendarView's own scoped CSS.
const dayBgEvents = computed<EventInput[]>(() => {
  const appt = detailAppt.value;
  if (!appt) return [];
  const day = appt.starts_at.slice(0, 10);

  const now = new Date();
  const today = dayISO(now, 0);
  // Past time reads plain grey; here "past" transitions at the exact current minute (this view has
  // no slot lattice to floor to).
  const floor = day === today ? now.getHours() * 60 + now.getMinutes() : 0;
  const past = pastWashEvent(day, today, floor);
  const out: EventInput[] = past ? [past] : [];
  // A fully past day can't be booked — grey the whole column and skip the availability shading.
  if (day < today) return out;

  const booked = bookedIntervalsByDate(dayAppts.value).get(day) ?? { occupied: [], requested: [] };
  out.push(...availabilityWashEvents(day, dayFreeSlots.value, booked, floor));

  const taken = [...booked.occupied, ...booked.requested];
  out.push(...slotOutlineEventsForDay(day, dayBlocks.value,
    (s, e) => s >= floor && !taken.some((k) => s < k.end && k.start < e)));
  return out;
});

// Read-only day calendar for the request's professional + date. Null viewer keeps it
// non-editable; a fresh :key per request re-applies initialDate on open.
const nullViewer = ref<AuthUser | null>(null);
const { calendarOptions: dayCalendarBase } = useAppointmentCalendar(
  dayAppts,
  nullViewer,
  { onSelect: () => {}, onEventClick: () => {}, onEventDrop: () => {}, onEventResize: () => {} },
  {
    fallbackTitle: (a) => clientLabelFor(a.client_user_id),
    tooltip: (a) => [
      a.name || clientName(a),
      `${formatDateTime(a.starts_at)} - ${a.duration_minutes} min`,
      `${t('calendar.clientLabel')}: ${clientName(a)}`,
      `${t('calendar.professionalLabel')}: ${professionalName(a)}`,
      `${t('calendar.resourceLabel')}: ${resourceName(a) ?? '-'}`,
      `${t('calendar.serviceLabel')}: ${serviceName(a)}`,
      `${t('calendar.priceLabel')}: ${formatARS(a.price)}`,
      `${t('portal.state')}: ${stateLabel(a.state)}`,
      ...(a.override_conflict ? [`${t('calendar.fineMode')}: ${t('generic.yes')}`] : []),
    ].join('\n'),
    compactContent: (a) => ({
      client: clientLabelFor(a.client_user_id),
      resource: resourceName(a),
      service: serviceName(a),
    }),
  },
);
const dayCalendarOptions = computed(() => ({
  ...dayCalendarBase.value,
  initialView: 'timeGridDay',
  initialDate: detailAppt.value ? detailAppt.value.starts_at.slice(0, 10) : undefined,
  events: [
    ...((dayCalendarBase.value.events as EventInput[]) ?? []),
    ...dayBgEvents.value,
  ],
  headerToolbar: false as const,
  // The single day column's header carries the request's weekday + date (e.g. "miércoles 15/07"),
  // so it doesn't need to sit in the panel title.
  dayHeaderContent: () => dayHeading.value,
  // Let the modal own vertical scrolling. A fixed calendar height makes FullCalendar add a second,
  // nested scroller for the time grid.
  height: 'auto' as const,
  expandRows: false,
  selectable: false,
  editable: false,
  eventClassNames: (arg: EventContentArg) =>
    detailAppt.value && arg.event.id === String(detailAppt.value.id) ? ['fc-current-request'] : [],
}));

const balancePositive = computed(
  () => clientBalance.value != null && parseFloat(clientBalance.value) > 0,
);
const detailHistory = computed(() =>
  [...clientAppts.value].sort((a, b) => b.starts_at.localeCompare(a.starts_at)),
);
const canceledCount = computed(() => clientAppts.value.filter((a) => a.state === 'canceled').length);
const noShowCount = computed(() => clientAppts.value.filter((a) => a.state === 'no_show').length);
const completedCount = computed(() => clientAppts.value.filter((a) => a.state === 'completed').length);

// Approve routes through the conflict-aware endpoint: a full slot warns first (override)
// instead of silently failing — same warn-then-confirm flow as the calendar.
const { conflictOpen, conflictVerdict, raiseConflict, onOverrideConfirm, onOverrideCancel } =
  useConflictOverride();

async function approve(appt: Appointment, override = false) {
  acting.value = true;
  const result = await approveAppointment(appt.id, override);
  acting.value = false;
  if (!result.ok) {
    toast.error('genericError');
    return;
  }
  const payload = result.data;
  if (!payload.saved) {
    raiseConflict(payload.verdict, (ov) => approve(appt, ov));
    return;
  }
  toast.success('requestApproved');
  closeDetail();
  await load();
}

const rejectTarget = ref<Appointment | null>(null);
async function confirmReject() {
  const appt = rejectTarget.value;
  rejectTarget.value = null;
  if (!appt) return;
  acting.value = true;
  const result = await transitionAppointment(appt.id, 'rejected');
  acting.value = false;
  if (result.ok) {
    toast.success('requestRejected');
    closeDetail();
    await load();
  } else {
    toast.error('genericError');
  }
}
</script>

<template>
  <div>
    <h1 class="text-2xl font-semibold mb-6">
      {{ t('nav.requests') }}
    </h1>

    <div class="mb-6 flex flex-wrap items-end gap-4">
      <ProfessionalPicker allow-all v-model="selectedProfessionalId" />
      <label class="flex min-w-[220px] flex-col gap-1 text-sm">
        <span class="font-medium text-neutral">{{ t('calendar.clientLabel') }}</span>
        <input
          v-model="clientQuery"
          type="search"
          :placeholder="t('clients.searchPlaceholder')"
          class="w-64 rounded-md border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        />
      </label>
    </div>

    <div v-if="loading">
      <Skeleton variant="row" :rows="4" />
    </div>

    <EmptyState
      v-else-if="filteredRequests.length === 0"
      :heading="t('requests.emptyHeading')"
      :body="t('requests.emptyBody')"
    />

    <ul v-else class="space-y-3">
      <li
        v-for="appt in filteredRequests"
        :key="appt.id"
        class="cursor-pointer rounded-lg border border-border bg-card p-4 transition-colors hover:border-accent/50 hover:bg-accent/5"
        role="button"
        tabindex="0"
        @click="openDetail(appt)"
        @keydown.enter="openDetail(appt)"
      >
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div class="flex-1 space-y-1">
            <p class="text-sm font-semibold text-heading">{{ clientName(appt) }}</p>
            <p class="text-sm text-neutral">
              {{ formatDateTime(appt.starts_at) }} · {{ appt.duration_minutes }} min
            </p>
            <p class="text-sm text-neutral">
              {{ professionalName(appt) }}<span v-if="resourceName(appt)"> · {{ resourceName(appt) }}</span> · {{ serviceName(appt) }}
            </p>
            <p class="text-xs text-neutral">{{ formatARS(appt.price) }}</p>
          </div>

          <div class="flex flex-shrink-0 gap-2">
            <AppButton variant="primary" :loading="acting" @click.stop="approve(appt)">
              {{ t('calendar.approve') }}
            </AppButton>
            <AppButton variant="destructive" :disabled="acting" @click.stop="rejectTarget = appt">
              {{ t('calendar.reject') }}
            </AppButton>
          </div>
        </div>
      </li>
    </ul>

    <DetailPanel
      :open="detailOpen"
      :title="t('requests.detailTitle')"
      size="5xl"
      @close="closeDetail"
      @after-leave="onDetailAfterLeave"
    >
      <div v-if="detailAppt" class="flex flex-col gap-5">
        <div class="grid gap-6 lg:grid-cols-2">
          <div class="flex flex-col gap-5">
        <section class="flex flex-col gap-2">
          <h3 class="text-sm font-semibold text-neutral">{{ t('requests.requestHeading') }}</h3>
          <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt class="text-neutral">{{ t('calendar.dateLabel') }}</dt>
            <dd>{{ formatDateTime(detailAppt.starts_at) }} · {{ detailAppt.duration_minutes }} min</dd>
            <dt class="text-neutral">{{ t('calendar.professionalLabel') }}</dt>
            <dd>{{ professionalName(detailAppt) }}</dd>
            <dt class="text-neutral">{{ t('calendar.serviceLabel') }}</dt>
            <dd>{{ serviceName(detailAppt) }}</dd>
            <template v-if="resourceName(detailAppt)">
              <dt class="text-neutral">{{ t('calendar.resourceLabel') }}</dt>
              <dd>{{ resourceName(detailAppt) }}</dd>
            </template>
            <dt class="text-neutral">{{ t('calendar.priceLabel') }}</dt>
            <dd>{{ formatARS(detailAppt.price) }}</dd>
            <template v-if="detailAppt.name">
              <dt class="text-neutral">{{ label(appointmentColumns.name.label) }}</dt>
              <dd>{{ detailAppt.name }}</dd>
            </template>
            <template v-if="detailAppt.description">
              <dt class="text-neutral">{{ label(appointmentColumns.description.label) }}</dt>
              <dd class="whitespace-pre-line">{{ detailAppt.description }}</dd>
            </template>
          </dl>
        </section>

        <div v-if="loadingDetail">
          <Skeleton variant="row" :rows="3" />
        </div>

        <template v-else>
          <section class="flex flex-col gap-2 border-t border-border pt-4">
            <h3 class="text-sm font-semibold text-neutral">{{ t('calendar.clientLabel') }}</h3>
            <p class="text-base font-semibold text-heading">{{ clientProfile?.display_name ?? clientName(detailAppt) }}</p>
            <p class="text-sm text-neutral">{{ clientProfile?.email ?? '—' }} · {{ clientProfile?.phone ?? '—' }}</p>
          </section>

          <section class="flex flex-col gap-2">
            <div
              class="flex items-center justify-between rounded-lg border p-3"
              :class="balancePositive ? 'border-destructive bg-red-50' : 'border-border bg-card'"
            >
              <span class="text-sm font-semibold text-heading">{{ t('requests.balanceDebt') }}</span>
              <span
                class="text-lg font-semibold tabular-nums"
                :class="balancePositive ? 'text-destructive' : 'text-success'"
              >
                {{ clientBalance != null ? formatARS(clientBalance) : '—' }}
              </span>
            </div>
          </section>

          <section class="flex flex-col gap-2">
            <h3 class="text-sm font-semibold text-neutral">{{ t('portal.history') }}</h3>
            <div class="flex flex-wrap gap-2 text-xs">
              <span class="rounded-full bg-surface px-2 py-1">{{ t('requests.statAppointments') }}: {{ clientAppts.length }}</span>
              <span class="rounded-full bg-green-100 px-2 py-1 text-success">{{ t('requests.statCompleted') }}: {{ completedCount }}</span>
              <span class="rounded-full bg-red-100 px-2 py-1 text-destructive">{{ t('requests.statCanceled') }}: {{ canceledCount }}</span>
              <span class="rounded-full bg-yellow-100 px-2 py-1 text-warning">{{ t('requests.statNoShows') }}: {{ noShowCount }}</span>
            </div>

            <EmptyState
              v-if="detailHistory.length === 0"
              :heading="t('requests.noPrevious')"
              body=""
            />
            <ul v-else class="divide-y divide-border rounded-lg border border-border">
              <li
                v-for="a in detailHistory"
                :key="a.id"
                class="flex items-center justify-between gap-3 px-3 py-2 text-sm"
              >
                <span class="tabular-nums text-neutral">{{ formatDateTime(a.starts_at) }}</span>
                <span class="flex-1 truncate">
                  {{ serviceName(a) }}<span v-if="resourceName(a)"> · {{ resourceName(a) }}</span> · {{ professionalName(a) }}
                </span>
                <span class="rounded-full bg-surface px-2 py-0.5 text-xs">{{ stateLabel(a.state) }}</span>
              </li>
            </ul>
          </section>
        </template>
          </div>

          <div class="flex flex-col gap-2">
            <h3 class="text-sm font-semibold text-neutral">
              {{ t('requests.daySchedule') }}
            </h3>
            <div class="rounded-lg border border-border">
              <CalendarView :key="detailAppt.id" :options="dayCalendarOptions" />
            </div>
          </div>
        </div>

        <div class="sticky -bottom-6 z-10 -mx-6 -mb-6 flex gap-2 border-t border-border bg-card px-6 py-4">
          <AppButton variant="primary" :loading="acting" class="flex-1" @click="approve(detailAppt)">
            {{ t('calendar.approve') }}
          </AppButton>
          <AppButton variant="destructive" :disabled="acting" class="flex-1" @click="rejectTarget = detailAppt">
            {{ t('calendar.reject') }}
          </AppButton>
        </div>
      </div>
    </DetailPanel>

    <ConfirmDialog
      :open="rejectTarget !== null"
      :title="t('requests.rejectTitle')"
      :body="t('requests.rejectBody')"
      :confirm-label="t('calendar.reject')"
      :destructive="true"
      @confirm="confirmReject"
      @cancel="rejectTarget = null"
    />

    <ConflictOverrideDialog
      :open="conflictOpen"
      :verdict="conflictVerdict"
      @confirm="onOverrideConfirm"
      @cancel="onOverrideCancel"
    />
  </div>
</template>

<style scoped>
/* The request under review: a thick accent border on the event's own box (border-box, so it
   stays INSIDE the block and never bleeds onto the abutting blocks above/below), full opacity,
   and a gentle colour pulse for attention. */
:deep(.fc-current-request) {
  opacity: 1 !important;
  border: 3px solid rgb(37, 99, 235) !important;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.65);
  animation: currentReqPulse 1.5s ease-in-out infinite;
}

@keyframes currentReqPulse {
  0%, 100% { border-color: rgb(37, 99, 235); }
  50% { border-color: rgb(125, 170, 255); }
}
</style>

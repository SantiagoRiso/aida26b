<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useLabel } from '@/composables/useLabel';
import { useCurrency } from '@/composables/useCurrency';
import { useToast } from '@/composables/useToast';
import { useForeignKeyOptions } from '@/composables/useForeignKeyOptions';
import { getRow, listRows } from '@/api/crud';
import { getBalance } from '@/api/ledger';
import { getAvailability } from '@/api/scheduling';
import { listAppointments, approveAppointment, transitionAppointment } from '@/api/appointments';
import type { Appointment } from '@/api/appointments';
import type { ConflictVerdict } from '@shared/ssot/domain/conflict';
import { VOID_APPOINTMENT_STATES } from '@shared/ssot/domain';
import type { TableRecordMap } from '@shared/types/types';
import { useAppointmentCalendar } from '@/composables/useFullCalendar';
import { mergeIntervals, complementIntervals } from '@/composables/calendarGrid';
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
const { label } = useLabel();
const { formatDateTime, formatARS } = useCurrency();
const toast = useToast();

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
const filteredRequests = computed(() => {
  const sel = selectedProfessionalId.value;
  // Wire rows serialize ids as strings, so compare as strings (a strict number === always misses).
  return sel == null ? requests.value : requests.value.filter((a) => String(a.professional_user_id) === String(sel));
});

const { labelFor: clientLabelFor } = useForeignKeyOptions({ table: 'clients', valueField: 'id', labelField: 'display_name' });
const { labelFor: professionalLabelFor } = useForeignKeyOptions({ table: 'professionals', valueField: 'id', labelField: 'display_name' });
const { labelFor: serviceLabelFor } = useForeignKeyOptions({ table: 'services', valueField: 'id', labelField: 'name' });

function clientName(a: Appointment): string {
  return clientLabelFor(a.client_user_id) ?? a.name ?? `Turno #${a.id}`;
}
function professionalName(a: Appointment): string {
  return professionalLabelFor(a.professional_user_id) ?? '—';
}
function serviceName(a: Appointment): string {
  return serviceLabelFor(a.service_id) ?? '—';
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
const dayBlocks = ref<{ weekday: string; start: number; end: number; slotMinutes: number }[]>([]);

const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_END_MINUTES = 24 * 60;
function toMinutes(hhmm: string): number { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; }
function toHHMM(min: number): string { const p = (n: number) => String(n).padStart(2, '0'); return `${p(Math.floor(min / 60))}:${p(min % 60)}`; }

const dayHeading = computed(() => {
  const appt = detailAppt.value;
  if (!appt) return '';
  const d = new Date(`${appt.starts_at.slice(0, 10)}T00:00:00`);
  const weekday = d.toLocaleDateString(locale.value === 'en' ? 'en-US' : 'es-AR', { weekday: 'long' });
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${weekday} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
});

function dayAfter(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

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
  const pid = String(appt.professional_user_id);
  loadingDetail.value = true;
  const day = appt.starts_at.slice(0, 10);
  // Ledger reads are allowed for anyone who can see the request (the request itself is the
  // relationship). The appointment history is the caller's own scoped view of this client.
  // The professional's availability + working blocks drive the day calendar's background shading.
  const [prof, bal, appts, proDay, avail, blocksRes, offersRes, servicesRes] = await Promise.all([
    cid != null ? getRow('clients', cid) : Promise.resolve(null),
    cid != null ? getBalance(cid) : Promise.resolve(null),
    cid != null ? listAppointments({ client_user_id: cid, limit: 500 }) : Promise.resolve(null),
    listAppointments({
      professional_user_id: appt.professional_user_id,
      date_from: day,
      date_to: dayAfter(day),
      limit: 200,
    }),
    getAvailability(`prof:${pid}`, day),
    listRows('schedule_blocks', { filters: { professional_user_id: pid }, limit: 500 }),
    listRows('schedule_block_services', { filters: { professional_user_id: pid }, limit: 500 }),
    listRows('services', { limit: 500 }),
  ]);
  if (prof && prof.ok) clientProfile.value = prof.data;
  clientBalance.value = bal && bal.ok ? bal.data.balance_ars : null;
  clientAppts.value = appts && appts.ok ? appts.data : [];
  dayAppts.value = proDay.ok ? proDay.data : [];
  dayFreeSlots.value = avail.ok
    ? avail.data.slots.map((s) => ({ start: toMinutes(s.start), end: toMinutes(s.end) }))
    : [];
  // A block tiles by its (first offered) service's effective duration — the per-block override,
  // else the service default. 30 min when unknown. Mirrors the staff calendar's slot sizing.
  const serviceDefault = new Map<string, number>();
  if (servicesRes.ok) for (const s of servicesRes.data) serviceDefault.set(String(s.id), Number(s.default_duration_minutes));
  const blockSlot = new Map<string, number>();
  if (offersRes.ok) for (const o of offersRes.data) {
    const key = String(o.schedule_block_id);
    if (blockSlot.has(key)) continue;
    const dur = o.duration_minutes != null ? Number(o.duration_minutes) : serviceDefault.get(String(o.service_id));
    if (dur && dur > 0) blockSlot.set(key, dur);
  }
  dayBlocks.value = blocksRes.ok
    ? blocksRes.data
        .filter((r) => r.resource_id == null)
        .map((r) => ({
          weekday: String(r.weekday),
          start: toMinutes(r.start_time.slice(0, 5)),
          end: toMinutes(r.end_time.slice(0, 5)),
          slotMinutes: blockSlot.get(String(r.id)) ?? 30,
        }))
    : [];
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
  const out: EventInput[] = [];
  const push = (s: number, e: number, cls: string) => {
    if (e > s) out.push({ start: `${day}T${toHHMM(s)}:00`, end: `${day}T${toHHMM(e)}:00`, display: 'background', classNames: [cls] });
  };

  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  // A fully past day can't be booked — grey the whole column and skip the availability shading.
  if (day < today) { push(0, DAY_END_MINUTES, 'fc-slot-past'); return out; }
  const floor = day === today ? now.getHours() * 60 + now.getMinutes() : 0;
  if (floor > 0) push(0, floor, 'fc-slot-past');

  const VOID = new Set<string>(VOID_APPOINTMENT_STATES);
  const occupied: { start: number; end: number }[] = [];
  const requested: { start: number; end: number }[] = [];
  for (const a of dayAppts.value) {
    if (VOID.has(a.state)) continue;
    const s = new Date(a.starts_at);
    const e = new Date(a.ends_at);
    const start = s.getHours() * 60 + s.getMinutes();
    let end = e.getHours() * 60 + e.getMinutes();
    if (end <= start) end = DAY_END_MINUTES;
    (a.state === 'requested' ? requested : occupied).push({ start, end });
  }

  const clip = (iv: { start: number; end: number }) => ({ start: Math.max(iv.start, floor), end: iv.end });
  for (const iv of mergeIntervals(occupied.map(clip))) push(iv.start, iv.end, 'fc-slot-occupied');
  for (const iv of mergeIntervals(requested.map(clip))) push(iv.start, iv.end, 'fc-slot-requested-bg');
  // Never-available time (off-hours / day off) — neither free nor booked — is the grey hatch.
  const working = mergeIntervals([...dayFreeSlots.value, ...occupied, ...requested]);
  for (const g of complementIntervals(working, floor, DAY_END_MINUTES)) push(g.start, g.end, 'fc-res-closed');

  // A dotted outline per free, bookable schedule slot (each block tiled by its own slot size).
  const wk = WEEKDAY_KEYS[new Date(`${day}T00:00:00`).getDay()];
  const booked = [...occupied, ...requested];
  for (const b of dayBlocks.value) {
    if (b.weekday !== wk) continue;
    for (let s = b.start; s + b.slotMinutes <= b.end; s += b.slotMinutes) {
      if (s < floor) continue;
      if (booked.some((k) => s < k.end && k.start < s + b.slotMinutes)) continue;
      push(s, s + b.slotMinutes, 'fc-slot-outline');
    }
  }
  return out;
});

// Read-only day calendar for the request's professional + date. Null viewer keeps it
// non-editable; a fresh :key per request re-applies initialDate on open.
const nullViewer = ref<AuthUser | null>(null);
const { calendarOptions: dayCalendarBase } = useAppointmentCalendar(
  dayAppts,
  nullViewer,
  { onSelect: () => {}, onEventClick: () => {}, onEventDrop: () => {}, onEventResize: () => {} },
  { fallbackTitle: (a) => clientLabelFor(a.client_user_id) },
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
  // Fill the calendar column instead of a short fixed block (parent gives it the height).
  height: '100%' as const,
  expandRows: true,
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
const conflictVerdict = ref<ConflictVerdict | null>(null);
const conflictOpen = ref(false);
const conflictRetryFn = ref<((override: boolean) => Promise<void>) | null>(null);

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
    conflictVerdict.value = payload.verdict;
    conflictRetryFn.value = (ov) => approve(appt, ov);
    conflictOpen.value = true;
    return;
  }
  toast.success('requestApproved');
  closeDetail();
  await load();
}

function onOverrideConfirm() {
  conflictOpen.value = false;
  const retry = conflictRetryFn.value;
  conflictVerdict.value = null;
  conflictRetryFn.value = null;
  if (retry) void retry(true);
}
function onOverrideCancel() {
  conflictOpen.value = false;
  conflictVerdict.value = null;
  conflictRetryFn.value = null;
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
      {{ label({ es: 'Solicitudes', en: 'Requests' }) }}
    </h1>

    <div class="mb-6 max-w-[260px]">
      <ProfessionalPicker allow-all v-model="selectedProfessionalId" />
    </div>

    <div v-if="loading">
      <Skeleton variant="row" :rows="4" />
    </div>

    <EmptyState
      v-else-if="filteredRequests.length === 0"
      :heading="label({ es: 'Sin solicitudes pendientes', en: 'No pending requests' })"
      :body="label({ es: 'Las solicitudes de turno aparecen aquí.', en: 'Appointment requests appear here.' })"
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
              {{ professionalName(appt) }} · {{ serviceName(appt) }}
            </p>
            <p class="text-xs text-neutral">{{ formatARS(appt.price) }}</p>
          </div>

          <div class="flex flex-shrink-0 gap-2">
            <AppButton variant="primary" :loading="acting" @click.stop="approve(appt)">
              {{ label({ es: 'Aprobar', en: 'Approve' }) }}
            </AppButton>
            <AppButton variant="destructive" :disabled="acting" @click.stop="rejectTarget = appt">
              {{ label({ es: 'Rechazar', en: 'Reject' }) }}
            </AppButton>
          </div>
        </div>
      </li>
    </ul>

    <DetailPanel
      :open="detailOpen"
      :title="label({ es: 'Detalle de la solicitud', en: 'Request detail' })"
      size="5xl"
      @close="closeDetail"
      @after-leave="onDetailAfterLeave"
    >
      <div v-if="detailAppt" class="flex flex-col gap-5">
        <div class="grid gap-6 lg:grid-cols-2">
          <div class="flex flex-col gap-5">
        <section class="flex flex-col gap-2">
          <h3 class="text-sm font-semibold text-neutral">{{ label({ es: 'Solicitud', en: 'Request' }) }}</h3>
          <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt class="text-neutral">{{ t('calendar.dateLabel') }}</dt>
            <dd>{{ formatDateTime(detailAppt.starts_at) }} · {{ detailAppt.duration_minutes }} min</dd>
            <dt class="text-neutral">{{ t('calendar.professionalLabel') }}</dt>
            <dd>{{ professionalName(detailAppt) }}</dd>
            <dt class="text-neutral">{{ t('calendar.serviceLabel') }}</dt>
            <dd>{{ serviceName(detailAppt) }}</dd>
            <dt class="text-neutral">{{ t('calendar.priceLabel') }}</dt>
            <dd>{{ formatARS(detailAppt.price) }}</dd>
            <template v-if="detailAppt.name">
              <dt class="text-neutral">Título</dt>
              <dd>{{ detailAppt.name }}</dd>
            </template>
            <template v-if="detailAppt.description">
              <dt class="text-neutral">Descripción</dt>
              <dd class="whitespace-pre-line">{{ detailAppt.description }}</dd>
            </template>
          </dl>
        </section>

        <div v-if="loadingDetail">
          <Skeleton variant="row" :rows="3" />
        </div>

        <template v-else>
          <section class="flex flex-col gap-2 border-t border-border pt-4">
            <h3 class="text-sm font-semibold text-neutral">{{ label({ es: 'Cliente', en: 'Client' }) }}</h3>
            <p class="text-base font-semibold text-heading">{{ clientProfile?.display_name ?? clientName(detailAppt) }}</p>
            <p class="text-sm text-neutral">{{ clientProfile?.email ?? '—' }} · {{ clientProfile?.phone ?? '—' }}</p>
          </section>

          <section class="flex flex-col gap-2">
            <div
              class="flex items-center justify-between rounded-lg border p-3"
              :class="balancePositive ? 'border-destructive bg-red-50' : 'border-border bg-card'"
            >
              <span class="text-sm font-semibold text-heading">{{ label({ es: 'Saldo / deuda', en: 'Balance / debt' }) }}</span>
              <span
                class="text-lg font-semibold tabular-nums"
                :class="balancePositive ? 'text-destructive' : 'text-success'"
              >
                {{ clientBalance != null ? formatARS(clientBalance) : '—' }}
              </span>
            </div>
          </section>

          <section class="flex flex-col gap-2">
            <h3 class="text-sm font-semibold text-neutral">{{ label({ es: 'Historial', en: 'History' }) }}</h3>
            <div class="flex flex-wrap gap-2 text-xs">
              <span class="rounded-full bg-surface px-2 py-1">{{ label({ es: 'Turnos', en: 'Appointments' }) }}: {{ clientAppts.length }}</span>
              <span class="rounded-full bg-green-100 px-2 py-1 text-success">{{ label({ es: 'Completados', en: 'Completed' }) }}: {{ completedCount }}</span>
              <span class="rounded-full bg-red-100 px-2 py-1 text-destructive">{{ label({ es: 'Cancelados', en: 'Canceled' }) }}: {{ canceledCount }}</span>
              <span class="rounded-full bg-yellow-100 px-2 py-1 text-warning">{{ label({ es: 'Ausencias', en: 'No-shows' }) }}: {{ noShowCount }}</span>
            </div>

            <EmptyState
              v-if="detailHistory.length === 0"
              :heading="label({ es: 'Sin turnos previos', en: 'No previous appointments' })"
              body=""
            />
            <ul v-else class="divide-y divide-border rounded-lg border border-border">
              <li
                v-for="a in detailHistory"
                :key="a.id"
                class="flex items-center justify-between gap-3 px-3 py-2 text-sm"
              >
                <span class="tabular-nums text-neutral">{{ formatDateTime(a.starts_at) }}</span>
                <span class="flex-1 truncate">{{ serviceName(a) }} · {{ professionalName(a) }}</span>
                <span class="rounded-full bg-surface px-2 py-0.5 text-xs">{{ t(`status.${a.state}`) }}</span>
              </li>
            </ul>
          </section>
        </template>
          </div>

          <div class="flex min-h-0 flex-col gap-2 lg:h-[72vh]">
            <h3 class="text-sm font-semibold text-neutral">
              {{ label({ es: 'Agenda del día', en: "That day's schedule" }) }}
            </h3>
            <div class="min-h-[420px] flex-1 overflow-hidden rounded-lg border border-border">
              <CalendarView :key="detailAppt.id" :options="dayCalendarOptions" />
            </div>
          </div>
        </div>

        <div class="flex gap-2 border-t border-border pt-4">
          <AppButton variant="primary" :loading="acting" class="flex-1" @click="approve(detailAppt)">
            {{ label({ es: 'Aprobar', en: 'Approve' }) }}
          </AppButton>
          <AppButton variant="destructive" :disabled="acting" class="flex-1" @click="rejectTarget = detailAppt">
            {{ label({ es: 'Rechazar', en: 'Reject' }) }}
          </AppButton>
        </div>
      </div>
    </DetailPanel>

    <ConfirmDialog
      :open="rejectTarget !== null"
      :title="label({ es: 'Rechazar solicitud', en: 'Reject request' })"
      :body="label({ es: '¿Rechazar esta solicitud? Esta acción no se puede deshacer.', en: 'Reject this request? This cannot be undone.' })"
      :confirm-label="label({ es: 'Rechazar', en: 'Reject' })"
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
/* Let the embedded day calendar fill its (definite-height) column so it uses the modal height. */
:deep(.fc-wrapper) {
  height: 100%;
}

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

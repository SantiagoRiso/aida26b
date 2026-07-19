import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { listAppointments, transitionAppointment } from '@/api/appointments';
import type { Appointment } from '@/api/appointments';
import { isVirtualOccurrence } from '@/composables/seriesOccurrence';
import { createEntry } from '@/api/ledger';
import { isCurrent, canSettle as canSettleAt, transitionFor, showsCurrentCard } from '@/views/staff/dashboard-current';
import type { SettleAction } from '@/views/staff/dashboard-current';
import { useAuthStore } from '@/stores/auth';
import { useToast } from '@/composables/useToast';

// Cards never expire, so recently-forgotten unresolved sessions must surface too.
// 7 days back is the product knob for "recent"; anything older is stale noise.
const LOOKBACK_DAYS = 7;

// Current-appointment settle card. Visible to the session's own professional and to
// receptionists (server scopes their list to granted calendars); admins never see it.
export function useSettleCard() {
  const auth = useAuthStore();
  const toast = useToast();

  const showsCard = computed(() => auth.user?.role === 'Professional' || auth.user?.role === 'Receptionist');

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
    // Settling calls transitionAppointment directly on appt.id — no materialize-on-action wiring
    // here, so a virtual (un-materialized) occurrence is filtered out rather than offered a
    // settle action that would 404.
    settleCandidates.value = res.data.filter((a): a is Appointment => !isVirtualOccurrence(a));
    for (const a of settleCandidates.value) {
      if (!(a.id in amounts.value)) amounts.value[a.id] = a.price ?? '';
    }
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

  onMounted(() => {
    if (!showsCard.value) return;
    void loadCurrent();
    // Re-evaluate the card window as time passes so cards appear on their own.
    nowTimer = window.setInterval(() => { now.value = new Date(); }, 30_000);
    // New bookings must surface without a page reload.
    refetchTimer = window.setInterval(() => { void loadCurrent(); }, 60_000);
  });

  onBeforeUnmount(() => {
    if (nowTimer !== undefined) window.clearInterval(nowTimer);
    if (refetchTimer !== undefined) window.clearInterval(refetchTimer);
  });

  return { showsCard, currentAppointments, amounts, processing, canSettle, settle, loadCurrent };
}

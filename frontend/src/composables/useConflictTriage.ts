import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { listAppointments, transitionAppointment, approveAppointment, ignoreAppointmentConflict } from '@/api/appointments';
import type { Appointment } from '@/api/appointments';
import type { VoidAppointmentState } from '@shared/ssot/domain/appointment-lifecycle';
import { useToast } from '@/composables/useToast';
import { useConflictOverride } from '@/composables/useConflictOverride';

// Open, future turnos that now overlap active time-off (a closure or the professional's licencia).
// Server role-scopes the list; every staff role sees the ones they own so nobody's conflicts hide.
export function useConflictTriage() {
  const router = useRouter();
  const toast = useToast();

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
  const resolveTarget = ref<{ appt: Appointment; to: VoidAppointmentState } | null>(null);

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

  return {
    conflictTurnos,
    conflictTotal,
    loadConflicts,
    conflictBusy,
    resolveTarget,
    ignoreConflict,
    goReschedule,
    confirmResolve,
    approveConflict,
    conflictOpen,
    conflictVerdict,
    conflictRevert,
    onOverrideConfirm,
    onOverrideCancel,
  };
}

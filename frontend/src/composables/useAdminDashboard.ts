import { ref } from 'vue';
import { listAppointments } from '@/api/appointments';
import { isVirtualOccurrence } from '@/composables/seriesOccurrence';
import { listAudit } from '@/api/audit';
import type { AuditEvent } from '@/api/audit';
import { businessDate } from '@shared/ssot/domain/availability';

export function useAdminDashboard() {
  // Stat tiles show totals, so they read the server's count (meta.total), not a capped page length.
  const adminTodayCount = ref(0);
  const adminPendingCount = ref(0);
  const recentAudit = ref<AuditEvent[]>([]);
  const loadingAdmin = ref(false);

  async function loadAdmin() {
    loadingAdmin.value = true;
    // Both bounds are the same business day; the server resolves a bare date to that whole day.
    const today = businessDate();
    const [todayRes, pendingRes, auditRes] = await Promise.all([
      // date_from/date_to make the server fold in virtual (un-materialized) recurring occurrences,
      // which meta.total counts too — fetch the rows and count only real ones so this stat matches
      // actual booked turnos, not a recurrence forecast.
      listAppointments({
        date_from: today,
        date_to: today,
        limit: 500,
      }),
      listAppointments({ state: 'requested', limit: 1 }),
      listAudit({}, 1, 5),
    ]);
    if (todayRes.ok) adminTodayCount.value = todayRes.data.filter((a) => !isVirtualOccurrence(a)).length;
    if (pendingRes.ok) adminPendingCount.value = pendingRes.meta?.total ?? 0;
    if (auditRes.ok) recentAudit.value = auditRes.data;
    loadingAdmin.value = false;
  }

  return { adminTodayCount, adminPendingCount, recentAudit, loadingAdmin, loadAdmin };
}

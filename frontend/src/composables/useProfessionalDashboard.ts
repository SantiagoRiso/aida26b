import { ref, computed } from 'vue';
import { listAppointments } from '@/api/appointments';
import type { Appointment } from '@/api/appointments';
import { useAuthStore } from '@/stores/auth';

export function useProfessionalDashboard() {
  const auth = useAuthStore();
  const userId = computed(() => auth.user?.id);

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

  return { proUpcoming, proPending, loadingPro, loadProfessional };
}

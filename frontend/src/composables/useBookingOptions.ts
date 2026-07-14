import { ref, computed } from 'vue';
import { listRows } from '@/api/crud';
import { listAppointments } from '@/api/appointments';
import type { Appointment } from '@/api/appointments';
import type { TableRecordMap } from '@shared/ssot/derived';
import { useAuthStore } from '@/stores/auth';
import { scopeProfessionalOptions } from '@/composables/useFullCalendar';
import { offeredServiceIds } from '@/composables/bookingForm';

// Option sourcing shared by the two booking screens (staff AppointmentForm, client RequestFlow):
// one fetch + one home for the scoping rules, so the forms can't drift apart on who may book
// with whom or which services a professional offers.

export interface BookingSelectOption { value: string; label: string }
// The DNI lets staff find a client by document number, not just name.
export interface BookingClientOption extends BookingSelectOption { dni: string }

export interface BookingOptionsConfig {
  // Staff booking: also load the client roster.
  withClients?: boolean;
  // Portal: rank professionals by the caller's own recent appointments.
  rankByRecency?: boolean;
  // Reactive source of the currently selected professional; scopes the offered services.
  selectedProfessionalId?: () => string | null;
}

// Only interactions within the last year influence the recency ordering.
const RECENCY_WINDOW_MS = 365 * 86400000;

export function useBookingOptions(config: BookingOptionsConfig = {}) {
  const auth = useAuthStore();

  const professionals = ref<TableRecordMap['professionals'][]>([]);
  const services = ref<TableRecordMap['services'][]>([]);
  const profServices = ref<TableRecordMap['professional_services'][]>([]);
  const clients = ref<TableRecordMap['clients'][]>([]);
  const myAppointments = ref<Appointment[]>([]);
  const loading = ref(false);

  async function load(): Promise<void> {
    loading.value = true;
    const [profRes, svcRes, psRes, clientRes, apptRes] = await Promise.all([
      listRows('professionals', { limit: 200 }),
      listRows('services', { limit: 200 }),
      listRows('professional_services', { limit: 500 }),
      config.withClients ? listRows('clients', { limit: 200 }) : null,
      // Server-scoped to the calling client's own appointments.
      config.rankByRecency ? listAppointments({ limit: 200 }) : null,
    ]);
    loading.value = false;
    if (profRes.ok) professionals.value = profRes.data;
    if (svcRes.ok) services.value = svcRes.data;
    if (psRes.ok) profServices.value = psRes.data;
    if (clientRes?.ok) clients.value = clientRes.data;
    if (apptRes?.ok) myAppointments.value = apptRes.data;
  }
  void load();

  const clientOptions = computed<BookingClientOption[]>(() =>
    clients.value.map((c) => ({ value: String(c.id), label: c.display_name, dni: c.dni ?? '' })),
  );

  // Most-recent interaction (requested or attended) per professional, as an epoch timestamp —
  // higher means more recent.
  const recencyByProfessional = computed(() => {
    const cutoff = Date.now() - RECENCY_WINDOW_MS;
    const m = new Map<string, number>();
    for (const a of myAppointments.value) {
      const t = new Date(a.starts_at).getTime();
      if (t < cutoff) continue;
      const prev = m.get(a.professional_user_id);
      if (prev == null || t > prev) m.set(a.professional_user_id, t);
    }
    return m;
  });

  // A professional may only book on their own calendar, so they see only themselves; receptionist
  // grant scoping is server-side (their fetched list already contains only granted calendars).
  // With recency on: professionals seen recently first (most recent → oldest), the rest alphabetical.
  const rankedProfessionals = computed<TableRecordMap['professionals'][]>(() => {
    const scoped = scopeProfessionalOptions(professionals.value, auth.user);
    if (!config.rankByRecency) return scoped;
    const recency = recencyByProfessional.value;
    return [...scoped].sort((a, b) => {
      const ra = recency.get(a.id) ?? null;
      const rb = recency.get(b.id) ?? null;
      if (ra != null && rb != null) return rb - ra;
      if (ra != null) return -1;
      if (rb != null) return 1;
      return a.display_name.localeCompare(b.display_name);
    });
  });

  const professionalOptions = computed<BookingSelectOption[]>(() =>
    rankedProfessionals.value.map((p) => ({ value: String(p.id), label: p.display_name })),
  );

  const serviceNamesByProfessional = computed(() => {
    const nameById = new Map<string, string>();
    for (const s of services.value) nameById.set(s.id, s.name);
    const m = new Map<string, string[]>();
    for (const ps of profServices.value) {
      const name = nameById.get(ps.service_id);
      if (!name) continue;
      const list = m.get(ps.professional_user_id);
      if (list) list.push(name);
      else m.set(ps.professional_user_id, [name]);
    }
    return m;
  });

  // Services the selected professional offers; no professional or no mapping → every service.
  const availableServices = computed<TableRecordMap['services'][]>(() => {
    const offered = offeredServiceIds(profServices.value, config.selectedProfessionalId?.() ?? null);
    if (!offered) return services.value;
    return services.value.filter((s) => offered.has(String(s.id)));
  });

  const availableServiceOptions = computed<BookingSelectOption[]>(() =>
    availableServices.value.map((s) => ({ value: String(s.id), label: s.name })),
  );

  return {
    loading,
    professionals,
    services,
    clientOptions,
    rankedProfessionals,
    professionalOptions,
    serviceNamesByProfessional,
    availableServices,
    availableServiceOptions,
  };
}

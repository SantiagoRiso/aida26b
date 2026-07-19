import { getRow } from '@/api/crud';
import { listAppointments } from '@/api/appointments';
import { isVirtualOccurrence } from '@/composables/seriesOccurrence';
import type { Appointment } from '@/api/appointments';
import { getApiMutationGeneration } from '@/api/client';

const PREFETCH_TTL_MS = 15_000;

type PrefetchResult = Awaited<ReturnType<typeof loadClientDetailPreview>>;
type PrefetchEntry = {
  generation: number;
  expiresAt: number;
  promise: Promise<PrefetchResult>;
};

const cache = new Map<number, PrefetchEntry>();

function loadClientDetailPreview(clientId: number) {
  return Promise.all([
    getRow('clients', clientId),
    listAppointments({ client_user_id: clientId, limit: 500 }),
  ]).then(([profile, appointments]) => ({
    profile,
    // ClientDetail's pending/history lists have no materialize-on-action wiring — a virtual
    // (un-materialized) occurrence is filtered out here rather than shown as an inert entry.
    appointments: appointments.ok
      ? { ...appointments, data: appointments.data.filter((a): a is Appointment => !isVirtualOccurrence(a)) }
      : appointments,
  }));
}

export function prefetchClientDetail(clientId: number): void {
  const current = cache.get(clientId);
  const generation = getApiMutationGeneration();
  if (current && current.generation === generation && current.expiresAt > Date.now()) return;
  cache.set(clientId, {
    generation,
    expiresAt: Date.now() + PREFETCH_TTL_MS,
    promise: loadClientDetailPreview(clientId),
  });
}

export function takeClientDetailPrefetch(clientId: number): Promise<PrefetchResult> | null {
  const entry = cache.get(clientId);
  cache.delete(clientId);
  if (!entry || entry.generation !== getApiMutationGeneration() || entry.expiresAt <= Date.now()) return null;
  return entry.promise;
}

export function resetClientDetailPrefetch(): void {
  cache.clear();
}

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useToast } from '@/composables/useToast';
import { listRows, createRow, updateRow, deleteRow } from '@/api/crud';
import type { TableRecordMap } from '@shared/ssot/derived';
import AppButton from '@/components/shared/AppButton.vue';
import FieldError from '@/components/shared/FieldError.vue';

const props = defineProps<{ professionalUserId: number | null }>();

const { t } = useI18n();
const { success, error } = useToast();

interface OfferingRow {
  serviceId: string;
  name: string;
  offered: boolean;
  rowId: string | null;
  // A number input yields '' when cleared; '' / null both mean "no value" (inherit).
  minDays: number | '' | null;
  maxDays: number | '' | null;
  overriding: boolean; // persisted: min or max is non-null → a custom window is set
  editingWindow: boolean;
  windowError: string;
  busy: boolean;
}

const rows = ref<OfferingRow[]>([]);
const loading = ref(false);
const hasServices = ref(true);

async function load() {
  const forId = props.professionalUserId;
  rows.value = [];
  if (forId == null) return;
  loading.value = true;
  const [servicesRes, offeringsRes] = await Promise.all([
    listRows('services', { limit: 500 }),
    listRows('professional_services', { filters: { professional_user_id: String(forId) }, limit: 200 }),
  ]);
  // A newer load() (professional switched) must win; drop this stale response.
  if (props.professionalUserId !== forId) return;
  loading.value = false;

  const offerings = new Map<string, TableRecordMap['professional_services']>();
  if (offeringsRes.ok) for (const o of offeringsRes.data) offerings.set(String(o.service_id), o);

  const services = servicesRes.ok ? servicesRes.data : [];
  hasServices.value = services.length > 0;
  rows.value = services.map((s): OfferingRow => {
    const offering = offerings.get(String(s.id));
    const min = offering?.min_booking_days ?? null;
    const max = offering?.max_booking_days ?? null;
    return {
      serviceId: String(s.id),
      name: s.name,
      offered: offering != null,
      rowId: offering ? String(offering.id) : null,
      minDays: min,
      maxDays: max,
      overriding: min != null || max != null,
      editingWindow: false,
      windowError: '',
      busy: false,
    };
  });
}

onMounted(load);
watch(() => props.professionalUserId, load);

// Checkbox = offered. Writes immediately (mirrors the calendar-grants card). On failure we revert
// row.offered and imperatively resync the input's checked state — a net-unchanged offered value
// (false→true→false on a failed create) won't re-patch the DOM on its own.
async function onToggle(row: OfferingRow, event: Event) {
  if (!(event.target instanceof HTMLInputElement)) return;
  const input = event.target;
  const checked = input.checked;
  if (props.professionalUserId == null || row.busy) return;
  row.busy = true;
  if (checked) {
    // Generic creates are full-object: every editable column must be present. A new offering
    // inherits the business booking window, so the per-service override columns start null.
    const res = await createRow('professional_services', {
      professional_user_id: String(props.professionalUserId),
      service_id: row.serviceId,
      min_booking_days: null,
      max_booking_days: null,
    });
    if (res.ok) {
      row.offered = true;
      row.rowId = String(res.data.id);
      success('saved');
    } else {
      row.offered = false;
      input.checked = row.offered;
      error('genericError');
    }
  } else if (row.rowId) {
    const res = await deleteRow('professional_services', row.rowId);
    if (res.ok) {
      row.offered = false;
      row.rowId = null;
      row.minDays = null;
      row.maxDays = null;
      row.overriding = false;
      row.editingWindow = false;
      success('saved');
    } else {
      row.offered = true;
      input.checked = row.offered;
      error('genericError');
    }
  }
  row.busy = false;
}

function openWindow(row: OfferingRow) {
  row.editingWindow = true;
  row.windowError = '';
}

function toDays(v: number | '' | null): number | null {
  return v === '' || v == null ? null : Number(v);
}

async function saveWindow(row: OfferingRow) {
  if (!row.rowId) return;
  row.windowError = '';
  const min = toDays(row.minDays);
  const max = toDays(row.maxDays);
  if (min != null && max != null && max < min) {
    row.windowError = t('business.maxBelowMin');
    return;
  }
  row.busy = true;
  const res = await updateRow('professional_services', row.rowId, { min_booking_days: min, max_booking_days: max });
  row.busy = false;
  if (res.ok) {
    row.minDays = res.data.min_booking_days ?? null;
    row.maxDays = res.data.max_booking_days ?? null;
    row.overriding = row.minDays != null || row.maxDays != null;
    row.editingWindow = false;
    success('saved');
  } else {
    error('genericError');
  }
}

async function clearWindow(row: OfferingRow) {
  if (!row.rowId) return;
  row.busy = true;
  const res = await updateRow('professional_services', row.rowId, { min_booking_days: null, max_booking_days: null });
  row.busy = false;
  if (res.ok) {
    row.minDays = null;
    row.maxDays = null;
    row.overriding = false;
    row.editingWindow = false;
    success('saved');
  } else {
    error('genericError');
  }
}
</script>

<template>
  <div class="space-y-4">
    <p v-if="professionalUserId == null" class="text-sm text-neutral">
      {{ t('professionalServices.selectProfessional') }}
    </p>

    <template v-else>
      <div v-if="loading" class="text-sm text-neutral">…</div>
      <p v-else-if="!hasServices" class="text-sm text-neutral">
        {{ t('professionalServices.noServices') }}
      </p>
      <ul v-else class="divide-y divide-border">
        <li v-for="row in rows" :key="row.serviceId" class="py-2" :data-testid="`offering-row-${row.serviceId}`">
          <label class="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              class="h-4 w-4 accent-accent"
              :checked="row.offered"
              :disabled="row.busy"
              :data-testid="`offering-toggle-${row.serviceId}`"
              @change="onToggle(row, $event)"
            />
            <span class="font-medium">{{ row.name }}</span>
          </label>

          <div v-if="row.offered" class="mt-1 pl-6 text-xs">
            <button
              v-if="!row.editingWindow"
              type="button"
              class="text-accent hover:underline"
              :data-testid="`offering-window-edit-${row.serviceId}`"
              @click="openWindow(row)"
            >
              {{ row.overriding
                ? t('professionalServices.windowCustom')
                : t('professionalServices.windowDefault') }}
            </button>

            <div v-else class="space-y-2">
              <div class="flex flex-wrap gap-3">
                <label class="flex flex-col gap-1">
                  <span class="text-neutral">{{ t('business.minBookingDays') }}</span>
                  <input
                    type="number" min="0" step="1"
                    v-model="row.minDays"
                    :data-testid="`offering-min-${row.serviceId}`"
                    class="w-24 rounded-md border border-border px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-accent tabular-nums"
                  />
                </label>
                <label class="flex flex-col gap-1">
                  <span class="text-neutral">{{ t('business.maxBookingDays') }}</span>
                  <input
                    type="number" min="0" step="1"
                    v-model="row.maxDays"
                    :data-testid="`offering-max-${row.serviceId}`"
                    class="w-24 rounded-md border border-border px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-accent tabular-nums"
                  />
                </label>
              </div>
              <FieldError :message="row.windowError" />
              <div class="flex gap-2">
                <AppButton variant="primary" size="sm" :loading="row.busy" :data-testid="`offering-window-save-${row.serviceId}`" @click="saveWindow(row)">
                  {{ t('actions.save') }}
                </AppButton>
                <AppButton variant="neutral" size="sm" :data-testid="`offering-window-default-${row.serviceId}`" @click="clearWindow(row)">
                  {{ t('professionalServices.useDefault') }}
                </AppButton>
              </div>
            </div>
          </div>
        </li>
      </ul>
    </template>
  </div>
</template>

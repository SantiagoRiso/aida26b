<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { listRows, createRow, updateRow, deleteRow } from '@/api/crud';
import { useToast } from '@/composables/useToast';
import FieldError from '@/components/shared/FieldError.vue';
import type { TemplateBlock } from '@/composables/scheduleTemplateGrid';
import type { TableRecordMap } from '@shared/ssot/derived';

// blockMinutes is the block's live length (end − start, from the editor's unsaved textboxes) so the
// slot-fit warning reacts as the times are edited.
const props = defineProps<{ block: TemplateBlock; blockMinutes: number }>();

const { t } = useI18n();
const toast = useToast();

interface ServiceRow {
  serviceId: string;
  name: string;
  rowId: string | null;
  offered: boolean;
  // The block manages its own duration/price (a per-block schedule_block_services override — unique
  // per (block, service), so it never affects other blocks), instead of following the service
  // default. The inputs are editable only while this is true.
  independent: boolean;
  // Shown values: the block override when independent, else the service default. A number[type]
  // input auto-casts through v-model — blank stays '' (never NaN).
  durationMinutes: number | '';
  priceArs: string;
  defaultDuration: number;
  defaultPrice: string;
  // Persisted state at load. Edits stay local until save() (submit-based modal) diffs against this.
  origOffered: boolean;
  origDuration: number | null;
  origPrice: string | null;
}

// A block is tiled into back-to-back slots of the service's effective duration; a trailing partial
// slot is dropped, so any leftover minutes at the block's end are unbookable. Surface that.
function slotRemainder(row: ServiceRow): { duration: number; remainder: number } | null {
  const eff = row.durationMinutes === '' ? row.defaultDuration : Number(row.durationMinutes);
  if (!Number.isInteger(eff) || eff <= 0 || props.blockMinutes <= 0) return null;
  const remainder = props.blockMinutes % eff;
  return remainder === 0 ? null : { duration: eff, remainder };
}

const rows = ref<ServiceRow[]>([]);
const loading = ref(false);
const fieldErrors = ref<Record<string, Record<string, string>>>({});

async function load() {
  const forBlock = props.block.id;
  rows.value = [];
  loading.value = true;
  fieldErrors.value = {};
  const professionalUserId = props.block.professional_user_id;
  const [boundRes, servicesRes, offeringsRes] = await Promise.all([
    listRows('professional_services', { filters: { professional_user_id: professionalUserId }, limit: 200 }),
    listRows('services', { limit: 500 }),
    listRows('schedule_block_services', { filters: { schedule_block_id: props.block.id }, limit: 200 }),
  ]);

  // The same instance reloads in place across a block switch; bail if a newer load() started before
  // this one's awaits resolved, so a stale response never overwrites current rows.
  if (props.block.id !== forBlock) return;

  const names = new Map<string, string>();
  const defaultDur = new Map<string, number>();
  const defaultPrice = new Map<string, string>();
  if (servicesRes.ok) {
    for (const s of servicesRes.data) {
      names.set(String(s.id), s.name);
      defaultDur.set(String(s.id), Number(s.default_duration_minutes));
      defaultPrice.set(String(s.id), String(s.default_price_ars));
    }
  }

  const offerings = new Map<string, TableRecordMap['schedule_block_services']>();
  if (offeringsRes.ok) {
    for (const o of offeringsRes.data) offerings.set(String(o.service_id), o);
  }

  rows.value = boundRes.ok
    ? boundRes.data.map((bs): ServiceRow => {
      const serviceId = String(bs.service_id);
      const offering = offerings.get(serviceId);
      const dDur = defaultDur.get(serviceId) ?? 0;
      const dPrice = defaultPrice.get(serviceId) ?? '';
      const overrideDur = offering?.duration_minutes ?? null;
      const overridePrice = offering?.price_ars ?? null;
      const offered = offering != null;
      return {
        serviceId,
        name: names.get(serviceId) ?? serviceId,
        rowId: offering ? String(offering.id) : null,
        offered,
        // An override on either field means the block is managed independently; the inputs show the
        // override where set and fall back to the service default otherwise.
        independent: offered && (overrideDur != null || overridePrice != null),
        durationMinutes: overrideDur ?? dDur,
        priceArs: overridePrice ?? dPrice,
        defaultDuration: dDur,
        defaultPrice: dPrice,
        origOffered: offered,
        origDuration: overrideDur,
        origPrice: overridePrice,
      };
    })
    : [];

  if (!boundRes.ok) toast.error('scheduleBlockServiceSaveError');

  // A professional with exactly one service always offers it in every block — no checkbox choice to
  // make. Mark it offered locally (rendered as a label); save() persists the offering on submit if
  // it wasn't already there.
  const only = rows.value.length === 1 ? rows.value[0] : null;
  if (only) only.offered = true;

  loading.value = false;
}

onMounted(load);
watch(() => props.block.id, load);

function toDuration(value: number | string): number | null {
  if (value === '' || value == null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function priceOrNull(value: string): string | null {
  return value.trim() === '' ? null : value.trim();
}

// duration/price are null when the block inherits the service default, else the block's own values.
function writeBody(row: ServiceRow, duration: number | null, price: string | null): Partial<TableRecordMap['schedule_block_services']> {
  return {
    professional_user_id: props.block.professional_user_id,
    schedule_block_id: props.block.id,
    service_id: row.serviceId,
    duration_minutes: duration,
    price_ars: price,
  };
}

function clearErrors(serviceId: string) {
  delete fieldErrors.value[serviceId];
}

function resetToDefaults(row: ServiceRow) {
  row.independent = false;
  row.durationMinutes = row.defaultDuration;
  row.priceArs = row.defaultPrice;
}

// All toggles/edits are local until save(); nothing persists until the modal's submit.
function onToggle(row: ServiceRow, event: Event) {
  row.offered = (event.target as HTMLInputElement).checked;
  resetToDefaults(row); // a fresh offer (or an un-offer) starts from inheriting the service default
  clearErrors(row.serviceId);
}

// "Manage this block's duration/price separately from the service." On: the shown (default) values
// become editable and are pinned as the block's own on save. Off: revert to inheriting.
function onToggleIndependent(row: ServiceRow, event: Event) {
  const checked = (event.target as HTMLInputElement).checked;
  row.independent = checked;
  if (!checked) {
    row.durationMinutes = row.defaultDuration;
    row.priceArs = row.defaultPrice;
  }
  clearErrors(row.serviceId);
}

// The block's own values when independent, else null (inherit the service default). Falls back to
// the service defaults so an independent override is never null.
function desiredOverride(row: ServiceRow): { duration: number | null; price: string | null } {
  if (!row.independent) return { duration: null, price: null };
  return {
    duration: toDuration(row.durationMinutes) ?? row.defaultDuration,
    price: priceOrNull(row.priceArs) ?? row.defaultPrice,
  };
}

// Persist every pending change against the load-time snapshot: create newly-offered rows, delete
// dropped ones, update changed overrides. Returns false (and surfaces errors) if any write fails.
async function save(): Promise<boolean> {
  fieldErrors.value = {};
  let ok = true;
  for (const row of rows.value) {
    const { duration, price } = desiredOverride(row);

    if (!row.origOffered && row.offered) {
      const res = await createRow('schedule_block_services', writeBody(row, duration, price));
      if (res.ok) syncSnapshot(row, res.data);
      else { ok = false; recordError(row, res.fields); }
    } else if (row.origOffered && !row.offered && row.rowId) {
      const res = await deleteRow('schedule_block_services', row.rowId);
      if (res.ok) { row.rowId = null; row.origOffered = false; row.origDuration = null; row.origPrice = null; }
      else { ok = false; toast.error('scheduleBlockServiceDeleteError'); }
    } else if (row.origOffered && row.offered && row.rowId && (duration !== row.origDuration || price !== row.origPrice)) {
      const res = await updateRow('schedule_block_services', row.rowId, writeBody(row, duration, price));
      if (res.ok) syncSnapshot(row, res.data);
      else { ok = false; recordError(row, res.fields); }
    }
  }
  return ok;
}

function syncSnapshot(row: ServiceRow, data: TableRecordMap['schedule_block_services']) {
  row.rowId = String(data.id);
  row.origOffered = true;
  row.origDuration = data.duration_minutes ?? null;
  row.origPrice = data.price_ars ?? null;
  row.durationMinutes = data.duration_minutes ?? row.defaultDuration;
  row.priceArs = data.price_ars ?? row.defaultPrice;
}

function recordError(row: ServiceRow, fields?: Record<string, string>) {
  if (fields && Object.keys(fields).length > 0) fieldErrors.value[row.serviceId] = fields;
  else toast.error('scheduleBlockServiceSaveError');
}

defineExpose({ rows, save });
</script>

<template>
  <div data-testid="block-services-panel">
    <h3 class="text-sm font-semibold">{{ t('schedule.servicesTitle') }}</h3>
    <p v-if="!loading && rows.length === 0" class="mt-1 text-sm text-neutral">
      {{ t('schedule.noBoundServices') }}
    </p>
    <ul v-else class="mt-1 divide-y divide-border">
      <li
        v-for="row in rows"
        :key="row.serviceId"
        class="py-2"
        :data-testid="`block-service-row-${row.serviceId}`"
      >
        <!-- A single service is the block's only option: label it instead of a pointless checkbox. -->
        <label v-if="rows.length > 1" class="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            class="h-4 w-4 accent-accent"
            :checked="row.offered"
            :data-testid="`block-service-toggle-${row.serviceId}`"
            @change="onToggle(row, $event)"
          />
          <span class="font-medium">{{ row.name }}</span>
        </label>
        <p v-else class="text-sm font-medium" :data-testid="`block-service-label-${row.serviceId}`">
          {{ row.name }}
        </p>

        <template v-if="row.offered">
          <label class="mt-2 flex items-start gap-2 pl-6 text-xs">
            <input
              type="checkbox"
              class="mt-0.5 h-4 w-4 accent-accent"
              :checked="row.independent"
              :data-testid="`block-service-independent-${row.serviceId}`"
              @change="onToggleIndependent(row, $event)"
            />
            <span>
              <span class="font-medium">{{ t('schedule.independentToggle') }}</span>
              <span class="mt-0.5 block text-neutral">{{ t('schedule.independentHint') }}</span>
            </span>
          </label>

          <div class="mt-2 flex flex-wrap gap-3 pl-6">
            <label class="flex flex-col gap-1 text-xs">
              <span class="text-neutral">{{ t('calendar.durationLabel') }}</span>
              <input
                type="number"
                v-model="row.durationMinutes"
                :disabled="!row.independent"
                :data-testid="`block-service-duration-${row.serviceId}`"
                class="w-24 rounded-md border border-border px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-accent disabled:cursor-not-allowed disabled:bg-surface disabled:text-neutral"
              />
              <FieldError :message="fieldErrors[row.serviceId]?.duration_minutes" />
            </label>

            <label class="flex flex-col gap-1 text-xs">
              <span class="text-neutral">{{ t('calendar.priceLabel') }}</span>
              <input
                type="text"
                v-model="row.priceArs"
                :disabled="!row.independent"
                :data-testid="`block-service-price-${row.serviceId}`"
                class="w-28 rounded-md border border-border px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-accent disabled:cursor-not-allowed disabled:bg-surface disabled:text-neutral"
              />
              <FieldError :message="fieldErrors[row.serviceId]?.price_ars" />
            </label>
          </div>

          <p
            v-if="slotRemainder(row)"
            class="mt-2 flex items-start gap-1 pl-6 text-xs text-warning"
            :data-testid="`block-service-warning-${row.serviceId}`"
          >
            <span aria-hidden="true">⚠</span>
            <span>{{ t('schedule.durationWarning', slotRemainder(row) ?? {}) }}</span>
          </p>
        </template>
      </li>
    </ul>
  </div>
</template>

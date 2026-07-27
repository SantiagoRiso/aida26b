<script setup lang="ts">
import { ref, reactive, computed, onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { listRows, createRow, updateRow } from '@/api/crud';
import { useBookingOptions } from '@/composables/useBookingOptions';
import { useToast } from '@/composables/useToast';
import { useAuthStore } from '@/stores/auth';
import { useLabel } from '@/composables/useLabel';
import { useCurrency } from '@/composables/useCurrency';
import { roleAllowedFor, descriptorWriteRoles } from '@/router/access';
import { validateFieldIssue } from '@shared/validation/validate';
import { fieldErrorMessage, fieldErrorMessages } from '@/i18n/api-errors';
import { structure } from '@shared/ssot/structure';
import { AMOUNT_PATTERN } from '@shared/ssot/domain/catalog';
import type { TableRecordMap } from '@shared/ssot/derived';
import type { Wire } from '@shared/ssot/query-types';
import Skeleton from '@/components/shared/Skeleton.vue';
import EmptyState from '@/components/shared/EmptyState.vue';
import AppButton from '@/components/shared/AppButton.vue';
import DetailPanel from '@/components/shared/DetailPanel.vue';
import FieldError from '@/components/shared/FieldError.vue';
import Selector from '@/components/shared/Selector.vue';

const props = defineProps<{ clientId: number }>();

const TABLE = 'client_professional_services' as const;

const { t } = useI18n();
const { success, error } = useToast();
const { label } = useLabel();
const { formatARS } = useCurrency();
const auth = useAuthStore();

const priceTable = structure.tables.client_professional_services;
const columns = priceTable.columns;

const role = computed(() => auth.user?.role);
const canCreate = computed(
  () => !!role.value && !!priceTable.crud?.create && roleAllowedFor(descriptorWriteRoles(TABLE, 'create'), role.value),
);
const canUpdate = computed(
  () => !!role.value && !!priceTable.crud?.update && roleAllowedFor(descriptorWriteRoles(TABLE, 'update'), role.value),
);
// The descriptor withholds delete (delete:false, no soft-delete columns) — no removal is offered.
const canManage = computed(() => canCreate.value || canUpdate.value);

type OverrideRow = Wire<TableRecordMap['client_professional_services']>;
const overrides = ref<OverrideRow[]>([]);
const loading = ref(true);

const panelOpen = ref(false);
const mode = ref<'create' | 'edit'>('create');
const editingId = ref<string | null>(null);
const form = reactive({ professional_user_id: '', service_id: '', price_ars: '' });
const fieldErrors = reactive<Record<string, string>>({});
const submitting = ref(false);

// Reuse the booking screens' option sourcing so a chosen professional narrows the service list to
// exactly what they offer — the same offeredServiceIds rule the calendar and portal forms use.
const { professionalOptions, availableServiceOptions, professionals, services } = useBookingOptions({
  selectedProfessionalId: () => form.professional_user_id || null,
});

const professionalName = computed(() => {
  const m = new Map<string, string>();
  for (const p of professionals.value) m.set(String(p.id), p.display_name);
  return m;
});
const serviceName = computed(() => {
  const m = new Map<string, string>();
  for (const s of services.value) m.set(String(s.id), s.name);
  return m;
});

// A professional the row's service no longer offers must not stay selected; clear it once the
// narrowed options have loaded (an empty list is "not loaded yet", never a real narrowing).
watch(availableServiceOptions, (opts) => {
  if (opts.length === 0) return;
  if (form.service_id && !opts.some((o) => o.value === form.service_id)) form.service_id = '';
});

function clearErrors() {
  for (const key of Object.keys(fieldErrors)) delete fieldErrors[key];
}

function openCreate() {
  mode.value = 'create';
  editingId.value = null;
  form.professional_user_id = '';
  form.service_id = '';
  form.price_ars = '';
  clearErrors();
  panelOpen.value = true;
}

function openEdit(row: OverrideRow) {
  mode.value = 'edit';
  editingId.value = String(row.id);
  form.professional_user_id = String(row.professional_user_id);
  form.service_id = String(row.service_id);
  form.price_ars = String(row.price_ars ?? '');
  clearErrors();
  panelOpen.value = true;
}

// The shared SSoT validator drives every field error — including the money pattern (AMOUNT_PATTERN)
// on price_ars — so this form can't disagree with the backend on what is valid.
const FIELDS = ['professional_user_id', 'service_id', 'price_ars'] as const;

function validateForm(): boolean {
  clearErrors();
  let ok = true;
  for (const field of FIELDS) {
    const issue = validateFieldIssue(TABLE, field, form[field]);
    if (issue) {
      fieldErrors[field] = fieldErrorMessage(issue);
      ok = false;
    }
  }
  return ok;
}

function onBlurPrice() {
  const issue = validateFieldIssue(TABLE, 'price_ars', form.price_ars);
  if (issue) fieldErrors.price_ars = fieldErrorMessage(issue);
  else delete fieldErrors.price_ars;
}

async function submit() {
  if (!validateForm()) return;
  submitting.value = true;
  // price_ars is money: NUMERIC on the wire, never coerced — sent as a string verbatim.
  const body = {
    client_user_id: String(props.clientId),
    professional_user_id: form.professional_user_id,
    service_id: form.service_id,
    price_ars: form.price_ars,
  };
  const result =
    mode.value === 'edit' && editingId.value
      ? await updateRow(TABLE, editingId.value, body)
      : await createRow(TABLE, body);
  submitting.value = false;

  if (result.ok) {
    panelOpen.value = false;
    success('saved');
    await load();
    return;
  }
  const serverFieldErrors = fieldErrorMessages(result);
  if (Object.keys(serverFieldErrors).length > 0) Object.assign(fieldErrors, serverFieldErrors);
  else error('genericError');
}

async function load() {
  loading.value = true;
  const res = await listRows(TABLE, { filters: { client_user_id: String(props.clientId) }, limit: 200 });
  loading.value = false;
  overrides.value = res.ok ? res.data : [];
}

onMounted(load);
</script>

<template>
  <section v-if="canManage" class="space-y-3" data-testid="client-prices-section">
    <div class="flex items-center justify-between">
      <h2 class="text-lg font-semibold">{{ label(priceTable.title) }}</h2>
      <AppButton v-if="canCreate" variant="primary" data-testid="client-prices-add" @click="openCreate">
        {{ label(priceTable.addButtonLabel) }}
      </AppButton>
    </div>

    <Skeleton v-if="loading" variant="row" :rows="3" />

    <EmptyState
      v-else-if="overrides.length === 0"
      :heading="t('clientPrices.emptyHeading')"
      :body="t('clientPrices.emptyBody')"
    />

    <div v-else class="overflow-x-auto rounded-lg border border-border">
      <table class="min-w-full divide-y divide-border text-sm">
        <thead class="bg-surface">
          <tr>
            <th scope="col" class="px-4 py-3 text-left font-semibold">{{ label(columns.professional_user_id.label) }}</th>
            <th scope="col" class="px-4 py-3 text-left font-semibold">{{ label(columns.service_id.label) }}</th>
            <th scope="col" class="px-4 py-3 text-right font-semibold">{{ label(columns.price_ars.label) }}</th>
            <th v-if="canUpdate" scope="col" class="px-4 py-3 text-right font-semibold">
              {{ t('generic.actionsColumn') }}
            </th>
          </tr>
        </thead>
        <tbody class="divide-y divide-border bg-card">
          <tr v-for="row in overrides" :key="row.id" class="virtualized-row" :data-testid="`client-price-row-${row.id}`">
            <td class="px-4 py-3">
              {{ professionalName.get(String(row.professional_user_id)) ?? t('generic.unresolvedReference') }}
            </td>
            <td class="px-4 py-3">{{ serviceName.get(String(row.service_id)) ?? t('generic.unresolvedReference') }}</td>
            <td class="px-4 py-3 text-right tabular-nums">{{ formatARS(row.price_ars) }}</td>
            <td v-if="canUpdate" class="px-4 py-3 text-right">
              <button
                type="button"
                class="text-accent hover:underline text-xs"
                :data-testid="`client-price-edit-${row.id}`"
                @click="openEdit(row)"
              >
                {{ t('actions.edit') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <DetailPanel
      :open="panelOpen"
      :title="mode === 'edit' ? t('clientPrices.editTitle') : t('clientPrices.addTitle')"
      @close="panelOpen = false"
    >
      <form class="space-y-4" @submit.prevent="submit" novalidate>
        <div class="flex flex-col gap-1">
          <label class="text-sm font-semibold" for="client-price-professional">
            {{ label(columns.professional_user_id.label) }} <span class="text-destructive">*</span>
          </label>
          <Selector
            id="client-price-professional"
            searchable
            :model-value="form.professional_user_id || null"
            :options="professionalOptions"
            :placeholder="t('generic.selectPlaceholder')"
            @update:model-value="form.professional_user_id = $event ?? ''"
          />
          <FieldError :message="fieldErrors.professional_user_id" />
        </div>

        <div class="flex flex-col gap-1">
          <label class="text-sm font-semibold" for="client-price-service">
            {{ label(columns.service_id.label) }} <span class="text-destructive">*</span>
          </label>
          <Selector
            id="client-price-service"
            searchable
            :model-value="form.service_id || null"
            :options="availableServiceOptions"
            :placeholder="t('generic.selectPlaceholder')"
            @update:model-value="form.service_id = $event ?? ''"
          />
          <p class="text-xs text-neutral">{{ t('clientPrices.narrowedHint') }}</p>
          <FieldError :message="fieldErrors.service_id" />
        </div>

        <div class="flex flex-col gap-1">
          <label class="text-sm font-semibold" for="client-price-amount">
            {{ label(columns.price_ars.label) }} <span class="text-destructive">*</span>
          </label>
          <input
            id="client-price-amount"
            v-model="form.price_ars"
            type="text"
            inputmode="decimal"
            :pattern="AMOUNT_PATTERN"
            class="rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent tabular-nums"
            :class="fieldErrors.price_ars ? 'border-destructive' : ''"
            @blur="onBlurPrice"
          />
          <FieldError :message="fieldErrors.price_ars" />
        </div>

        <div class="flex justify-end gap-3 pt-2">
          <AppButton variant="neutral" type="button" @click="panelOpen = false">
            {{ t('actions.cancel') }}
          </AppButton>
          <AppButton type="submit" :loading="submitting">
            {{ t('actions.save') }}
          </AppButton>
        </div>
      </form>
    </DetailPanel>
  </section>
</template>

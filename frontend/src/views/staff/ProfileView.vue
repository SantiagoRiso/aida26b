<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { apiErrorMessage } from '@/i18n/api-errors';
import { useToast } from '@/composables/useToast';
import { useAuthStore } from '@/stores/auth';
import { getMyProfile, updateMyProfile } from '@/api/profile';
import { listRows, updateRow } from '@/api/crud';
import { useForeignKeyOptions } from '@/composables/useForeignKeyOptions';
import AppButton from '@/components/shared/AppButton.vue';
import FieldError from '@/components/shared/FieldError.vue';
import CalendarGrantsSection from '@/components/settings/CalendarGrantsSection.vue';
import MyExceptionsSection from '@/components/settings/MyExceptionsSection.vue';
import ChangePasswordSection from '@/components/settings/ChangePasswordSection.vue';
import { useLabel } from '@/composables/useLabel';
import { structure } from '@shared/ssot/structure';
import type { TableRecordMap } from '@shared/ssot/derived';

const { t } = useI18n();
const { success } = useToast();
const auth = useAuthStore();
const { label } = useLabel();
const usersColumns = structure.tables.users.columns;
const professionalColumns = structure.tables.professionals.columns;
const clientColumns = structure.tables.clients.columns;

const loading = ref(true);
const saving = ref(false);
const formError = ref('');
const form = reactive({ display_name: '', bio: '', email: '', phone: '' });

onMounted(async () => {
  try {
    const res = await getMyProfile();
    if (res.ok) {
      const p = res.data.profile;
      Object.assign(form, {
        display_name: p.display_name, bio: p.bio ?? '', email: p.email ?? '', phone: p.phone ?? '',
      });
    } else {
      // Blank fields would read as an empty profile and overwrite it on the next save.
      formError.value = apiErrorMessage(res, 'profile.loadError');
    }
  } finally {
    loading.value = false;
  }
});

async function saveProfile() {
  formError.value = '';
  saving.value = true;
  const res = await updateMyProfile({
    display_name: form.display_name.trim(),
    bio: form.bio.trim() || null,
    email: form.email.trim() || null,
    phone: form.phone.trim() || null,
  });
  saving.value = false;
  if (res.ok) {
    await auth.fetchMe();
    success('saved');
  } else {
    formError.value = apiErrorMessage(res, 'profile.saveError');
  }
}

const { labelFor: serviceLabelFor } = useForeignKeyOptions({ table: 'services', valueField: 'id', labelField: 'name' });

interface SvcOverride { id: string; service_id: string; min: number | ''; max: number | ''; saving: boolean; error: string }
const svcRows = ref<SvcOverride[]>([]);
const svcLoading = ref(true);
const svcLoadError = ref('');

async function loadServices() {
  const uid = auth.user?.id;
  if (uid == null) { svcLoading.value = false; return; }
  svcLoadError.value = '';
  try {
    const res = await listRows('professional_services', { filters: { professional_user_id: String(uid) }, limit: 500 });
    if (res.ok) {
      svcRows.value = res.data.map((r) => ({
        id: String(r.id),
        service_id: String(r.service_id),
        min: r.min_booking_days ?? '',
        max: r.max_booking_days ?? '',
        saving: false,
        error: '',
      }));
    } else {
      // An empty list would read as "no services assigned", which is a different fact.
      svcRows.value = [];
      svcLoadError.value = apiErrorMessage(res, 'profile.servicesLoadError');
    }
  } finally {
    svcLoading.value = false;
  }
}
onMounted(loadServices);

async function saveSvc(row: SvcOverride) {
  row.saving = true;
  row.error = '';
  const body: Partial<TableRecordMap['professional_services']> = {
    min_booking_days: row.min === '' ? null : Number(row.min),
    max_booking_days: row.max === '' ? null : Number(row.max),
  };
  try {
    const res = await updateRow('professional_services', row.id, body);
    // The edited value stays on screen either way, so a rejected write has to say so.
    if (res.ok) success('saved');
    else row.error = apiErrorMessage(res, 'profile.serviceSaveError');
  } finally {
    row.saving = false;
  }
}
</script>

<template>
  <!-- No page padding here — the layout's <main> already provides it; matches Clientes/Horario/Calendario. -->
  <div class="space-y-6">
    <h1 class="text-2xl font-semibold">
      {{ t('nav.profile') }}
    </h1>

    <div class="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
      <section v-if="!loading" class="rounded-lg border border-border bg-card p-5 space-y-4">
        <h2 class="text-lg font-semibold text-heading">{{ t('profile.personalDetails') }}</h2>
        <div class="flex flex-col gap-1">
          <label for="pf-name" class="text-sm font-semibold">{{ t('fields.displayName') }}</label>
          <input id="pf-name" v-model="form.display_name" type="text"
            class="max-w-md rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
        </div>
        <div class="flex flex-col gap-1">
          <label for="pf-email" class="text-sm font-semibold">{{ label(usersColumns.email.label) }}</label>
          <input id="pf-email" v-model="form.email" type="email"
            class="max-w-md rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
        </div>
        <div class="flex flex-col gap-1">
          <label for="pf-phone" class="text-sm font-semibold">{{ label(clientColumns.phone.label) }}</label>
          <input id="pf-phone" v-model="form.phone" type="text"
            class="max-w-md rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
        </div>
        <div class="flex flex-col gap-1">
          <label for="pf-bio" class="text-sm font-semibold">{{ label(professionalColumns.bio.label) }}</label>
          <textarea id="pf-bio" v-model="form.bio" rows="3"
            class="max-w-md rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
        </div>
        <FieldError :message="formError" />
        <AppButton id="pf-save" variant="primary" :loading="saving" @click="saveProfile">
          {{ t('actions.save') }}
        </AppButton>
      </section>

      <section class="rounded-lg border border-border bg-card p-5 space-y-4">
        <h2 class="text-lg font-semibold text-heading">{{ t('profile.myServices') }}</h2>
        <p class="text-sm text-neutral">
          {{ t('profile.bookingWindowHint') }}
        </p>
        <div v-if="svcLoading" class="text-sm text-neutral">…</div>
        <FieldError v-else-if="svcLoadError" :message="svcLoadError" />
        <p v-else-if="svcRows.length === 0" class="text-sm text-neutral">
          {{ t('profile.noServices') }}
        </p>
        <div v-else class="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-x-3 gap-y-2 text-sm">
          <div></div>
          <div class="w-20 text-center text-xs font-medium text-neutral">{{ t('profile.minCol') }}</div>
          <div class="w-20 text-center text-xs font-medium text-neutral">{{ t('profile.maxCol') }}</div>
          <div></div>
          <template v-for="row in svcRows" :key="row.id">
            <div class="truncate font-medium">{{ serviceLabelFor(row.service_id) ?? row.service_id }}</div>
            <input v-model="row.min" type="number" min="0" class="w-20 rounded-md border border-border px-2 py-1 text-sm tabular-nums" />
            <input v-model="row.max" type="number" min="0" class="w-20 rounded-md border border-border px-2 py-1 text-sm tabular-nums" />
            <AppButton variant="neutral" :loading="row.saving" @click="saveSvc(row)">
              {{ t('actions.save') }}
            </AppButton>
            <div v-if="row.error" class="col-span-4">
              <FieldError :message="row.error" />
            </div>
          </template>
        </div>
      </section>

      <section class="rounded-lg border border-border bg-card p-5 space-y-4">
        <h2 class="text-lg font-semibold text-heading">{{ t('actions.changePassword') }}</h2>
        <ChangePasswordSection
          current-password-id="pf-cur"
          new-password-id="pf-new"
          submit-id="pf-pw-save"
        />
      </section>

      <section v-if="auth.user?.role === 'Professional'" class="rounded-lg border border-border bg-card p-5 space-y-4">
        <h2 class="text-lg font-semibold text-heading">{{ t('profile.myTimeOff') }}</h2>
        <MyExceptionsSection />
      </section>

      <section class="rounded-lg border border-border bg-card p-5 space-y-4">
        <h2 class="text-lg font-semibold text-heading">{{ t('profile.whoManages') }}</h2>
        <CalendarGrantsSection :professional-user-id="auth.user?.id ?? null" />
      </section>
    </div>
  </div>
</template>

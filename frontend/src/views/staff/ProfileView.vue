<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useToast } from '@/composables/useToast';
import { useAuthStore } from '@/stores/auth';
import { getMyProfile, updateMyProfile } from '@/api/profile';
import { listRows, updateRow } from '@/api/crud';
import { useForeignKeyOptions } from '@/composables/useForeignKeyOptions';
import AppButton from '@/components/shared/AppButton.vue';
import FieldError from '@/components/shared/FieldError.vue';
import PasswordInput from '@/components/shared/PasswordInput.vue';
import CalendarGrantsSection from '@/components/settings/CalendarGrantsSection.vue';
import MyExceptionsSection from '@/components/settings/MyExceptionsSection.vue';
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
  const res = await getMyProfile();
  if (res.ok) {
    const p = res.data.profile;
    Object.assign(form, {
      display_name: p.display_name, bio: p.bio ?? '', email: p.email, phone: p.phone ?? '',
    });
  }
  loading.value = false;
});

async function saveProfile() {
  formError.value = '';
  saving.value = true;
  const res = await updateMyProfile({
    display_name: form.display_name.trim(),
    bio: form.bio.trim() || null,
    email: form.email.trim(),
    phone: form.phone.trim() || null,
  });
  saving.value = false;
  if (res.ok) {
    await auth.fetchMe();
    success('saved');
  } else {
    formError.value = res.message ?? t('profile.saveError');
  }
}

const pw = reactive({ current: '', next: '' });
const pwError = ref('');
const pwSaving = ref(false);
async function changePassword() {
  pwError.value = '';
  pwSaving.value = true;
  const res = await auth.changePassword(pw.current, pw.next);
  pwSaving.value = false;
  if (res.ok) { pw.current = ''; pw.next = ''; success('saved'); }
  else { pwError.value = res.message ?? t('profile.changePasswordError'); }
}

const { labelFor: serviceLabelFor } = useForeignKeyOptions({ table: 'services', valueField: 'id', labelField: 'name' });

interface SvcOverride { id: string; service_id: string; min: number | ''; max: number | ''; saving: boolean }
const svcRows = ref<SvcOverride[]>([]);
const svcLoading = ref(true);

async function loadServices() {
  const uid = auth.user?.id;
  if (uid == null) { svcLoading.value = false; return; }
  const res = await listRows('professional_services', { filters: { professional_user_id: String(uid) }, limit: 500 });
  if (res.ok) {
    svcRows.value = res.data.map((r) => ({
      id: String(r.id),
      service_id: String(r.service_id),
      min: r.min_booking_days ?? '',
      max: r.max_booking_days ?? '',
      saving: false,
    }));
  }
  svcLoading.value = false;
}
onMounted(loadServices);

async function saveSvc(row: SvcOverride) {
  row.saving = true;
  const body: Partial<TableRecordMap['professional_services']> = {
    min_booking_days: row.min === '' ? null : Number(row.min),
    max_booking_days: row.max === '' ? null : Number(row.max),
  };
  const res = await updateRow('professional_services', row.id, body);
  row.saving = false;
  if (res.ok) success('saved');
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
        <p v-else-if="svcRows.length === 0" class="text-sm text-neutral">
          {{ t('profile.noServices') }}
        </p>
        <div v-else class="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-3 gap-y-2 text-sm">
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
          </template>
        </div>
      </section>

      <section class="rounded-lg border border-border bg-card p-5 space-y-4">
        <h2 class="text-lg font-semibold text-heading">{{ t('actions.changePassword') }}</h2>
        <div class="flex flex-col gap-1">
          <label for="pf-cur" class="text-sm font-semibold">{{ t('auth.currentPasswordLabel') }}</label>
          <PasswordInput id="pf-cur" v-model="pw.current"
            input-class="w-full max-w-md rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
        </div>
        <div class="flex flex-col gap-1">
          <label for="pf-new" class="text-sm font-semibold">{{ t('auth.newPasswordLabel') }}</label>
          <PasswordInput id="pf-new" v-model="pw.next"
            input-class="w-full max-w-md rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
        </div>
        <FieldError :message="pwError" />
        <AppButton id="pf-pw-save" variant="primary" :loading="pwSaving" @click="changePassword">
          {{ t('actions.changePassword') }}
        </AppButton>
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

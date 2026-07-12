<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue';
import { useLabel } from '@/composables/useLabel';
import { useToast } from '@/composables/useToast';
import { useAuthStore } from '@/stores/auth';
import { getMyProfile, updateMyProfile } from '@/api/profile';
import { listRows, updateRow } from '@/api/crud';
import { useForeignKeyOptions } from '@/composables/useForeignKeyOptions';
import AppButton from '@/components/shared/AppButton.vue';
import FieldError from '@/components/shared/FieldError.vue';
import PasswordInput from '@/components/shared/PasswordInput.vue';
import type { ColumnValue, TableRecordMap } from '@shared/types/types';

const { label } = useLabel();
const { success } = useToast();
const auth = useAuthStore();

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
    formError.value = res.message ?? label({ es: 'No se pudo guardar el perfil.', en: 'Could not save the profile.' });
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
  else { pwError.value = res.message ?? label({ es: 'No se pudo cambiar la contraseña.', en: 'Could not change the password.' }); }
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
      min: (r.min_booking_days as number | null) ?? '',
      max: (r.max_booking_days as number | null) ?? '',
      saving: false,
    }));
  }
  svcLoading.value = false;
}
onMounted(loadServices);

async function saveSvc(row: SvcOverride) {
  row.saving = true;
  const body: Record<string, ColumnValue | undefined> = {
    min_booking_days: row.min === '' ? null : Number(row.min),
    max_booking_days: row.max === '' ? null : Number(row.max),
  };
  const res = await updateRow('professional_services', row.id, body as Partial<TableRecordMap['professional_services']>);
  row.saving = false;
  if (res.ok) success('saved');
}
</script>

<template>
  <div class="p-6 space-y-8 max-w-2xl">
    <h1 class="text-[28px] font-semibold leading-tight text-heading">
      {{ label({ es: 'Perfil', en: 'Profile' }) }}
    </h1>

    <section v-if="!loading" class="rounded-lg border border-border bg-card p-5 space-y-4">
      <div class="flex flex-col gap-1">
        <label for="pf-name" class="text-sm font-semibold">{{ label({ es: 'Nombre visible', en: 'Display name' }) }}</label>
        <input id="pf-name" v-model="form.display_name" type="text"
          class="rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
      </div>
      <div class="flex flex-col gap-1">
        <label for="pf-email" class="text-sm font-semibold">{{ label({ es: 'Email', en: 'Email' }) }}</label>
        <input id="pf-email" v-model="form.email" type="email"
          class="rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
      </div>
      <div class="flex flex-col gap-1">
        <label for="pf-phone" class="text-sm font-semibold">{{ label({ es: 'Teléfono', en: 'Phone' }) }}</label>
        <input id="pf-phone" v-model="form.phone" type="text"
          class="rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
      </div>
      <div class="flex flex-col gap-1">
        <label for="pf-bio" class="text-sm font-semibold">{{ label({ es: 'Biografía', en: 'Bio' }) }}</label>
        <textarea id="pf-bio" v-model="form.bio" rows="3"
          class="rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
      </div>
      <FieldError :message="formError" />
      <AppButton id="pf-save" variant="primary" :loading="saving" @click="saveProfile">
        {{ label({ es: 'Guardar', en: 'Save' }) }}
      </AppButton>
    </section>

    <section class="rounded-lg border border-border bg-card p-5 space-y-4">
      <h2 class="text-lg font-semibold text-heading">{{ label({ es: 'Cambiar contraseña', en: 'Change password' }) }}</h2>
      <div class="flex flex-col gap-1">
        <label for="pf-cur" class="text-sm font-semibold">{{ label({ es: 'Contraseña actual', en: 'Current password' }) }}</label>
        <PasswordInput id="pf-cur" v-model="pw.current"
          input-class="w-full rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
      </div>
      <div class="flex flex-col gap-1">
        <label for="pf-new" class="text-sm font-semibold">{{ label({ es: 'Nueva contraseña', en: 'New password' }) }}</label>
        <PasswordInput id="pf-new" v-model="pw.next"
          input-class="w-full rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent" />
      </div>
      <FieldError :message="pwError" />
      <AppButton id="pf-pw-save" variant="primary" :loading="pwSaving" @click="changePassword">
        {{ label({ es: 'Cambiar contraseña', en: 'Change password' }) }}
      </AppButton>
    </section>

    <section class="rounded-lg border border-border bg-card p-5 space-y-4">
      <h2 class="text-lg font-semibold text-heading">{{ label({ es: 'Mis servicios', en: 'My services' }) }}</h2>
      <p class="text-sm text-neutral">
        {{ label({ es: 'Anticipación de reserva por servicio. Vacío = usa el valor del negocio.', en: 'Per-service booking window. Empty = uses the business default.' }) }}
      </p>
      <div v-if="svcLoading" class="text-sm text-neutral">…</div>
      <p v-else-if="svcRows.length === 0" class="text-sm text-neutral">
        {{ label({ es: 'No tenés servicios asignados.', en: 'You have no assigned services.' }) }}
      </p>
      <div v-else class="space-y-3">
        <div v-for="row in svcRows" :key="row.id" class="flex flex-wrap items-end gap-3 border-b border-border pb-3">
          <div class="min-w-[10rem] flex-1 text-sm font-medium">{{ serviceLabelFor(row.service_id) ?? row.service_id }}</div>
          <label class="flex flex-col gap-1 text-xs text-neutral">
            {{ label({ es: 'Mín (días)', en: 'Min (days)' }) }}
            <input v-model="row.min" type="number" min="0" class="w-24 rounded-md border border-border px-2 py-1 text-sm tabular-nums" />
          </label>
          <label class="flex flex-col gap-1 text-xs text-neutral">
            {{ label({ es: 'Máx (días)', en: 'Max (days)' }) }}
            <input v-model="row.max" type="number" min="0" class="w-24 rounded-md border border-border px-2 py-1 text-sm tabular-nums" />
          </label>
          <AppButton variant="neutral" :loading="row.saving" @click="saveSvc(row)">
            {{ label({ es: 'Guardar', en: 'Save' }) }}
          </AppButton>
        </div>
      </div>
    </section>

    <!-- Mount point: "Quién gestiona mi calendario" grants panel — Section 3 (staff & client mgmt). -->
  </div>
</template>

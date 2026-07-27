<script setup lang="ts">
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '@/stores/auth';
import ChangePasswordSection from '@/components/settings/ChangePasswordSection.vue';

const { t } = useI18n();
const router = useRouter();
const auth = useAuthStore();

async function onChanged() {
  if (auth.user?.role === 'Client') {
    await router.push({ name: 'portal-appointments' });
  } else {
    await router.push({ name: 'staff-dashboard' });
  }
}

// A user forced to change their password is otherwise trapped on this screen; give them a way out.
async function logout() {
  await auth.logout();
  await router.push({ name: 'login' });
}
</script>

<template>
  <!-- Full-screen blocking form: guard prevents leaving while must_change_password is true. -->
  <main class="flex min-h-screen flex-col items-center justify-center bg-surface px-4">
    <div class="w-full max-w-sm rounded-xl bg-card p-8 shadow-sm border border-border">
      <div class="mb-6 rounded-md bg-warning-tint border border-warning-tint-border px-4 py-3 text-sm text-warning-strong font-semibold">
        {{ t('auth.mustChangeBanner') }}
      </div>

      <h1 class="mb-6 text-xl font-semibold">{{ t('actions.changePassword') }}</h1>

      <ChangePasswordSection button-full-width :toast-on-success="false" @success="onChanged" />

      <button
        type="button"
        class="mt-4 w-full text-center text-sm text-neutral hover:underline"
        @click="logout"
      >
        {{ t('nav.logout') }}
      </button>
    </div>
  </main>
</template>

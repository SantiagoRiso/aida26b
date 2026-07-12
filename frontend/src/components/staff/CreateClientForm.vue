<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useLabel } from '@/composables/useLabel';
import { createUser } from '@/api/admin-users';
import FieldError from '@/components/shared/FieldError.vue';
import AppButton from '@/components/shared/AppButton.vue';
import PasswordInput from '@/components/shared/PasswordInput.vue';

const emit = defineEmits<{
  created: [];
  cancel: [];
}>();

const { label } = useLabel();

const submitting = ref(false);
const error = ref('');
const enableLogin = ref(false);

const form = reactive({
  display_name: '',
  email: '',
  dni: '',
  username: '',
  password: '',
});

async function submit() {
  submitting.value = true;
  error.value = '';
  try {
    const result = await createUser({
      role: 'Client',
      display_name: form.display_name,
      email: form.email,
      dni: form.dni || undefined,
      ...(enableLogin.value ? { username: form.username, password: form.password } : {}),
    });
    if (result.ok) {
      emit('created');
    } else {
      error.value = result.message ?? label({ es: 'Error creando cliente', en: 'Error creating client' });
    }
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <form class="space-y-4" @submit.prevent="submit" novalidate>
    <FieldError :message="error" />

    <div class="flex flex-col gap-1">
      <label for="create-client-display-name" class="text-sm font-semibold">
        {{ label({ es: 'Nombre visible', en: 'Display name' }) }} <span class="text-destructive">*</span>
      </label>
      <input
        id="create-client-display-name"
        v-model="form.display_name"
        type="text"
        class="rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        required
      />
    </div>

    <div class="flex flex-col gap-1">
      <label for="create-client-email" class="text-sm font-semibold">
        {{ label({ es: 'Email', en: 'Email' }) }} <span class="text-destructive">*</span>
      </label>
      <input
        id="create-client-email"
        v-model="form.email"
        type="email"
        class="rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        required
      />
    </div>

    <div class="flex flex-col gap-1">
      <label for="create-client-dni" class="text-sm font-semibold">{{ label({ es: 'DNI', en: 'DNI' }) }}</label>
      <input
        id="create-client-dni"
        v-model="form.dni"
        type="text"
        class="rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
      />
    </div>

    <!-- Phone is set later via the client edit form, not at creation time. -->

    <label class="flex items-center gap-2 text-sm">
      <input type="checkbox" v-model="enableLogin" class="accent-accent" />
      {{ label({ es: 'Crear usuario', en: 'Create user' }) }}
    </label>

    <template v-if="enableLogin">
      <div class="flex flex-col gap-1">
        <label for="create-client-username" class="text-sm font-semibold">
          {{ label({ es: 'Usuario', en: 'Username' }) }} <span class="text-destructive">*</span>
        </label>
        <input
          id="create-client-username"
          v-model="form.username"
          type="text"
          class="rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          required
        />
      </div>

      <div class="flex flex-col gap-1">
        <label for="create-client-password" class="text-sm font-semibold">
          {{ label({ es: 'Contraseña', en: 'Password' }) }} <span class="text-destructive">*</span>
        </label>
        <PasswordInput
          id="create-client-password"
          v-model="form.password"
          input-class="w-full rounded-md border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          required
        />
      </div>
    </template>

    <div class="flex justify-end gap-3 pt-2">
      <AppButton variant="neutral" type="button" @click="emit('cancel')">
        {{ label({ es: 'Cancelar', en: 'Cancel' }) }}
      </AppButton>
      <AppButton type="submit" :loading="submitting">
        {{ label({ es: 'Guardar', en: 'Save' }) }}
      </AppButton>
    </div>
  </form>
</template>

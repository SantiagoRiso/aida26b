<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { EyeIcon, EyeSlashIcon } from '@heroicons/vue/24/outline';

// Reveal is per-render only — never persisted, always starts hidden.
const model = defineModel<string>({ default: '' });

defineProps<{
  id?: string;
  autocomplete?: string;
  required?: boolean;
  inputClass?: string | string[];
}>();

const { t } = useI18n();
const visible = ref(false);
</script>

<template>
  <div class="relative">
    <input
      :id="id"
      v-model="model"
      :type="visible ? 'text' : 'password'"
      :autocomplete="autocomplete"
      :required="required"
      :class="[inputClass, 'pr-10']"
    />
    <button
      type="button"
      class="absolute inset-y-0 right-0 flex items-center px-3 text-neutral hover:text-accent"
      :aria-label="visible ? t('auth.hidePassword') : t('auth.showPassword')"
      @click="visible = !visible"
    >
      <EyeSlashIcon v-if="visible" class="h-5 w-5" aria-hidden="true" />
      <EyeIcon v-else class="h-5 w-5" aria-hidden="true" />
    </button>
  </div>
</template>

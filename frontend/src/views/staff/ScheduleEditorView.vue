<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import ProfessionalPicker from '@/components/schedule/ProfessionalPicker.vue';
import ScheduleBlockEditor from '@/components/schedule/ScheduleBlockEditor.vue';

const { t } = useI18n();
const professionalId = ref<number | null>(null);
</script>

<template>
  <section class="flex flex-col gap-4">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <h1 class="text-2xl font-semibold">{{ t('schedule.title') }}</h1>
      <ProfessionalPicker v-model="professionalId" />
    </div>
    <p
      v-if="professionalId == null"
      class="rounded-lg border border-dashed border-border bg-card px-4 py-10 text-center text-sm text-neutral"
    >
      {{ t('schedule.noProfessional') }}
    </p>
    <ScheduleBlockEditor v-else :owner="{ kind: 'professional', id: professionalId }" />
  </section>
</template>

<script setup lang="ts">
// All user-entered text renders via {{ }} — never v-html — to prevent injection.

import type { EventContentArg } from '@fullcalendar/core';

const props = defineProps<{
  eventArg: EventContentArg;
}>();

const STATE_ICONS: Record<string, string> = {
  requested: '●',
  scheduled: '✓',
  completed: '★',
  canceled: '✕',
  no_show: '–',
  rejected: '✕',
};

const state: string = props.eventArg.event.extendedProps['appointment']?.state ?? '';
const icon = STATE_ICONS[state] ?? '';
const title = props.eventArg.event.title;
const apptId: number | undefined = props.eventArg.event.extendedProps['appointment']?.id;
const timeText = props.eventArg.timeText;
</script>

<template>
  <div
    class="fc-event-chip"
    :data-testid="apptId ? `appt-${apptId}` : undefined"
    :data-appt-state="state || undefined"
  >
    <span class="fc-event-chip__icon" aria-hidden="true">{{ icon }}</span>
    <span class="fc-event-chip__time">{{ timeText }}</span>
    <span class="fc-event-chip__title">{{ title }}</span>
  </div>
</template>

<style scoped>
.fc-event-chip {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  overflow: hidden;
  padding: 2px 4px;
  font-size: 12px;
  line-height: 1.3;
}

.fc-event-chip__icon {
  flex-shrink: 0;
  font-size: 10px;
}

.fc-event-chip__time {
  flex-shrink: 0;
  font-weight: 600;
  white-space: nowrap;
}

.fc-event-chip__title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>

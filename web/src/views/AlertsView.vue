<script setup lang="ts">
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAlerts, type Notification } from '../stores/alerts';
import { formatDate } from '../lib/format';

const alerts = useAlerts();
const router = useRouter();

const ICONS: Record<string, string> = {
  'submissions.open': '🎬',
  'submissions.closing': '⏳',
  'voting.open': '🗳️',
  'voting.closing': '⏳',
  'results.posted': '📊',
  'round.voided': '🚫',
  'prompt.your-turn': '🏆',
  'coins.earned': '🪙',
};

function open(n: Notification): void {
  if (n.payload.roundId) void router.push(`/rounds/${n.payload.roundId}`);
  else if (n.payload.leagueId) void router.push(`/leagues/${n.payload.leagueId}`);
}

onMounted(() => {
  void alerts.refresh().then(() => alerts.markAll());
});
</script>

<template>
  <div>
    <h1 class="mb-4 text-2xl font-bold">Notifications</h1>
    <div v-if="alerts.notifications.length === 0" class="rounded-xl border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
      Nothing yet — you'll hear about submissions, voting, and results here.
    </div>
    <div class="space-y-1">
      <button
        v-for="n in alerts.notifications"
        :key="n.id"
        class="flex w-full items-start gap-3 rounded-lg p-3 text-left hover:bg-neutral-100 dark:hover:bg-neutral-900"
        :class="!n.read ? 'bg-amber-50 dark:bg-amber-950/30' : ''"
        @click="open(n)"
      >
        <span class="text-xl">{{ ICONS[n.type] ?? '🔔' }}</span>
        <div class="flex-1">
          <p class="text-sm font-medium">{{ n.payload.title }}</p>
          <p v-if="n.payload.body" class="text-xs text-neutral-500">{{ n.payload.body }}</p>
          <p class="mt-0.5 text-xs text-neutral-400">{{ formatDate(n.createdAt) }}</p>
        </div>
      </button>
    </div>
  </div>
</template>

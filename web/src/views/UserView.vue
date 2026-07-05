<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, RouterLink } from 'vue-router';
import { api } from '../api';
import UserAvatar from '../components/UserAvatar.vue';

const route = useRoute();

interface Profile {
  user: { id: number; username: string; displayName: string | null; avatar: { kind: string; id?: string; color: string }; equipped: Record<string, string> };
  stats: { roundsPlayed: number; totalPoints: number; wins: number; avgPoints: number };
  recentSubmissions: { title: string; year: number | null; imageUrl: string | null; score: number | null; placement: number | null; prompt: string | null }[];
}

const profile = ref<Profile | null>(null);

onMounted(async () => {
  profile.value = await api.get<Profile>(`/api/users/${route.params.id}/profile`);
});
</script>

<template>
  <div v-if="profile">
    <RouterLink to="/" class="text-sm text-neutral-500">← Home</RouterLink>
    <div class="mt-2 flex items-center gap-4">
      <UserAvatar :username="profile.user.username" :display-name="profile.user.displayName" :avatar="profile.user.avatar" :user-id="profile.user.id" size="lg" />
      <div>
        <h1 class="text-2xl font-bold">{{ profile.user.displayName || profile.user.username }}</h1>
        <p class="text-sm text-neutral-500">@{{ profile.user.username }}</p>
      </div>
    </div>

    <div class="mt-4 grid grid-cols-4 gap-2 text-center">
      <div v-for="[label, value] in [['rounds', profile.stats.roundsPlayed], ['wins', profile.stats.wins], ['points', profile.stats.totalPoints], ['avg', profile.stats.avgPoints]] as const" :key="label" class="rounded-xl border border-neutral-200 p-3 dark:border-neutral-800">
        <div class="text-lg font-bold">{{ value }}</div>
        <div class="text-xs text-neutral-500">{{ label }}</div>
      </div>
    </div>

    <section class="mt-6">
      <h2 class="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-500">Recent submissions</h2>
      <div v-for="(s, i) in profile.recentSubmissions" :key="i" class="flex items-center gap-3 border-b border-neutral-100 py-2 dark:border-neutral-900">
        <img v-if="s.imageUrl" :src="s.imageUrl" class="h-12 w-8 rounded object-cover" />
        <div v-else class="flex h-12 w-8 items-center justify-center rounded bg-neutral-200 text-sm dark:bg-neutral-800">🎬</div>
        <div class="flex-1">
          <p class="text-sm font-medium">{{ s.title }} <span v-if="s.year" class="text-neutral-500">({{ s.year }})</span></p>
          <p class="text-xs text-neutral-500">{{ s.prompt }}</p>
        </div>
        <span v-if="s.placement === 1">🏆</span>
        <span class="text-sm font-bold">{{ s.score ?? 0 }}</span>
      </div>
      <p v-if="profile.recentSubmissions.length === 0" class="py-4 text-sm text-neutral-500">No finished rounds yet.</p>
    </section>
  </div>
</template>

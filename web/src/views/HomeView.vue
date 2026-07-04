<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { api } from '../api';
import { useAlerts } from '../stores/alerts';

interface GroupRow { id: number; name: string; role: string }
interface LeagueRow { id: number; name: string; mediaType: string; visibility: string; groupId?: number }

const groups = ref<GroupRow[]>([]);
const leagues = ref<LeagueRow[]>([]);
const loadingDone = ref(false);
const newGroupName = ref('');
const creating = ref(false);

useAlerts().startPolling();

async function load(): Promise<void> {
  const g = await api.get<{ groups: GroupRow[] }>('/api/groups');
  groups.value = g.groups;
  // Gather my leagues across groups (active rosters only).
  const seen = new Map<number, LeagueRow>();
  for (const group of g.groups) {
    const detail = await api.get<{ leagues: LeagueRow[] }>(`/api/groups/${group.id}`);
    for (const l of detail.leagues) seen.set(l.id, { ...l, groupId: group.id });
  }
  leagues.value = [...seen.values()];
  loadingDone.value = true;
}

async function createGroup(): Promise<void> {
  if (!newGroupName.value.trim()) return;
  await api.post('/api/groups', { name: newGroupName.value.trim() });
  newGroupName.value = '';
  creating.value = false;
  await load();
}

onMounted(load);
</script>

<template>
  <div>
    <h1 class="mb-4 text-2xl font-bold">Home</h1>

    <!-- Guided empty state (SPEC §16) -->
    <div v-if="loadingDone && groups.length === 0" class="rounded-xl border border-dashed border-neutral-300 p-8 text-center dark:border-neutral-700">
      <p class="text-3xl">🎬</p>
      <p class="mt-2 font-semibold">Welcome! No leagues yet.</p>
      <p class="mb-4 mt-1 text-sm text-neutral-500">Create a group for your friends, or open an invite link someone sent you.</p>
      <div class="mx-auto flex max-w-xs gap-2">
        <input v-model="newGroupName" placeholder="Group name" class="w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm dark:border-neutral-700" @keyup.enter="createGroup" />
        <button class="shrink-0 rounded-lg bg-amber-500 px-3 py-2 text-sm font-semibold text-white" @click="createGroup">Create</button>
      </div>
    </div>

    <template v-else-if="loadingDone">
      <section v-if="leagues.length" class="mb-6">
        <h2 class="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-500">Your leagues</h2>
        <div class="space-y-2">
          <RouterLink
            v-for="l in leagues"
            :key="l.id"
            :to="`/leagues/${l.id}`"
            class="block rounded-xl border border-neutral-200 p-4 hover:border-amber-400 dark:border-neutral-800"
          >
            <div class="font-semibold">{{ l.name }}</div>
            <div class="text-xs text-neutral-500">{{ l.mediaType }} · {{ l.visibility }}</div>
          </RouterLink>
        </div>
      </section>

      <section>
        <div class="mb-2 flex items-center justify-between">
          <h2 class="text-sm font-semibold uppercase tracking-wide text-neutral-500">Your groups</h2>
          <button class="text-sm text-amber-600 dark:text-amber-400" @click="creating = !creating">+ New group</button>
        </div>
        <div v-if="creating" class="mb-3 flex gap-2">
          <input v-model="newGroupName" placeholder="Group name" class="w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm dark:border-neutral-700" @keyup.enter="createGroup" />
          <button class="shrink-0 rounded-lg bg-amber-500 px-3 py-2 text-sm font-semibold text-white" @click="createGroup">Create</button>
        </div>
        <div class="space-y-2">
          <RouterLink
            v-for="g in groups"
            :key="g.id"
            :to="`/groups/${g.id}`"
            class="block rounded-xl border border-neutral-200 p-4 hover:border-amber-400 dark:border-neutral-800"
          >
            <div class="font-semibold">{{ g.name }}</div>
            <div class="text-xs text-neutral-500">{{ g.role === 'admin' ? '⭐ admin' : 'member' }}</div>
          </RouterLink>
        </div>
      </section>
    </template>
  </div>
</template>

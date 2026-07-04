<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, RouterLink } from 'vue-router';
import { api } from '../api';
import UserAvatar from '../components/UserAvatar.vue';

const route = useRoute();
const groupId = computed(() => Number(route.params.id));

interface Member { id: number; username: string; displayName: string | null; role: string }
interface League { id: number; name: string; mediaType: string; visibility: string }

const group = ref<{ id: number; name: string } | null>(null);
const members = ref<Member[]>([]);
const leagues = ref<League[]>([]);
const myRole = ref<string | null>(null);
const standingCode = ref<string | null>(null);
const showInvite = ref(false);
const creatingLeague = ref(false);
const newLeague = ref({ name: '', visibility: 'public' as 'public' | 'private' });
const copied = ref(false);

async function load(): Promise<void> {
  const res = await api.get<{ group: { id: number; name: string }; members: Member[]; leagues: League[]; myRole: string }>(
    `/api/groups/${groupId.value}`,
  );
  group.value = res.group;
  members.value = res.members;
  leagues.value = res.leagues;
  myRole.value = res.myRole;
  const inv = await api.get<{ standing: { code: string } | null }>(`/api/groups/${groupId.value}/invites`);
  standingCode.value = inv.standing?.code ?? null;
}

const inviteUrl = computed(() => (standingCode.value ? `${location.origin}/join/${standingCode.value}` : ''));

async function copyInvite(): Promise<void> {
  await navigator.clipboard.writeText(inviteUrl.value);
  copied.value = true;
  setTimeout(() => (copied.value = false), 1500);
}

async function regenerate(): Promise<void> {
  const res = await api.post<{ standing: { code: string } }>(`/api/groups/${groupId.value}/invites/standing/regenerate`);
  standingCode.value = res.standing.code;
}

async function createLeague(): Promise<void> {
  if (!newLeague.value.name.trim()) return;
  const res = await api.post<{ league: { id: number } }>(`/api/groups/${groupId.value}/leagues`, {
    name: newLeague.value.name.trim(),
    visibility: newLeague.value.visibility,
  });
  creatingLeague.value = false;
  newLeague.value = { name: '', visibility: 'public' };
  await load();
  void res;
}

onMounted(load);
</script>

<template>
  <div v-if="group">
    <RouterLink to="/" class="text-sm text-neutral-500">← Home</RouterLink>
    <div class="mt-1 flex items-center justify-between">
      <h1 class="text-2xl font-bold">{{ group.name }}</h1>
      <button class="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700" @click="showInvite = !showInvite">
        Share invite
      </button>
    </div>

    <div v-if="showInvite" class="mt-3 rounded-xl border border-neutral-200 p-4 text-sm dark:border-neutral-800">
      <p class="mb-2 font-semibold">Standing invite link</p>
      <div class="flex gap-2">
        <input :value="inviteUrl" readonly class="w-full rounded-lg border border-neutral-300 bg-neutral-50 px-2 py-1.5 text-xs dark:border-neutral-700 dark:bg-neutral-900" />
        <button class="shrink-0 rounded-lg bg-amber-500 px-3 py-1.5 text-white" @click="copyInvite">{{ copied ? '✓' : 'Copy' }}</button>
      </div>
      <button v-if="myRole === 'admin'" class="mt-2 text-xs text-neutral-500 underline" @click="regenerate">
        Regenerate (invalidates the old link)
      </button>
    </div>

    <section class="mt-6">
      <div class="mb-2 flex items-center justify-between">
        <h2 class="text-sm font-semibold uppercase tracking-wide text-neutral-500">Leagues</h2>
        <button class="text-sm text-amber-600 dark:text-amber-400" @click="creatingLeague = !creatingLeague">+ New league</button>
      </div>

      <div v-if="creatingLeague" class="mb-3 space-y-2 rounded-xl border border-neutral-200 p-3 dark:border-neutral-800">
        <input v-model="newLeague.name" placeholder="League name (e.g. Joe's Movie League)" class="w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm dark:border-neutral-700" />
        <div class="flex items-center gap-3 text-sm">
          <label class="flex items-center gap-1"><input v-model="newLeague.visibility" type="radio" value="public" /> Public</label>
          <label class="flex items-center gap-1"><input v-model="newLeague.visibility" type="radio" value="private" /> Private (invite-only)</label>
          <button class="ml-auto rounded-lg bg-amber-500 px-3 py-1.5 font-semibold text-white" @click="createLeague">Create</button>
        </div>
      </div>

      <!-- Guided empty state (SPEC §16) -->
      <div v-if="leagues.length === 0 && !creatingLeague" class="rounded-xl border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
        No leagues yet — create the first one for this group.
      </div>
      <div class="space-y-2">
        <RouterLink v-for="l in leagues" :key="l.id" :to="`/leagues/${l.id}`" class="block rounded-xl border border-neutral-200 p-4 hover:border-amber-400 dark:border-neutral-800">
          <div class="font-semibold">{{ l.name }}</div>
          <div class="text-xs text-neutral-500">{{ l.mediaType }} · {{ l.visibility }}</div>
        </RouterLink>
      </div>
    </section>

    <section class="mt-6">
      <h2 class="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-500">Members ({{ members.length }})</h2>
      <div class="space-y-1">
        <RouterLink v-for="m in members" :key="m.id" :to="`/users/${m.id}`" class="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-neutral-100 dark:hover:bg-neutral-900">
          <UserAvatar :username="m.username" :display-name="m.displayName" size="sm" />
          <span class="text-sm">{{ m.displayName || m.username }}</span>
          <span v-if="m.role === 'admin'" class="text-xs text-amber-600 dark:text-amber-400">⭐ admin</span>
        </RouterLink>
      </div>
    </section>
  </div>
</template>

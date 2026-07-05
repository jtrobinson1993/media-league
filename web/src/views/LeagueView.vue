<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, RouterLink } from 'vue-router';
import { api } from '../api';
import { useSession } from '../stores/session';
import { timeUntil, formatDate, PHASE_LABEL, PHASE_BADGE } from '../lib/format';
import UserAvatar from '../components/UserAvatar.vue';
import LeagueSettings from '../components/LeagueSettings.vue';

const route = useRoute();
const session = useSession();
const leagueId = computed(() => Number(route.params.id));

interface Round {
  id: number; number: number; promptTitle: string | null; phase: string;
  submitOpenAt: number; submitCloseAt: number; voteCloseAt: number; chooserId: number | null;
}
interface Standing { id: number; username: string; displayName: string | null; points: number; wins: number; rank: number }

const league = ref<{ id: number; name: string; visibility: string; promptMode: string } | null>(null);
const myRole = ref<string | null>(null);
const rounds = ref<Round[]>([]);
const standings = ref<Standing[]>([]);
const tab = ref<'rounds' | 'standings' | 'settings'>('rounds');
const standingCode = ref<string | null>(null);
const copied = ref(false);

// admin round creation
const newRound = ref({ promptTitle: '', submitDays: 3, voteDays: 3 });
const addingRound = ref(false);

async function load(): Promise<void> {
  const res = await api.get<{ league: typeof league.value; myRole: string | null }>(`/api/leagues/${leagueId.value}`);
  league.value = res.league;
  myRole.value = res.myRole;
  if (res.myRole) {
    const r = await api.get<{ rounds: Round[] }>(`/api/leagues/${leagueId.value}/rounds`);
    rounds.value = r.rounds;
    const s = await api.get<{ standings: Standing[] }>(`/api/leagues/${leagueId.value}/standings`);
    standings.value = s.standings;
    const inv = await api.get<{ standing: { code: string } | null }>(`/api/leagues/${leagueId.value}/invites`).catch(() => null);
    standingCode.value = inv?.standing?.code ?? null;
  }
}

async function join(): Promise<void> {
  await api.post(`/api/leagues/${leagueId.value}/join`);
  await load();
}

/** Rounds needing my action pin above the feed (SPEC §16). */
const actionable = computed(() => rounds.value.filter((r) => r.phase === 'submitting' || r.phase === 'voting'));
const feed = computed(() => rounds.value.filter((r) => !actionable.value.includes(r)));

function cta(r: Round): { label: string; hint: string } {
  if (r.phase === 'submitting') return { label: 'Pick your film', hint: timeUntil(r.submitCloseAt) };
  if (r.phase === 'voting') return { label: 'Vote now', hint: timeUntil(r.voteCloseAt) };
  if (r.phase === 'finished') return { label: 'See results', hint: '' };
  if (r.phase === 'voided') return { label: 'Voided', hint: '' };
  return { label: 'Scheduled', hint: `opens ${formatDate(r.submitOpenAt)}` };
}

async function addRound(): Promise<void> {
  const now = Date.now();
  const submitOpenAt = now;
  const submitCloseAt = now + newRound.value.submitDays * 86_400_000;
  const voteCloseAt = submitCloseAt + newRound.value.voteDays * 86_400_000;
  await api.post(`/api/leagues/${leagueId.value}/rounds`, {
    promptTitle: newRound.value.promptTitle || undefined,
    submitOpenAt,
    submitCloseAt,
    voteCloseAt,
  });
  addingRound.value = false;
  newRound.value.promptTitle = '';
  await load();
}

async function copyInvite(): Promise<void> {
  await navigator.clipboard.writeText(`${location.origin}/join/${standingCode.value}`);
  copied.value = true;
  setTimeout(() => (copied.value = false), 1500);
}

onMounted(load);
</script>

<template>
  <div v-if="league">
    <RouterLink to="/" class="text-sm text-neutral-500">← Home</RouterLink>
    <h1 class="mt-1 text-2xl font-bold">{{ league.name }}</h1>

    <div v-if="!myRole" class="mt-6 rounded-xl border border-dashed border-neutral-300 p-6 text-center dark:border-neutral-700">
      <p class="text-sm text-neutral-500">You're not in this league yet.</p>
      <button class="mt-3 rounded-lg bg-amber-500 px-4 py-2 font-semibold text-white" @click="join">Join league</button>
    </div>

    <template v-else>
      <div class="mt-3 flex gap-1 rounded-lg bg-neutral-100 p-1 text-sm dark:bg-neutral-900">
        <button v-for="t in ['rounds', 'standings', 'settings'] as const" :key="t" class="flex-1 rounded-md py-1.5 capitalize" :class="tab === t ? 'bg-white font-semibold shadow dark:bg-neutral-800' : 'text-neutral-500'" @click="tab = t">
          {{ t }}
        </button>
      </div>

      <!-- Timeline feed (SPEC §16) -->
      <div v-if="tab === 'rounds'" class="mt-4 space-y-2">
        <div v-if="myRole === 'admin'" class="text-right">
          <button class="text-sm text-amber-600 dark:text-amber-400" @click="addingRound = !addingRound">+ Add round</button>
        </div>
        <div v-if="addingRound" class="space-y-2 rounded-xl border border-neutral-200 p-3 text-sm dark:border-neutral-800">
          <input v-model="newRound.promptTitle" placeholder="Prompt (e.g. favorite indie horror) — leave blank to queue" class="w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 dark:border-neutral-700" />
          <div class="flex items-center gap-2">
            <label>Submit days <input v-model.number="newRound.submitDays" type="number" min="1" class="w-16 rounded border border-neutral-300 bg-transparent px-1 py-0.5 dark:border-neutral-700" /></label>
            <label>Vote days <input v-model.number="newRound.voteDays" type="number" min="1" class="w-16 rounded border border-neutral-300 bg-transparent px-1 py-0.5 dark:border-neutral-700" /></label>
            <button class="ml-auto rounded-lg bg-amber-500 px-3 py-1.5 font-semibold text-white" @click="addRound">Create</button>
          </div>
          <p class="text-xs text-neutral-500">Submissions open immediately; voting follows.</p>
        </div>

        <!-- Guided empty state (SPEC §16): admin checklist -->
        <div v-if="rounds.length === 0" class="rounded-xl border border-dashed border-neutral-300 p-6 text-sm text-neutral-500 dark:border-neutral-700">
          <template v-if="myRole === 'admin'">
            <p class="font-semibold text-neutral-700 dark:text-neutral-300">Get your league going:</p>
            <ul class="mt-2 list-inside space-y-1">
              <li>☐ Add your first round with a prompt</li>
              <li>☐ Share the invite link below</li>
            </ul>
            <button v-if="standingCode" class="mt-3 rounded-lg border border-neutral-300 px-3 py-1.5 dark:border-neutral-700" @click="copyInvite">
              {{ copied ? '✓ Copied' : 'Copy invite link' }}
            </button>
          </template>
          <template v-else>Round 1 hasn't been scheduled yet — check back soon.</template>
        </div>

        <RouterLink v-for="r in [...actionable, ...feed]" :key="r.id" :to="`/rounds/${r.id}`" class="block rounded-xl border p-4 hover:border-amber-400" :class="actionable.includes(r) ? 'border-amber-400 dark:border-amber-600' : 'border-neutral-200 dark:border-neutral-800'">
          <div class="flex items-center justify-between gap-2">
            <div>
              <div class="text-xs text-neutral-500">Round {{ r.number }}</div>
              <div class="font-semibold">{{ r.promptTitle ?? (r.chooserId ? 'Prompt: waiting on the winner…' : 'Prompt TBD') }}</div>
            </div>
            <div class="text-right">
              <span class="rounded-full px-2 py-0.5 text-xs font-semibold" :class="PHASE_BADGE[r.phase]">{{ PHASE_LABEL[r.phase] }}</span>
              <div class="mt-1 text-xs text-neutral-500">{{ cta(r).hint }}</div>
            </div>
          </div>
        </RouterLink>
      </div>

      <!-- Standings tab -->
      <div v-else-if="tab === 'standings'" class="mt-4">
        <div v-for="s in standings" :key="s.id" class="flex items-center gap-3 border-b border-neutral-100 py-2.5 dark:border-neutral-900">
          <span class="w-6 text-center font-bold" :class="s.rank === 1 ? 'text-amber-500' : 'text-neutral-400'">{{ s.rank }}</span>
          <UserAvatar :username="s.username" :display-name="s.displayName" size="sm" />
          <RouterLink :to="`/users/${s.id}`" class="flex-1 text-sm font-medium">{{ s.displayName || s.username }}</RouterLink>
          <span v-if="s.wins" class="text-xs text-neutral-500">🏆 {{ s.wins }}</span>
          <span class="font-bold">{{ s.points }}</span>
        </div>
        <p v-if="standings.length === 0" class="py-6 text-center text-sm text-neutral-500">No points yet.</p>
      </div>

      <!-- Settings/info tab -->
      <div v-else class="mt-4 space-y-3 text-sm">
        <div class="rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <p><span class="text-neutral-500">Visibility:</span> {{ league.visibility }}</p>
          <p><span class="text-neutral-500">Prompt mode:</span> {{ league.promptMode === 'admin' ? 'Admin writes prompts' : 'Winner picks the next prompt' }}</p>
        </div>
        <div v-if="standingCode" class="rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <p class="mb-2 font-semibold">Invite players</p>
          <button class="rounded-lg border border-neutral-300 px-3 py-1.5 dark:border-neutral-700" @click="copyInvite">
            {{ copied ? '✓ Copied' : 'Copy league invite link' }}
          </button>
          <p class="mt-1 text-xs text-neutral-500">The link also onboards people who aren't in the group yet.</p>
        </div>
        <LeagueSettings v-if="myRole === 'admin'" :league-id="leagueId" @saved="load" />
      </div>
    </template>
  </div>
</template>

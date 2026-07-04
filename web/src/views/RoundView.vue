<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, RouterLink } from 'vue-router';
import { api, ApiError } from '../api';
import { useSession } from '../stores/session';
import { timeUntil, formatDate, PHASE_LABEL, PHASE_BADGE } from '../lib/format';
import UserAvatar from '../components/UserAvatar.vue';

const route = useRoute();
const session = useSession();
const roundId = computed(() => Number(route.params.id));

interface Round {
  id: number; leagueId: number; number: number; promptTitle: string | null; promptDescription: string | null;
  chooserId: number | null; phase: string; submitOpenAt: number; submitCloseAt: number; voteCloseAt: number;
  votingConfig: { method: 'pool' | 'ranked'; totalPoints?: number; perItemCap?: number | null; mustSpendAll?: boolean; numRanks?: number };
}
interface Item { id: number; title: string; subtitle: string | null; year: number | null; imageUrl: string | null; isFreeText: boolean; mine?: boolean }
interface ResultItem extends Item {
  score: number; placement: number | null;
  submitters: { id: number; username: string; displayName: string | null }[];
  votes: { voter: { id: number; username: string; displayName: string | null } | null; points: number; rank: number | null; note: string | null }[];
}

const round = ref<Round | null>(null);
const myRole = ref<string | null>(null);
const error = ref('');

// submit phase
const mine = ref<Item | null>(null);
const query = ref('');
const results = ref<Item[]>([]);
const confirmItem = ref<Item | null>(null);
const freeTextMode = ref(false);
const freeText = ref('');
const searchDown = ref(false);
let searchTimer: ReturnType<typeof setTimeout> | null = null;

// voting phase
const ballotItems = ref<Item[]>([]);
const alloc = ref<Record<number, number>>({});
const ranks = ref<Record<number, number>>({});
const notes = ref<Record<number, string>>({});
const ballotSaved = ref(false);
const notEligible = ref('');

// results phase
const resultItems = ref<ResultItem[]>([]);
const expanded = ref<number | null>(null);

const cfg = computed(() => round.value?.votingConfig);
const spent = computed(() => Object.values(alloc.value).reduce((a, b) => a + b, 0));
const budget = computed(() => cfg.value?.totalPoints ?? 10);
const cap = computed(() => Math.min(cfg.value?.perItemCap ?? budget.value, budget.value));
const numRanks = computed(() => Math.min(cfg.value?.numRanks ?? 3, ballotItems.value.length));

async function load(): Promise<void> {
  const r = await api.get<{ round: Round }>(`/api/rounds/${roundId.value}`);
  round.value = r.round;
  const lg = await api.get<{ myRole: string | null }>(`/api/leagues/${r.round.leagueId}`);
  myRole.value = lg.myRole;

  if (r.round.phase === 'submitting' || r.round.phase === 'scheduled') {
    const subs = await api.get<{ mine: Item | null }>(`/api/rounds/${roundId.value}/submissions`);
    mine.value = subs.mine;
  } else if (r.round.phase === 'voting') {
    try {
      const b = await api.get<{ items: Item[]; myVotes: { submissionId: number; points: number; rank: number | null; note: string | null }[] }>(
        `/api/rounds/${roundId.value}/ballot`,
      );
      ballotItems.value = b.items;
      for (const v of b.myVotes) {
        if (v.rank) ranks.value[v.submissionId] = v.rank;
        else alloc.value[v.submissionId] = v.points;
        if (v.note) notes.value[v.submissionId] = v.note;
      }
      ballotSaved.value = b.myVotes.length > 0;
    } catch (e) {
      notEligible.value = e instanceof ApiError ? e.message : 'not eligible';
    }
  } else if (r.round.phase === 'finished') {
    const res = await api.get<{ items: ResultItem[] }>(`/api/rounds/${roundId.value}/results`);
    resultItems.value = res.items;
  }
}

function search(): void {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    if (!query.value.trim() || !round.value) return;
    try {
      const res = await api.get<{ items: Item[] }>(`/api/leagues/${round.value.leagueId}/search?q=${encodeURIComponent(query.value)}`);
      results.value = res.items;
      searchDown.value = false;
    } catch {
      searchDown.value = true; // provider down ⇒ free-text fallback (SPEC §11)
      results.value = [];
    }
  }, 300);
}

async function submitPick(): Promise<void> {
  error.value = '';
  try {
    const payload = freeTextMode.value
      ? { freeText: freeText.value }
      : { item: { providerType: 'tmdb', externalId: (confirmItem.value as Item & { externalId?: string }).externalId ?? String(confirmItem.value!.id), title: confirmItem.value!.title, subtitle: confirmItem.value!.subtitle, year: confirmItem.value!.year, imageUrl: confirmItem.value!.imageUrl } };
    const res = await api.put<{ submission: Item }>(`/api/rounds/${roundId.value}/submission`, payload);
    mine.value = res.submission;
    confirmItem.value = null;
    freeTextMode.value = false;
    query.value = '';
    results.value = [];
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : 'could not submit';
  }
}

function bump(id: number, delta: number): void {
  const next = (alloc.value[id] ?? 0) + delta;
  if (next < 0 || next > cap.value) return;
  if (delta > 0 && spent.value + delta > budget.value) return;
  if (next === 0) delete alloc.value[id];
  else alloc.value[id] = next;
  ballotSaved.value = false;
}

function tapRank(id: number): void {
  if (ranks.value[id]) {
    const removed = ranks.value[id]!;
    delete ranks.value[id];
    // close the gap
    for (const [k, v] of Object.entries(ranks.value)) if (v > removed) ranks.value[Number(k)] = v - 1;
  } else {
    const used = Object.keys(ranks.value).length;
    if (used >= numRanks.value) return;
    ranks.value[id] = used + 1;
  }
  ballotSaved.value = false;
}

async function saveBallot(): Promise<void> {
  error.value = '';
  try {
    const body =
      cfg.value?.method === 'pool'
        ? { allocations: Object.entries(alloc.value).map(([id, points]) => ({ submissionId: Number(id), points, note: notes.value[Number(id)] || undefined })) }
        : { ranks: Object.entries(ranks.value).map(([id, rank]) => ({ submissionId: Number(id), rank, note: notes.value[Number(id)] || undefined })) };
    await api.put(`/api/rounds/${roundId.value}/ballot`, body);
    ballotSaved.value = true;
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : 'could not save ballot';
  }
}

async function advance(): Promise<void> {
  await api.post(`/api/rounds/${roundId.value}/advance`);
  await load();
}

const isChooser = computed(() => round.value?.chooserId === session.me?.id);
const chooserPrompt = ref('');

async function setPrompt(): Promise<void> {
  await api.patch(`/api/rounds/${roundId.value}`, { promptTitle: chooserPrompt.value });
  await load();
}

onMounted(load);
</script>

<template>
  <div v-if="round">
    <RouterLink :to="`/leagues/${round.leagueId}`" class="text-sm text-neutral-500">← League</RouterLink>
    <div class="mt-1 flex items-start justify-between gap-2">
      <div>
        <div class="text-xs text-neutral-500">Round {{ round.number }}</div>
        <h1 class="text-xl font-bold">{{ round.promptTitle ?? 'Prompt TBD' }}</h1>
        <p v-if="round.promptDescription" class="mt-1 text-sm text-neutral-500">{{ round.promptDescription }}</p>
      </div>
      <span class="mt-1 shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold" :class="PHASE_BADGE[round.phase]">{{ PHASE_LABEL[round.phase] }}</span>
    </div>

    <button v-if="myRole === 'admin' && round.phase !== 'finished' && round.phase !== 'voided'" class="mt-2 rounded-lg border border-neutral-300 px-3 py-1 text-xs text-neutral-500 dark:border-neutral-700" @click="advance">
      ⏭ Advance phase now (admin)
    </button>
    <p v-if="error" class="mt-2 text-sm text-red-600">{{ error }}</p>

    <!-- SCHEDULED -->
    <div v-if="round.phase === 'scheduled'" class="mt-6 rounded-xl border border-dashed border-neutral-300 p-6 text-center text-sm dark:border-neutral-700">
      <template v-if="isChooser && !round.promptTitle">
        <p class="font-semibold">🏆 You won — pick the next prompt!</p>
        <div class="mx-auto mt-3 flex max-w-sm gap-2">
          <input v-model="chooserPrompt" placeholder="e.g. best 80s sci-fi" class="w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 dark:border-neutral-700" />
          <button class="shrink-0 rounded-lg bg-amber-500 px-3 py-2 font-semibold text-white" @click="setPrompt">Set</button>
        </div>
      </template>
      <template v-else>
        <p class="text-neutral-500">Submissions open {{ formatDate(round.submitOpenAt) }}</p>
      </template>
    </div>

    <!-- SUBMITTING: search → confirm card → submitted (SPEC §16) -->
    <div v-else-if="round.phase === 'submitting'" class="mt-4">
      <p class="text-sm text-neutral-500">Submissions close {{ timeUntil(round.submitCloseAt) }} ({{ formatDate(round.submitCloseAt) }})</p>

      <div v-if="mine && !confirmItem" class="mt-4 rounded-xl border border-emerald-300 p-4 dark:border-emerald-800">
        <p class="text-xs font-semibold uppercase text-emerald-600">✓ Your pick</p>
        <div class="mt-2 flex items-center gap-3">
          <img v-if="mine.imageUrl" :src="mine.imageUrl" class="h-20 rounded" />
          <div>
            <p class="font-semibold">{{ mine.title }} <span v-if="mine.year" class="text-neutral-500">({{ mine.year }})</span></p>
            <p v-if="mine.isFreeText" class="text-xs text-neutral-500">free-text entry</p>
          </div>
        </div>
        <button class="mt-3 text-sm text-amber-600 underline dark:text-amber-400" @click="mine = null">Change my pick</button>
      </div>

      <div v-else-if="confirmItem" class="mt-4 rounded-xl border border-neutral-200 p-4 text-center dark:border-neutral-800">
        <img v-if="confirmItem.imageUrl" :src="confirmItem.imageUrl" class="mx-auto h-48 rounded-lg shadow" />
        <p class="mt-3 text-lg font-bold">{{ confirmItem.title }} <span v-if="confirmItem.year" class="font-normal text-neutral-500">({{ confirmItem.year }})</span></p>
        <p v-if="confirmItem.subtitle" class="text-sm text-neutral-500">{{ confirmItem.subtitle }}</p>
        <div class="mt-4 flex justify-center gap-2">
          <button class="rounded-lg border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700" @click="confirmItem = null">Back</button>
          <button class="rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white" @click="submitPick">Submit this</button>
        </div>
      </div>

      <div v-else class="mt-4">
        <input v-model="query" placeholder="🔍 Search for a film…" class="w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 dark:border-neutral-700" @input="search" />
        <div class="mt-2 space-y-1">
          <button v-for="item in results" :key="item.id + item.title" class="flex w-full items-center gap-3 rounded-lg p-2 text-left hover:bg-neutral-100 dark:hover:bg-neutral-900" @click="confirmItem = item">
            <img v-if="item.imageUrl" :src="item.imageUrl" class="h-14 w-10 rounded object-cover" />
            <div v-else class="flex h-14 w-10 items-center justify-center rounded bg-neutral-200 dark:bg-neutral-800">🎬</div>
            <span class="text-sm font-medium">{{ item.title }} <span class="text-neutral-500">({{ item.year ?? '?' }})</span></span>
          </button>
        </div>
        <div v-if="freeTextMode" class="mt-3 flex gap-2">
          <input v-model="freeText" placeholder="Type the title exactly" class="w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm dark:border-neutral-700" />
          <button class="shrink-0 rounded-lg bg-amber-500 px-3 py-2 text-sm font-semibold text-white" @click="submitPick">Submit</button>
        </div>
        <button v-else class="mt-3 text-xs text-neutral-500 underline" @click="freeTextMode = true">
          {{ searchDown ? 'Search is unavailable — enter it as text' : "Can't find it?" }}
        </button>
      </div>
    </div>

    <!-- VOTING: steppers / tap-to-rank (SPEC §16) -->
    <div v-else-if="round.phase === 'voting'" class="mt-4">
      <p class="text-sm text-neutral-500">Voting closes {{ timeUntil(round.voteCloseAt) }} ({{ formatDate(round.voteCloseAt) }})</p>
      <div v-if="notEligible" class="mt-4 rounded-xl border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">{{ notEligible }}</div>
      <template v-else>
        <div class="mt-3 space-y-2">
          <div v-for="item in ballotItems" :key="item.id" class="rounded-xl border border-neutral-200 p-3 dark:border-neutral-800">
            <div class="flex items-center gap-3">
              <img v-if="item.imageUrl" :src="item.imageUrl" class="h-16 w-11 rounded object-cover" />
              <div v-else class="flex h-16 w-11 items-center justify-center rounded bg-neutral-200 dark:bg-neutral-800">🎬</div>
              <div class="flex-1">
                <p class="text-sm font-semibold">{{ item.title }} <span v-if="item.year" class="font-normal text-neutral-500">({{ item.year }})</span></p>
                <input v-model="notes[item.id]" placeholder="add a note (revealed with results)…" class="mt-1 w-full rounded border-0 bg-neutral-100 px-2 py-1 text-xs dark:bg-neutral-900" @input="ballotSaved = false" />
              </div>
              <!-- pool: − / + steppers -->
              <div v-if="cfg?.method === 'pool'" class="flex items-center gap-2">
                <button class="h-8 w-8 rounded-full border border-neutral-300 font-bold dark:border-neutral-700" @click="bump(item.id, -1)">−</button>
                <span class="w-6 text-center font-bold">{{ alloc[item.id] ?? 0 }}</span>
                <button class="h-8 w-8 rounded-full border border-neutral-300 font-bold dark:border-neutral-700" @click="bump(item.id, 1)">+</button>
              </div>
              <!-- ranked: tap-to-rank badges -->
              <button v-else class="flex h-9 w-9 items-center justify-center rounded-full border-2 font-bold" :class="ranks[item.id] ? 'border-amber-500 bg-amber-500 text-white' : 'border-neutral-300 text-neutral-400 dark:border-neutral-700'" @click="tapRank(item.id)">
                {{ ranks[item.id] ? ['①','②','③','④','⑤'][ranks[item.id]! - 1] ?? ranks[item.id] : '·' }}
              </button>
            </div>
          </div>
        </div>

        <!-- sticky budget bar -->
        <div class="sticky bottom-16 mt-3 rounded-xl border border-neutral-200 bg-white/95 p-3 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/95">
          <template v-if="cfg?.method === 'pool'">
            <div class="mb-1 flex justify-between text-xs text-neutral-500">
              <span>{{ spent }}/{{ budget }} points spent</span><span v-if="cap < budget">max {{ cap }}/film</span>
            </div>
            <div class="h-2 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
              <div class="h-full rounded-full bg-amber-500 transition-all" :style="{ width: `${(spent / budget) * 100}%` }" />
            </div>
          </template>
          <p v-else class="text-xs text-neutral-500">Tap films in order of preference ({{ Object.keys(ranks).length }}/{{ numRanks }} ranked)</p>
          <button class="mt-2 w-full rounded-lg py-2 font-semibold text-white" :class="ballotSaved ? 'bg-emerald-500' : 'bg-amber-500'" @click="saveBallot">
            {{ ballotSaved ? '✓ Ballot saved (editable until close)' : 'Save ballot' }}
          </button>
        </div>
      </template>
    </div>

    <!-- FINISHED: summary-first + drill-in (SPEC §16) -->
    <div v-else-if="round.phase === 'finished'" class="mt-4 space-y-2">
      <div v-for="item in resultItems" :key="item.id" class="overflow-hidden rounded-xl border" :class="item.placement === 1 ? 'winner-glow border-amber-400' : 'border-neutral-200 dark:border-neutral-800'">
        <button class="flex w-full items-center gap-3 p-3 text-left" @click="expanded = expanded === item.id ? null : item.id">
          <span class="w-7 text-center text-lg font-bold" :class="item.placement === 1 ? 'text-amber-500' : 'text-neutral-400'">
            {{ item.placement === 1 ? '🏆' : item.placement }}
          </span>
          <img v-if="item.imageUrl" :src="item.imageUrl" class="h-16 w-11 rounded object-cover" />
          <div class="flex-1">
            <p class="text-sm font-semibold">{{ item.title }} <span v-if="item.year" class="font-normal text-neutral-500">({{ item.year }})</span></p>
            <p class="text-xs text-neutral-500">{{ item.submitters.map((s) => s?.displayName || s?.username).join(' & ') }}</p>
          </div>
          <span class="text-lg font-bold">{{ item.score }}</span>
        </button>
        <div v-if="expanded === item.id" class="border-t border-neutral-100 px-4 py-2 dark:border-neutral-900">
          <div v-for="(v, i) in item.votes" :key="i" class="flex items-start gap-2 py-1.5 text-sm">
            <UserAvatar v-if="v.voter" :username="v.voter.username" :display-name="v.voter.displayName" size="sm" />
            <div class="flex-1">
              <span class="font-medium">{{ v.voter?.displayName || v.voter?.username }}</span>
              <span class="text-neutral-500"> {{ v.rank ? `ranked it #${v.rank}` : `+${v.points}` }}</span>
              <p v-if="v.note" class="text-xs italic text-neutral-500">“{{ v.note }}”</p>
            </div>
            <span class="font-bold text-neutral-400">+{{ v.points }}</span>
          </div>
          <p v-if="item.votes.length === 0" class="py-1.5 text-xs text-neutral-500">No votes.</p>
        </div>
      </div>
    </div>

    <!-- VOIDED -->
    <div v-else-if="round.phase === 'voided'" class="mt-6 rounded-xl border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
      This round was voided — not enough submissions or ballots. No points or coins were awarded.
    </div>
  </div>
</template>

<style scoped>
/* Winner highlight placeholder — simple CSS only (SPEC §4/§16); operator will
   design the real animation later. */
.winner-glow { animation: winner-pulse 2s ease-in-out infinite; }
@keyframes winner-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.35); }
  50% { box-shadow: 0 0 14px 3px rgba(245, 158, 11, 0.35); }
}
</style>

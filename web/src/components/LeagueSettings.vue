<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, ApiError } from '../api';

const props = defineProps<{ leagueId: number }>();
const emit = defineEmits<{ saved: [] }>();

interface League {
  name: string; visibility: 'public' | 'private'; allowDuplicates: boolean;
  requireSubmissionToVote: boolean; promptMode: 'admin' | 'winner-picks-next';
  scheduleTemplate: { startWeekday: number; startTime: string; submissionDays: number; votingDays: number } | null;
  defaultVotingConfig: { method: 'pool' | 'ranked'; allowSelfVote: boolean; totalPoints?: number; perItemCap?: number | null; mustSpendAll?: boolean; numRanks?: number; mustFillAllRanks?: boolean };
}
interface Webhook { id: number; url: string; format: string; events: string[] }

const league = ref<League | null>(null);
const webhooks = ref<Webhook[]>([]);
const useTemplate = ref(false);
const newHook = ref({ url: '', format: 'discord' as 'discord' | 'slack' | 'generic' });
const message = ref('');
const error = ref('');

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

async function load(): Promise<void> {
  const res = await api.get<{ league: League }>(`/api/leagues/${props.leagueId}`);
  league.value = res.league;
  useTemplate.value = !!res.league.scheduleTemplate;
  if (!res.league.scheduleTemplate) {
    league.value.scheduleTemplate = { startWeekday: 5, startTime: '18:00', submissionDays: 3, votingDays: 3 };
  }
  const wh = await api.get<{ webhooks: Webhook[] }>(`/api/leagues/${props.leagueId}/webhooks`);
  webhooks.value = wh.webhooks;
}

async function save(): Promise<void> {
  if (!league.value) return;
  message.value = '';
  error.value = '';
  try {
    const cfg = league.value.defaultVotingConfig;
    await api.patch(`/api/leagues/${props.leagueId}`, {
      visibility: league.value.visibility,
      allowDuplicates: league.value.allowDuplicates,
      requireSubmissionToVote: league.value.requireSubmissionToVote,
      promptMode: league.value.promptMode,
      scheduleTemplate: useTemplate.value ? league.value.scheduleTemplate : null,
      defaultVotingConfig:
        cfg.method === 'pool'
          ? { method: 'pool', allowSelfVote: cfg.allowSelfVote, totalPoints: cfg.totalPoints ?? 10, perItemCap: cfg.perItemCap ?? null, mustSpendAll: cfg.mustSpendAll !== false }
          : { method: 'ranked', allowSelfVote: cfg.allowSelfVote, numRanks: cfg.numRanks ?? 3, mustFillAllRanks: cfg.mustFillAllRanks === true },
    });
    message.value = 'Settings saved';
    emit('saved');
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : 'save failed';
  }
}

async function addWebhook(): Promise<void> {
  error.value = '';
  try {
    await api.post(`/api/leagues/${props.leagueId}/webhooks`, newHook.value);
    newHook.value.url = '';
    await load();
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : 'webhook failed';
  }
}

async function removeWebhook(id: number): Promise<void> {
  await api.delete(`/api/leagues/${props.leagueId}/webhooks/${id}`);
  await load();
}

onMounted(load);
</script>

<template>
  <div v-if="league" class="space-y-4 text-sm">
    <p v-if="message" class="text-emerald-600">✓ {{ message }}</p>
    <p v-if="error" class="text-red-600">{{ error }}</p>

    <div class="space-y-2 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
      <p class="font-semibold">League rules</p>
      <label class="flex items-center justify-between">Visibility
        <select v-model="league.visibility" class="rounded border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700">
          <option value="public">public</option><option value="private">private</option>
        </select>
      </label>
      <label class="flex items-center justify-between">Prompt mode
        <select v-model="league.promptMode" class="rounded border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700">
          <option value="admin">admin writes prompts</option>
          <option value="winner-picks-next">winner picks next</option>
        </select>
      </label>
      <label class="flex items-center justify-between">Allow duplicate picks
        <input v-model="league.allowDuplicates" type="checkbox" />
      </label>
      <label class="flex items-center justify-between">Must submit to vote
        <input v-model="league.requireSubmissionToVote" type="checkbox" />
      </label>
    </div>

    <div class="space-y-2 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
      <p class="font-semibold">Default voting</p>
      <label class="flex items-center justify-between">Method
        <select v-model="league.defaultVotingConfig.method" class="rounded border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700">
          <option value="pool">point pool</option><option value="ranked">ranked</option>
        </select>
      </label>
      <template v-if="league.defaultVotingConfig.method === 'pool'">
        <label class="flex items-center justify-between">Points per voter
          <input v-model.number="league.defaultVotingConfig.totalPoints" type="number" min="1" class="w-20 rounded border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700" />
        </label>
        <label class="flex items-center justify-between">Per-film cap (1 = "likes")
          <input v-model.number="league.defaultVotingConfig.perItemCap" type="number" min="1" placeholder="none" class="w-20 rounded border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700" />
        </label>
        <label class="flex items-center justify-between">Must spend all points
          <input v-model="league.defaultVotingConfig.mustSpendAll" type="checkbox" :checked="league.defaultVotingConfig.mustSpendAll !== false" />
        </label>
      </template>
      <template v-else>
        <label class="flex items-center justify-between">Ranks (top K)
          <input v-model.number="league.defaultVotingConfig.numRanks" type="number" min="1" max="10" class="w-20 rounded border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700" />
        </label>
        <label class="flex items-center justify-between">Must fill all ranks
          <input v-model="league.defaultVotingConfig.mustFillAllRanks" type="checkbox" />
        </label>
      </template>
      <label class="flex items-center justify-between">Allow voting for your own pick
        <input v-model="league.defaultVotingConfig.allowSelfVote" type="checkbox" />
      </label>
      <p class="text-xs text-neutral-500">Applies to new rounds; each round can override.</p>
    </div>

    <div class="space-y-2 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
      <label class="flex items-center justify-between font-semibold">Schedule template
        <input v-model="useTemplate" type="checkbox" />
      </label>
      <template v-if="useTemplate && league.scheduleTemplate">
        <label class="flex items-center justify-between">Rounds start
          <span class="flex gap-1">
            <select v-model.number="league.scheduleTemplate.startWeekday" class="rounded border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700">
              <option v-for="(d, i) in WEEKDAYS" :key="d" :value="i + 1">{{ d }}</option>
            </select>
            <input v-model="league.scheduleTemplate.startTime" type="time" class="rounded border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700" />
          </span>
        </label>
        <label class="flex items-center justify-between">Submission days
          <input v-model.number="league.scheduleTemplate.submissionDays" type="number" min="1" class="w-20 rounded border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700" />
        </label>
        <label class="flex items-center justify-between">Voting days
          <input v-model.number="league.scheduleTemplate.votingDays" type="number" min="1" class="w-20 rounded border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700" />
        </label>
        <p class="text-xs text-neutral-500">New rounds auto-fill their windows from this template (weekly cadence).</p>
      </template>
    </div>

    <button class="w-full rounded-lg bg-amber-500 py-2 font-semibold text-white" @click="save">Save settings</button>

    <div class="space-y-2 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
      <p class="font-semibold">Webhooks (Slack / Discord / custom)</p>
      <div v-for="h in webhooks" :key="h.id" class="flex items-center gap-2">
        <span class="flex-1 truncate text-xs text-neutral-500">{{ h.format }} · {{ h.url }}</span>
        <button class="text-xs text-red-500 underline" @click="removeWebhook(h.id)">remove</button>
      </div>
      <div class="flex gap-2">
        <input v-model="newHook.url" placeholder="https://discord.com/api/webhooks/…" class="w-full rounded border border-neutral-300 bg-transparent px-2 py-1 text-xs dark:border-neutral-700" />
        <select v-model="newHook.format" class="rounded border border-neutral-300 bg-transparent px-1 py-1 text-xs dark:border-neutral-700">
          <option value="discord">discord</option><option value="slack">slack</option><option value="generic">generic</option>
        </select>
        <button class="shrink-0 rounded bg-amber-500 px-2 py-1 text-xs font-semibold text-white" @click="addWebhook">Add</button>
      </div>
      <p class="text-xs text-neutral-500">Round events (open/close, results, winner) post to these URLs.</p>
    </div>
  </div>
</template>

export function timeUntil(ts: number): string {
  const diff = ts - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60_000);
  const hours = Math.round(abs / 3_600_000);
  const days = Math.round(abs / 86_400_000);
  const span = mins < 60 ? `${mins}m` : hours < 48 ? `${hours}h` : `${days}d`;
  return diff >= 0 ? `${span} left` : `${span} ago`;
}

export function formatDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export const PHASE_LABEL: Record<string, string> = {
  scheduled: 'Scheduled',
  submitting: 'Submissions open',
  voting: 'Voting open',
  finished: 'Finished',
  voided: 'Voided',
};

export const PHASE_BADGE: Record<string, string> = {
  scheduled: 'bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300',
  submitting: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200',
  voting: 'bg-sky-100 text-sky-800 dark:bg-sky-900 dark:text-sky-200',
  finished: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
  voided: 'bg-neutral-100 text-neutral-400 line-through dark:bg-neutral-900',
};

import { InputError } from './records.ts';

export const SYNC_INTERVALS = [5, 10, 15, 30, 60] as const;
export const MIN_SYNC_INTERVAL = 5, MAX_SYNC_INTERVAL = 1440;
const validInterval = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= MIN_SYNC_INTERVAL && value <= MAX_SYNC_INTERVAL;
export function validateSyncInterval(value: unknown): number {
  if (!validInterval(value)) throw new InputError('Enter a whole number of minutes between 5 and 1440.');
  return value;
}
export async function mailSchedule(db: D1Database) {
  const result = await db.prepare("SELECT key, value FROM settings WHERE key IN ('mail_sync_interval_minutes', 'mail_sync_last_slot')").all<{ key: string; value: string }>();
  const values = Object.fromEntries(result.results.map(row => [row.key, Number(row.value)]));
  const interval = validInterval(values.mail_sync_interval_minutes) ? values.mail_sync_interval_minutes : 5;
  return { interval_minutes: interval, choices: SYNC_INTERVALS, minimum_minutes: MIN_SYNC_INTERVAL, maximum_minutes: MAX_SYNC_INTERVAL, next_due_at: Number.isFinite(values.mail_sync_last_slot) ? new Date(values.mail_sync_last_slot + interval * 60000).toISOString() : null };
}
/** Claim an aligned server tick, so late cron delivery cannot accidentally double the interval. */
export async function claimScheduledSync(db: D1Database, scheduledTime = Date.now()) {
  const { interval_minutes } = await mailSchedule(db);
  const slot = Math.floor(scheduledTime / 60000) * 60000;
  const result = await db.prepare("INSERT INTO settings (key, value) VALUES ('mail_sync_last_slot', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE CAST(settings.value AS INTEGER) <= ?")
    .bind(String(slot), slot - interval_minutes * 60000).run();
  return result.meta.changes === 1;
}

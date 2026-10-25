import { InputError } from './records.ts';

export const SYNC_INTERVALS = [5, 10, 15, 30, 60] as const;
export function validateSyncInterval(value: unknown): number {
  if (typeof value !== 'number' || !SYNC_INTERVALS.includes(value as typeof SYNC_INTERVALS[number])) throw new InputError('Choose a sync interval of 5, 10, 15, 30 or 60 minutes.');
  return value;
}
export async function mailSchedule(db: D1Database) {
  const result = await db.prepare("SELECT key, value FROM settings WHERE key IN ('mail_sync_interval_minutes', 'mail_sync_last_slot')").all<{ key: string; value: string }>();
  const values = Object.fromEntries(result.results.map(row => [row.key, Number(row.value)]));
  const interval = SYNC_INTERVALS.includes(values.mail_sync_interval_minutes as typeof SYNC_INTERVALS[number]) ? values.mail_sync_interval_minutes : 5;
  return { interval_minutes: interval, choices: SYNC_INTERVALS, next_due_at: Number.isFinite(values.mail_sync_last_slot) ? new Date(values.mail_sync_last_slot + interval * 60000).toISOString() : null };
}
/** Claim an aligned server tick, so late cron delivery cannot accidentally double the interval. */
export async function claimScheduledSync(db: D1Database, scheduledTime = Date.now()) {
  const { interval_minutes } = await mailSchedule(db);
  const slot = Math.floor(scheduledTime / 300000) * 300000;
  const result = await db.prepare("INSERT INTO settings (key, value) VALUES ('mail_sync_last_slot', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE CAST(settings.value AS INTEGER) <= ?")
    .bind(String(slot), slot - interval_minutes * 60000).run();
  return result.meta.changes === 1;
}

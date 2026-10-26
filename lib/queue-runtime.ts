import { mailConfig, mailHash, syncMail } from './mail-service';
import { cleanupMail } from './mail-retention';
import { mailSchedule, claimScheduledSync } from './mail-schedule';
import { eventConnectionActive } from './oauth-grant';

export const QUEUE_EVENT = 'shortlist.work_available';
export const isoNow = () => new Date().toISOString();
export type AgentSubscription = { id: string; principal_id: string; grant_id: string | null; user_id: string; event_name: string; callback_url: string; signing_secret: string; previous_secret: string | null; previous_secret_until: string | null; expires_at: string; revoked_at: string | null; last_fingerprint: string | null; last_notified_at: string | null };

/** Contains no subjects, senders, message bodies, student details or credentials. */
export async function queueStatus(db: D1Database) {
  const time = isoNow();
  const counts = await db.prepare(`SELECT
    sum(CASE WHEN status = 'pending' OR (status = 'processing' AND lease_until <= ?) THEN 1 ELSE 0 END) AS actionable,
    sum(CASE WHEN status = 'processing' AND lease_until > ? THEN 1 ELSE 0 END) AS processing,
    sum(CASE WHEN status = 'needs_review' THEN 1 ELSE 0 END) AS needs_review
    FROM mail_jobs`).bind(time, time).first<{ actionable: number; processing: number; needs_review: number }>();
  const state = await db.prepare("SELECT value FROM settings WHERE key = 'mail_automation_last_run'").first<{ value: string }>();
  const sync = state ? JSON.parse(state.value) : null;
  return { is_queue_empty: !counts?.actionable, actionable_count: counts?.actionable || 0, processing_count: counts?.processing || 0, review_count: counts?.needs_review || 0, sync, server_sync_interval_minutes: (await mailSchedule(db)).interval_minutes, checked_at: time };
}

export function openAICallback(value: unknown): URL {
  if (typeof value !== 'string' || value.length > 8000) throw new Error('invalid_callback');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443') || !['openai.com', 'chatgpt.com'].some(host => url.hostname === host || url.hostname.endsWith('.' + host))) throw new Error('invalid_callback');
  return url;
}
export function signingBytes(secret: unknown) {
  if (typeof secret !== 'string' || !secret.startsWith('whsec_')) throw new Error('invalid_secret');
  const bytes = Uint8Array.from(atob(secret.slice(6)), c => c.charCodeAt(0));
  if (bytes.length < 24 || bytes.length > 64) throw new Error('invalid_secret');
  return bytes;
}
async function signature(secret: string, id: string, timestamp: string, body: string) {
  const key = await crypto.subtle.importKey('raw', signingBytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  return 'v1,' + btoa(String.fromCharCode(...new Uint8Array(bytes)));
}
export async function signedWebhook(sub: Pick<AgentSubscription, 'id' | 'callback_url' | 'signing_secret'> & Partial<AgentSubscription>, payload: unknown, id: string) {
  const url = openAICallback(sub.callback_url), body = JSON.stringify(payload), time = String(Math.floor(Date.now() / 1000));
  if (new TextEncoder().encode(body).length > 262144) throw new Error('payload_too_large');
  let signatures = await signature(sub.signing_secret, id, time, body);
  if (sub.previous_secret && sub.previous_secret_until && sub.previous_secret_until > isoNow()) signatures += ' ' + await signature(sub.previous_secret, id, time, body);
  // Workers does not implement redirect:error. Manual + explicit rejection never forwards secrets.
  const response = await fetch(url.href, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/json', 'webhook-id': id, 'webhook-timestamp': time, 'webhook-signature': signatures, 'X-MCP-Subscription-Id': sub.id }, body });
  if (response.status >= 300 && response.status < 400) throw new Error('callback_redirect');
  return response;
}
export function sameChallenge(expected: string, actual: unknown) {
  if (typeof actual !== 'string' || expected.length !== actual.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) mismatch |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  return mismatch === 0;
}

async function subscriptionAllowed(env: Cloudflare.Env, sub: AgentSubscription) {
  if (sub.revoked_at || sub.expires_at <= isoNow()) return false;
  const key = await env.DB.prepare('SELECT id FROM access_keys WHERE id = ? AND revoked_at IS NULL AND expires_at > ?').bind(sub.principal_id, isoNow()).first();
  if (!key) return false;
  if (sub.grant_id && !await eventConnectionActive(env, { ...sub, grant_id: sub.grant_id })) return false;
  return true;
}

/** Durable outbox: receipt retries preserve IDs, bounded attempts, no empty-queue wakeups. */
export async function notifyQueue(env: Cloudflare.Env) {
  const db = env.DB, time = isoNow(), status = await queueStatus(db);
  const jobs = await db.prepare("SELECT id, updated_at FROM mail_jobs WHERE status = 'pending' OR (status = 'processing' AND lease_until <= ?) ORDER BY id").bind(time).all<{ id: string; updated_at: string }>();
  const error = status.sync?.error || null;
  const baseFingerprint = jobs.results.length ? 'jobs:' + await mailHash(JSON.stringify(jobs.results)) : error ? 'sync:' + error + ':' + (status.sync.last_success_at || '') : null;
  const subscriptions = await db.prepare('SELECT * FROM agent_subscriptions WHERE revoked_at IS NULL AND expires_at > ? LIMIT 10').bind(time).all<AgentSubscription>();
  if (!baseFingerprint) {
    // Work may have been completed while a notification was awaiting a retry.
    // Discard obsolete wakeups without touching OAuth or any mailbox/student data.
    await db.prepare("UPDATE agent_deliveries SET status = 'dead', lock_until = NULL, last_error = 'queue_empty' WHERE status = 'pending' OR (status = 'delivering' AND lock_until <= ?)").bind(time).run();
    return { actionable_count: status.actionable_count, subscriptions: subscriptions.results.length };
  }
  for (const sub of subscriptions.results) {
    // A changed queue wakes immediately. An unchanged unclaimed queue gets one recovery wake every 30 min.
    const recovery = sub.last_fingerprint === baseFingerprint && sub.last_notified_at && Date.now() - Date.parse(sub.last_notified_at) >= 1800000;
    const fingerprint = baseFingerprint + (recovery ? ':recovery:' + Math.floor(Date.now() / 1800000) : '');
    const eventId = 'evt_' + crypto.randomUUID();
    const payload = { eventId, name: QUEUE_EVENT, timestamp: time, data: { reason: jobs.results.length ? 'jobs_ready' : 'sync_error', actionable_count: status.actionable_count, processing_count: status.processing_count, sync_error: error, queue_version: baseFingerprint }, cursor: null };
    await db.prepare("INSERT OR IGNORE INTO agent_deliveries (id, subscription_id, fingerprint, payload, status, next_attempt_at, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)").bind(eventId, sub.id, fingerprint, JSON.stringify(payload), time, time).run();
  }
  const due = await db.prepare("SELECT * FROM agent_deliveries WHERE (status = 'pending' AND next_attempt_at <= ?) OR (status = 'delivering' AND lock_until <= ?) ORDER BY created_at LIMIT 5").bind(time, time).all<{ id: string; subscription_id: string; fingerprint: string; payload: string; attempts: number }>();
  for (const item of due.results) {
    const locked = await db.prepare("UPDATE agent_deliveries SET status = 'delivering', lock_until = ?, attempts = attempts + 1 WHERE id = ? AND ((status = 'pending' AND next_attempt_at <= ?) OR (status = 'delivering' AND lock_until <= ?))").bind(new Date(Date.now() + 60000).toISOString(), item.id, time, time).run();
    if (!locked.meta.changes) continue;
    // Re-read the subscription at delivery time so a concurrent unsubscribe is
    // respected. Authorization is checked only for an actual delivery attempt.
    const sub = await db.prepare('SELECT * FROM agent_subscriptions WHERE id = ? AND revoked_at IS NULL AND expires_at > ?').bind(item.subscription_id, isoNow()).first<AgentSubscription>();
    let httpStatus: number | null = null, errorCode: string | null = null;
    try {
      if (!sub || !await subscriptionAllowed(env, sub)) {
        if (sub) await db.prepare('UPDATE agent_subscriptions SET revoked_at = ? WHERE id = ?').bind(isoNow(), sub.id).run();
        throw new Error('subscription_inactive');
      }
      const response = await signedWebhook(sub, JSON.parse(item.payload), item.id); httpStatus = response.status;
      if (response.ok) {
        await db.batch([
          db.prepare("UPDATE agent_deliveries SET status = 'delivered', delivered_at = ?, last_status = ?, last_error = NULL, lock_until = NULL WHERE id = ?").bind(isoNow(), httpStatus, item.id),
          db.prepare('UPDATE agent_subscriptions SET last_fingerprint = ?, last_notified_at = ? WHERE id = ?').bind(JSON.parse(item.payload).data.queue_version, isoNow(), sub.id),
        ]); continue;
      }
      errorCode = 'callback_http_' + response.status;
    } catch (error) { errorCode = error instanceof Error && ['subscription_inactive', 'subscription_check_unavailable', 'callback_redirect', 'payload_too_large'].includes(error.message) ? error.message : 'callback_unreachable'; }
    const permanent = httpStatus === 410 || httpStatus === 413 || httpStatus !== null && httpStatus >= 400 && httpStatus < 500 && ![408, 429].includes(httpStatus) || ['subscription_inactive', 'callback_redirect', 'payload_too_large'].includes(errorCode || '') || item.attempts + 1 >= 5;
    await db.prepare('UPDATE agent_deliveries SET status = ?, next_attempt_at = ?, lock_until = NULL, last_status = ?, last_error = ? WHERE id = ?').bind(permanent ? 'dead' : 'pending', new Date(Date.now() + Math.min(3600000, 600000 * 2 ** item.attempts)).toISOString(), httpStatus, errorCode, item.id).run();
    if (httpStatus === 410 && sub) await db.prepare('UPDATE agent_subscriptions SET revoked_at = ? WHERE id = ?').bind(isoNow(), sub.id).run();
  }
  return { actionable_count: status.actionable_count, subscriptions: subscriptions.results.length };
}

export async function scheduledMail(env: Cloudflare.Env, cron: string, options: { scheduledTime?: number; force?: boolean } = {}) {
  if (cron === '0 * * * *') { await cleanupMail(env.DB); return; }
  const config = await mailConfig(env.DB);
  if (!config.enabled || !options.force && !await claimScheduledSync(env.DB, options.scheduledTime)) { await notifyQueue(env); return; }
  const previous = await env.DB.prepare("SELECT value FROM settings WHERE key = 'mail_automation_last_run'").first<{ value: string }>();
  const last = previous ? JSON.parse(previous.value) : {};
  let state: Record<string, unknown> = { ...last, attempted_at: isoNow(), enabled: config.enabled, error: null };
  if (config.enabled) {
    try { const result = await syncMail(env.DB, env); state = { ...state, ...result, last_success_at: isoNow() }; }
    catch (error) { state.error = env.MAIL_USERNAME && env.MAIL_PASSWORD ? 'mail_sync_failed' : 'mail_not_configured'; console.error('Automatic mail sync failed:', state.error); }
  }
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('mail_automation_last_run', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify(state)).run();
  await notifyQueue(env);
}

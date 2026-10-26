import { InputError } from './records';
import { FREE_LIMITS, SAMPLE_RATE, USAGE_RETENTION_DAYS, quota, summarizeUsage, utcUsageDay, type UsageBucket } from './usage';

type CloudflareUsage = { day: string; fetched_at: string; worker_requests: number | null; site_requests: number | null; site_errors: number | null; d1_rows_read: number | null; d1_rows_written: number | null; kv_reads: number | null; kv_writes: number | null; kv_deletes: number | null; kv_lists: number | null; error: string | null };
const TOKEN_KEY = 'usage_cloudflare_token', CACHE_KEY = 'usage_cloudflare_cache';
const CF_GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql';
const CACHE_MS = 300_000;

async function encryptionKey(env: Cloudflare.Env) {
  if (!/^[a-f0-9]{64}$/.test(env.ADMIN_KEY_SHA256 || '')) throw new InputError('Owner configuration is unavailable.', 503);
  const material = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('shortlist.analytics.v1:' + env.ADMIN_KEY_SHA256));
  return crypto.subtle.importKey('raw', material, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function sealAnalyticsToken(env: Cloudflare.Env, token: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await encryptionKey(env), new TextEncoder().encode(token));
  return JSON.stringify({ iv: btoa(String.fromCharCode(...iv)), data: btoa(String.fromCharCode(...new Uint8Array(encrypted))) });
}
export async function openAnalyticsToken(env: Cloudflare.Env, value: string) {
  const { iv, data } = JSON.parse(value);
  const decode = (v: string) => Uint8Array.from(atob(v), c => c.charCodeAt(0));
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(iv) }, await encryptionKey(env), decode(data)));
}
async function graphql(token: string, query: string, variables: Record<string, string>) {
  const response = await fetch(CF_GRAPHQL, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(8000), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  if (!response.ok) throw new Error('analytics_unavailable');
  const result: any = await response.json();
  if (result.errors?.length || !result.data?.viewer?.accounts?.[0]) throw new Error('analytics_unavailable');
  return result.data.viewer.accounts[0];
}
function total(groups: any, key: string): number | null {
  if (!Array.isArray(groups)) return null;
  let value = 0;
  for (const group of groups) {
    const number = group?.sum?.[key];
    if (typeof number !== 'number' || !Number.isFinite(number) || number < 0) return null;
    value += number;
  }
  return value;
}

/** Provider analytics are delayed/adaptively sampled, not a billing guarantee.
 * Account-wide totals include other Workers/databases sharing the free allowance. */
export async function fetchCloudflareUsage(env: Cloudflare.Env, token: string, time = Date.now()): Promise<CloudflareUsage> {
  if (!/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID || '')) throw new InputError('Cloudflare account is not configured.', 503);
  const day = utcUsageDay(time), variables = { account: env.CLOUDFLARE_ACCOUNT_ID!, start: day.start, end: new Date(time).toISOString(), script: 'shortlist-desk' };
  const [workers, database, kv] = await Promise.allSettled([
    graphql(token, `query Usage($account: string!, $start: string!, $end: string!, $script: string!) {
      viewer { accounts(filter: {accountTag: $account}) {
        allWorkers: workersInvocationsAdaptive(limit: 1, filter: {datetime_geq: $start, datetime_leq: $end}) { sum { requests } }
        site: workersInvocationsAdaptive(limit: 1, filter: {scriptName: $script, datetime_geq: $start, datetime_leq: $end}) { sum { requests errors } }
      } } }`, variables),
    graphql(token, `query DatabaseUsage($account: string!, $start: Date!, $end: Date!) {
      viewer { accounts(filter: {accountTag: $account}) {
        database: d1AnalyticsAdaptiveGroups(limit: 1, filter: {date_geq: $start, date_leq: $end}) { sum { rowsRead rowsWritten } }
      } } }`, { account: variables.account, start: variables.start.slice(0, 10), end: variables.end.slice(0, 10) }),
    graphql(token, `query KvUsage($account: string!, $start: Date!, $end: Date!) {
      viewer { accounts(filter: {accountTag: $account}) {
        operations: kvOperationsAdaptiveGroups(limit: 100, filter: {date_geq: $start, date_leq: $end}) { dimensions { actionType } sum { requests } }
      } } }`, { account: variables.account, start: variables.start.slice(0, 10), end: variables.end.slice(0, 10) }),
  ]);
  const w = workers.status === 'fulfilled' ? workers.value : null, d = database.status === 'fulfilled' ? database.value : null, k = kv.status === 'fulfilled' ? kv.value : null;
  const kvCount = (action: string) => Array.isArray(k?.operations) ? total(k.operations.filter((row: any) => row.dimensions?.actionType === action), 'requests') : null;
  return { day: day.start, fetched_at: new Date(time).toISOString(), worker_requests: total(w?.allWorkers, 'requests'), site_requests: total(w?.site, 'requests'), site_errors: total(w?.site, 'errors'), d1_rows_read: total(d?.database, 'rowsRead'), d1_rows_written: total(d?.database, 'rowsWritten'), kv_reads: kvCount('read'), kv_writes: kvCount('write'), kv_deletes: kvCount('delete'), kv_lists: kvCount('list'), error: w && d && k ? null : 'Some Cloudflare analytics are unavailable. Check the token’s Account Analytics: Read permission and account access.' };
}

async function saveSetting(db: D1Database, key: string, value: string) {
  await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, value).run();
}
export async function connectUsage(env: Cloudflare.Env, value: unknown) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{32,300}$/.test(value.trim())) throw new InputError('Paste a valid read-only Cloudflare API token.');
  const token = value.trim(), usage = await fetchCloudflareUsage(env, token);
  if (usage.worker_requests === null && usage.d1_rows_read === null) throw new InputError('Cloudflare could not read analytics. Use Account → Account Analytics → Read, scoped to this account.', 400);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(TOKEN_KEY, await sealAnalyticsToken(env, token)),
    env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(CACHE_KEY, JSON.stringify(usage)),
  ]);
  return { connected: true, error: usage.error };
}
export async function disconnectUsage(db: D1Database) {
  await db.prepare('DELETE FROM settings WHERE key IN (?, ?)').bind(TOKEN_KEY, CACHE_KEY).run();
  return { connected: false };
}
async function cloudflareUsage(env: Cloudflare.Env, time: number) {
  const settings = await env.DB.prepare('SELECT key, value FROM settings WHERE key IN (?, ?)').bind(TOKEN_KEY, CACHE_KEY).all<{ key: string; value: string }>();
  const token = settings.results.find(row => row.key === TOKEN_KEY)?.value;
  if (!token) return { connected: false, data: null, stale: false };
  const raw = settings.results.find(row => row.key === CACHE_KEY)?.value;
  let cached: CloudflareUsage | null = null;
  try { cached = raw ? JSON.parse(raw) : null; } catch { /* Refresh an invalid cache. */ }
  const sameDay = cached?.day === utcUsageDay(time).start;
  if (cached && 'kv_lists' in cached && sameDay && time - Date.parse(cached.fetched_at) < CACHE_MS) return { connected: true, data: cached, stale: false };
  try {
    const data = await fetchCloudflareUsage(env, await openAnalyticsToken(env, token), time);
    await saveSetting(env.DB, CACHE_KEY, JSON.stringify(data));
    return { connected: true, data, stale: false };
  } catch {
    // Never apply yesterday’s usage to today’s headroom. Never return API response
    // bodies or error details that might contain a token or account information.
    return { connected: true, data: sameDay ? cached : null, stale: true };
  }
}

export async function usageSummary(env: Cloudflare.Env, time = Date.now()) {
  const [buckets, start, provider, size] = await Promise.all([
    env.DB.prepare('SELECT * FROM usage_hourly WHERE hour >= ? ORDER BY hour').bind(new Date(time - 24 * 3_600_000).toISOString().slice(0, 13) + ':00:00.000Z').all<UsageBucket>(),
    env.DB.prepare("SELECT value FROM settings WHERE key = 'usage_started_at'").first<{ value: string }>(),
    cloudflareUsage(env, time),
    env.DB.prepare('SELECT 1 AS ok').all(),
  ]);
  const stats = summarizeUsage(buckets.results, time), day = utcUsageDay(time);
  const databaseBytes = typeof size.meta.size_after === 'number' ? size.meta.size_after : null;
  const measured = provider.stale ? null : provider.data;
  const estimate = stats.today.samples ? stats.today.requests : null;
  const requests = measured?.worker_requests ?? estimate;
  const trackingFullDay = !!start && start.value <= day.start;
  return {
    checked_at: new Date(time).toISOString(), started_at: start?.value || null, day, sample_rate: SAMPLE_RATE, retention_days: USAGE_RETENTION_DAYS, ...stats,
    cloudflare: provider,
    quotas: {
      requests: { ...quota(requests, FREE_LIMITS.worker_requests), source: measured?.worker_requests !== null && measured?.worker_requests !== undefined ? 'cloudflare' : 'estimate', complete: measured?.worker_requests != null || trackingFullDay },
      rows_read: { ...quota(measured?.d1_rows_read ?? null, FREE_LIMITS.d1_rows_read), source: 'cloudflare' },
      rows_written: { ...quota(measured?.d1_rows_written ?? null, FREE_LIMITS.d1_rows_written), source: 'cloudflare' },
      storage: { ...quota(databaseBytes, FREE_LIMITS.database_bytes), source: 'database' },
      kv_reads: { ...quota(measured?.kv_reads ?? null, FREE_LIMITS.kv_reads), source: 'cloudflare' },
      kv_writes: { ...quota(measured?.kv_writes ?? null, FREE_LIMITS.kv_writes), source: 'cloudflare' },
      kv_deletes: { ...quota(measured?.kv_deletes ?? null, FREE_LIMITS.kv_deletes), source: 'cloudflare' },
      kv_lists: { ...quota(measured?.kv_lists ?? null, FREE_LIMITS.kv_lists), source: 'cloudflare' },
    },
  };
}
export type UsageSummary = Awaited<ReturnType<typeof usageSummary>>;

export async function cleanupUsage(db: D1Database, time = Date.now()) {
  await db.prepare('DELETE FROM usage_hourly WHERE hour < ?').bind(new Date(time - USAGE_RETENTION_DAYS * 86_400_000).toISOString().slice(0, 13) + ':00:00.000Z').run();
}

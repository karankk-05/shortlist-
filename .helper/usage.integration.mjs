import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const bundled = await build({ stdin: { contents: "export * from './lib/usage.ts'; export * from './lib/usage-service.ts';", resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
const usage = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));
const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("synthetic");}}', d1Databases: ['DB'] });
const originalFetch = globalThis.fetch;
try {
  const db = await mf.getD1Database('DB');
  for (const name of readdirSync('migrations').filter(name => name.endsWith('.sql')).sort()) {
    let statement = '';
    for (const line of readFileSync('migrations/' + name, 'utf8').replaceAll('--> statement-breakpoint', '\n').split('\n')) {
      if (!line.trim() || line.trim().startsWith('--')) continue;
      statement += line + '\n';
      if (line.trim().endsWith(';') && (!/^CREATE TRIGGER/i.test(statement.trim()) || /END;\s*$/.test(statement))) { await db.prepare(statement).run(); statement = ''; }
    }
    assert.equal(statement.trim(), '');
  }
  const env = { DB: db, ADMIN_KEY_SHA256: 'a'.repeat(64), CLOUDFLARE_ACCOUNT_ID: 'b'.repeat(32) }, token = 'synthetic_analytics_' + 'c'.repeat(32);
  const sealed = await usage.sealAnalyticsToken(env, token);
  assert.equal(sealed.includes(token), false);
  assert.equal(await usage.openAnalyticsToken(env, sealed), token);
  await assert.rejects(usage.openAnalyticsToken({ ...env, ADMIN_KEY_SHA256: 'd'.repeat(64) }, sealed));
  let calls = 0, rejectProvider = false, rejectDatabase = false;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.cloudflare.com/client/v4/graphql');
    assert.equal(options.redirect, 'manual', 'Analytics credentials must never follow a redirect');
    assert.equal(options.headers.Authorization, 'Bearer ' + token);
    const body = JSON.parse(options.body);
    assert.equal(body.variables.account, env.CLOUDFLARE_ACCOUNT_ID);
    const database = body.query.includes('DatabaseUsage');
    if (rejectProvider || database && rejectDatabase) return Response.json({ errors: [{ message: 'Synthetic provider failure' }] });
    return Response.json({ data: { viewer: { accounts: [database ? { database: [{ sum: { rowsRead: 125000, rowsWritten: 4500 } }] } : { allWorkers: [{ sum: { requests: 85000 } }], site: [{ sum: { requests: 80000, errors: 12 } }] }] } } });
  };
  await usage.connectUsage(env, token);
  const stored = await db.prepare("SELECT value FROM settings WHERE key = 'usage_cloudflare_token'").first();
  assert.equal(stored.value.includes(token), false);
  const first = await usage.usageSummary(env);
  assert.equal(first.quotas.requests.source, 'cloudflare');
  assert.equal(first.quotas.requests.used, 85000, 'Headroom uses the whole account, not just this site');
  assert.equal(first.quotas.requests.remaining, 15000);
  assert.equal(first.quotas.requests.status, 'warning');
  assert.equal(first.quotas.rows_read.used, 125000);
  assert.equal(first.quotas.rows_written.used, 4500);
  assert.equal(JSON.stringify(first).includes(token), false);
  assert.equal(JSON.stringify(first).includes(sealed), false);
  const called = calls;
  await usage.usageSummary(env);
  assert.equal(calls, called, 'Repeated admin refreshes reuse the five-minute provider cache');

  const now = Date.now();
  await usage.recordUsage(db, new Request('https://synthetic.test/api/v1/shortlists/private-id?secret=do-not-store'), 200, 150, now);
  await usage.recordUsage(db, new Request('https://synthetic.test/api/v1/shortlists/private-id'), 503, 1200, now);
  await usage.recordUsage(db, new Request('https://synthetic.test/api/v1/session', { method: 'POST', headers: { Authorization: 'Bearer do-not-store', 'X-Forwarded-For': 'private-address' }, body: 'private-body' }), 401, 10, now);
  const buckets = await db.prepare('SELECT * FROM usage_hourly ORDER BY category').all();
  assert.equal(buckets.results.length, 2);
  const reads = buckets.results.find(row => row.category === 'shortlist_reads');
  assert.equal(reads.samples, 2); assert.equal(reads.requests, 20); assert.equal(reads.server_errors, 10); assert.equal(reads.slow, 10);
  assert.doesNotMatch(JSON.stringify(buckets), /private-id|do-not-store|private-address|private-body/);
  await usage.recordUsage(db, new Request('https://synthetic.test/old'), 200, 5, now - 32 * 86400000);
  await usage.cleanupUsage(db, now);
  assert.equal((await db.prepare('SELECT count(*) AS count FROM usage_hourly').first()).count, 2, 'Retention deletes only expired usage buckets');

  rejectProvider = true;
  const nextDay = Date.parse(usage.utcUsageDay(now).reset_at) + 1000;
  const unavailable = await usage.usageSummary(env, nextDay);
  assert.equal(unavailable.quotas.requests.source, 'estimate');
  assert.equal(unavailable.quotas.requests.used, null, 'Yesterday’s quota must not masquerade as today’s headroom');
  assert.equal(unavailable.quotas.rows_read.remaining, null);
  assert.equal(unavailable.quotas.rows_written.remaining, null);
  assert.equal(unavailable.cloudflare.data.worker_requests, null);
  assert.ok(unavailable.cloudflare.data.error);
  rejectProvider = false; rejectDatabase = true;
  const partial = await usage.fetchCloudflareUsage(env, token);
  assert.equal(partial.worker_requests, 85000);
  assert.equal(partial.d1_rows_read, null);
  assert.ok(partial.error);
  await usage.disconnectUsage(db);
  const disconnected = await usage.usageSummary(env);
  assert.equal(disconnected.cloudflare.connected, false);
  assert.equal(disconnected.quotas.requests.source, 'estimate');
  assert.equal(disconnected.quotas.requests.used, 30);
  assert.equal((await db.prepare("SELECT count(*) AS count FROM settings WHERE key LIKE 'usage_cloudflare_%'").first()).count, 0);
  console.log(JSON.stringify({ passed: true, synthetic_only: true, checks: ['token encryption', 'credential redaction', 'account-wide headroom', 'five-minute cache', 'unknown usage', 'day reset', 'partial provider failure', 'aggregate-only storage', 'weighted counts', '31-day usage retention', 'disconnect'] }));
} finally { globalThis.fetch = originalFetch; await mf.dispose(); }

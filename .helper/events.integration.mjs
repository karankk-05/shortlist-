import assert from 'node:assert/strict';
import { randomBytes, createHash, createHmac } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const origin = 'https://shortlist.test', ownerKey = 'own_' + randomBytes(32).toString('base64url');
const ownerHash = createHash('sha256').update(ownerKey).digest('hex');
const signingKey = randomBytes(32), secret = 'whsec_' + signingKey.toString('base64');
const received = [];
let fetches = 0, failDeliveries = false, checks = 0;
const bundled = await build({ entryPoints: ['worker/index.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:workers', 'cloudflare:sockets'], logLevel: 'silent' });
const mf = new Miniflare({ modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2026-05-15', compatibilityFlags: ['global_fetch_strictly_public'], d1Databases: ['DB'], kvNamespaces: ['OAUTH_KV'], bindings: { ADMIN_KEY_SHA256: ownerHash, PORTAL_ORIGIN: origin }, serviceBindings: { ASSETS: () => new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } }) }, outboundService: async request => {
  fetches++;
  const url = new URL(request.url);
  assert.equal(url.origin, 'https://connectors.api.openai.com', 'No arbitrary outbound request or redirected destination is allowed');
  const body = await request.text(), headers = request.headers;
  const expected = createHmac('sha256', signingKey).update(headers.get('webhook-id') + '.' + headers.get('webhook-timestamp') + '.' + body).digest('base64');
  assert.equal(headers.get('webhook-signature'), 'v1,' + expected);
  const payload = JSON.parse(body);
  if (url.pathname === '/redirect') return new Response(null, { status: 307, headers: { Location: 'https://untrusted.invalid/secret' } });
  if (url.pathname === '/reject') return Response.json({ error: 'rejected' }, { status: 401 });
  if (payload.type === 'verification') return Response.json({ challenge: payload.challenge });
  if (failDeliveries) return new Response('retry later', { status: 503 });
  assert.equal(headers.get('webhook-id'), payload.eventId);
  assert.equal(payload.name, 'shortlist.work_available');
  received.push(payload);
  return Response.json({ accepted: true });
} });
try {
  const db = await mf.getD1Database('DB');
  for (const name of readdirSync('migrations').filter(name => name.endsWith('.sql')).sort()) {
    let statement = '';
    for (const line of readFileSync('migrations/' + name, 'utf8').replaceAll('--> statement-breakpoint', '\n').split('\n')) {
      if (!line.trim() || line.trim().startsWith('--')) continue;
      statement += line + '\n';
      if (line.trim().endsWith(';') && (!/^CREATE TRIGGER/i.test(statement.trim()) || /END;\s*$/.test(statement))) { await db.prepare(statement).run(); statement = ''; }
    }
    assert.equal(statement.trim(), '', 'Every fixture migration is complete');
  }
  async function call(path, { method = 'GET', data, raw, token, cookie, expected = 200, form, owner = false, originHeader = origin } = {}) {
    const response = await mf.dispatchFetch(origin + path, { method, redirect: 'manual', headers: { ...(token || owner ? { Authorization: 'Bearer ' + (owner ? ownerKey : token) } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(data ? { 'Content-Type': 'application/json' } : raw ? { 'Content-Type': 'message/rfc822' } : form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...(method !== 'GET' ? { Origin: originHeader } : {}) }, body: data ? JSON.stringify(data) : raw || form });
    const text = await response.text(), value = response.headers.get('Content-Type')?.includes('application/json') ? JSON.parse(text) : text;
    assert.equal(response.status, expected, `${method} ${path}: ${typeof value === 'object' ? JSON.stringify(value) : text.slice(0, 200)}`); checks++;
    return { value, response };
  }
  const scheduleBundle = await build({ entryPoints: ['lib/mail-schedule.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', logLevel: 'silent' });
  const scheduler = await import('data:text/javascript;base64,' + Buffer.from(scheduleBundle.outputFiles[0].text).toString('base64'));
  await call('/api/v1/mail/interval', { method: 'PUT', data: { minutes: 15 }, expected: 401 });
  for (const minutes of [0, 1, 4, 1441, 7.5, '5']) await call('/api/v1/mail/interval', { method: 'PUT', owner: true, data: { minutes }, expected: 400 });
  await db.prepare("INSERT INTO mail_state (account_id, last_uid) VALUES ('schedule-fixture', 123)").run();
  await call('/api/v1/mail/interval', { method: 'PUT', owner: true, data: { minutes: 10 } });
  assert.equal((await call('/api/v1/mail/status', { owner: true })).value.schedule.interval_minutes, 10);
  assert.equal((await db.prepare("SELECT last_uid FROM mail_state WHERE account_id = 'schedule-fixture'").first()).last_uid, 123, 'Interval changes must preserve the scan cursor');
  const tick = Date.parse('2026-01-01T12:00:00Z');
  assert.equal(await scheduler.claimScheduledSync(db, tick), true);
  assert.equal(await scheduler.claimScheduledSync(db, tick + 299000), false, 'Delayed delivery of the same tick cannot start another collector');
  assert.equal(await scheduler.claimScheduledSync(db, tick + 300000), false, 'A ten-minute interval skips the five-minute tick');
  const claims = await Promise.all([scheduler.claimScheduledSync(db, tick + 600000), scheduler.claimScheduledSync(db, tick + 600000)]);
  assert.equal(claims.filter(Boolean).length, 1, 'Only one concurrent scheduler claims a due slot');
  await call('/api/v1/mail/interval', { method: 'PUT', owner: true, data: { minutes: 5 } });
  assert.equal(await scheduler.claimScheduledSync(db, tick + 901000), true);
  assert.equal(await scheduler.claimScheduledSync(db, tick + 1200001), true, 'Cron delivery jitter must not turn a five-minute interval into ten minutes');
  await call('/api/v1/mail/interval', { method: 'PUT', owner: true, data: { minutes: 7 } });
  assert.equal((await call('/api/v1/mail/status', { owner: true })).value.schedule.interval_minutes, 7);
  assert.equal(await scheduler.claimScheduledSync(db, tick + 1560000), false, 'A custom seven-minute interval must not run after six minutes');
  assert.equal(await scheduler.claimScheduledSync(db, tick + 1620001), true, 'Custom intervals run on minute-aligned due slots without five-minute rounding');
  await call('/api/v1/mail/interval', { method: 'PUT', owner: true, data: { minutes: 1440 } });
  assert.equal((await call('/api/v1/mail/status', { owner: true })).value.schedule.interval_minutes, 1440);
  await call('/api/v1/mail/interval', { method: 'PUT', owner: true, data: { minutes: 5 } });
  await db.prepare("DELETE FROM settings WHERE key = 'mail_sync_last_slot'").run();
  await db.prepare("DELETE FROM mail_state WHERE account_id = 'schedule-fixture'").run();
  await call('/mcp', { method: 'POST', data: { jsonrpc: '2.0', id: 1, method: 'server/discover' }, expected: 401 });
  const resource = (await call('/.well-known/oauth-protected-resource/mcp')).value;
  assert.equal(resource.resource, origin + '/mcp');
  const metadata = (await call('/.well-known/oauth-authorization-server')).value;
  assert.ok(metadata.code_challenge_methods_supported.includes('S256'));
  assert.ok(metadata.scopes_supported.includes('queue:events'));
  await call('/oauth/register', { method: 'POST', data: { client_name: 'Bad redirect', redirect_uris: ['https://attacker.invalid/callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }, expected: 400 });
  const client = (await call('/oauth/register', { method: 'POST', data: { client_name: 'Synthetic ChatGPT fixture', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }, expected: 201 })).value;
  const verifier = randomBytes(32).toString('base64url'), challenge = createHash('sha256').update(verifier).digest('base64url');
  const authParams = new URLSearchParams({ client_id: client.client_id, redirect_uri: client.redirect_uris[0], response_type: 'code', resource: origin + '/mcp', code_challenge: challenge, code_challenge_method: 'S256', state: 'synthetic-state', scope: 'shortlists:read shortlists:write queue:events offline_access' });
  const consent = await call('/oauth/authorize?' + authParams);
  assert.match(consent.value, /Connect Shortlist Desk to ChatGPT/);
  assert.equal(consent.response.headers.get('Referrer-Policy'), 'same-origin', 'The form must preserve a non-null Origin header on browser navigation POSTs');
  assert.match(consent.response.headers.get('Content-Security-Policy'), /(?:^|;)\s*form-action 'self' https:\/\/chatgpt\.com;/, 'Chrome must allow the validated ChatGPT callback after the form POST');
  if (process.env.CHROME_BIN) await (await import('./oauth-redirect.browser.mjs')).verifyConsentRedirectInChrome(consent.response.headers.get('Content-Security-Policy'));
  assert.match(consent.value, /Return address: <strong>chatgpt.com<\/strong>/);
  const handle = consent.value.match(/name="handle" value="([^"]+)"/)[1];
  const cookie = consent.response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  await call('/oauth/authorize', { method: 'POST', form: new URLSearchParams({ decision: 'allow', handle, owner_key: ownerKey }), expected: 400 });
  await call('/oauth/authorize', { method: 'POST', cookie, originHeader: 'null', form: new URLSearchParams({ decision: 'allow', handle, owner_key: ownerKey }), expected: 403 });
  await call('/oauth/authorize', { method: 'POST', cookie, originHeader: 'https://untrusted.invalid', form: new URLSearchParams({ decision: 'allow', handle, owner_key: ownerKey }), expected: 403 });
  const authorized = await call('/oauth/authorize', { method: 'POST', cookie, form: new URLSearchParams({ decision: 'allow', handle, owner_key: ownerKey }), expected: 303 });
  const repeatedConsent = await call('/oauth/authorize', { method: 'POST', cookie, form: new URLSearchParams({ decision: 'allow', handle, owner_key: ownerKey }), expected: 400 });
  assert.match(repeatedConsent.value, /expired or was already used/, 'A second click explains that the consent form has already been used');
  const redirect = new URL(authorized.response.headers.get('Location'));
  assert.equal(redirect.origin, 'https://chatgpt.com');
  assert.equal(redirect.searchParams.get('state'), 'synthetic-state');
  assert.equal(redirect.searchParams.get('iss'), origin);
  const tokenParams = new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, code: redirect.searchParams.get('code'), redirect_uri: client.redirect_uris[0], resource: origin + '/mcp', code_verifier: verifier });
  const token = (await call('/oauth/token', { method: 'POST', form: tokenParams })).value;
  assert.ok(token.refresh_token); assert.ok(token.access_token);
  async function mcp(method, params, expected = 200) { return (await call('/mcp', { method: 'POST', token: token.access_token, data: { jsonrpc: '2.0', id: ++checks, method, params }, expected })).value; }
  const discover = await mcp('server/discover'); assert.deepEqual(discover.result.supportedVersions, ['2026-07-28']);
  const tools = (await mcp('tools/list')).result.tools; assert.ok(tools.some(tool => tool.name === 'lookup_students')); assert.ok(tools.every(tool => tool.securitySchemes[0].type === 'oauth2'));
  const fixtureKey = (await call('/api/v1/keys', { method: 'POST', owner: true, data: { label: 'Synthetic interval scope fixture', expires_in_days: 1 }, expected: 201 })).value.key;
  await call('/api/v1/mail/interval', { method: 'PUT', token: fixtureKey, data: { minutes: 60 }, expected: 403 });
  assert.equal((await mcp('events/list')).result.events[0].name, 'shortlist.work_available');
  const tool = async (name, args = {}) => (await mcp('tools/call', { name, arguments: args })).result;
  const status = JSON.parse((await tool('queue_status')).content[0].text); assert.equal(status.is_queue_empty, true);
  const prompt = (await tool('workflow')).content[0].text; assert.match(prompt, /agents must NEVER call \/mail\/sync/); assert.match(prompt, /literal role Unknown/); assert.match(prompt, /Keep the event monitor active/);
  const rows = [
    { name: 'Synthetic Example A', roll: '230001', programme: 'BTech', branch: 'Test department', cpi: null, email: 'synthetic-a@example.invalid' },
    { name: 'Synthetic Example B', roll: '230002', programme: 'BS', branch: 'Test department', cpi: 8.5, email: 'synthetic-b@example.invalid' },
  ];
  const master = (await call('/api/v1/master', { method: 'PUT', owner: true, data: { name: 'Synthetic MCP master', rows }, expected: 201 })).value;
  const lookup = JSON.parse((await tool('lookup_students', { queries: ['230001', 'synthetic-b@example.invalid', 'Missing Synthetic Candidate'] })).content[0].text);
  assert.equal(lookup.master_id, master.id); assert.deepEqual(lookup.results[0].matches, [rows[0]]); assert.deepEqual(lookup.results[1].matches, [rows[1]]); assert.equal(lookup.results[2].matches.length, 0);
  for (const path of ['https://attacker.invalid/', '../keys', 'keys', 'mail/sync', 'mail/interval', 'master']) assert.equal((await tool('portal_write', { path, body: {} })).isError, true);
  const subParams = callback => ({ name: 'shortlist.work_available', arguments: { queue: 'mail-shortlists' }, delivery: { mode: 'webhook', url: callback, secret } });
  const beforeInvalid = fetches;
  assert.ok((await mcp('events/subscribe', subParams('https://openai.com.attacker.invalid/callback'))).error);
  assert.equal(fetches, beforeInvalid);
  assert.equal((await mcp('events/subscribe', subParams('https://connectors.api.openai.com/reject'))).error.code, -32015);
  assert.equal((await mcp('events/subscribe', subParams('https://connectors.api.openai.com/redirect'))).error.code, -32015);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM agent_subscriptions').first()).n, 0);
  const subscribed = await mcp('events/subscribe', subParams('https://connectors.api.openai.com/queue-callback'));
  assert.ok(subscribed.result.id.startsWith('sub_'));
  assert.equal((await mcp('events/subscribe', subParams('https://connectors.api.openai.com/queue-callback'))).result.id, subscribed.result.id);
  await call('/api/v1/automation/notify', { method: 'POST', owner: true, data: {} }); assert.equal(received.length, 0);
  const raw = ['From: synthetic@example.invalid', 'To: owner@example.invalid', 'Subject: Synthetic shortlist event fixture', 'Message-ID: <synthetic-events-fixture@example.invalid>', 'Date: Sun, 25 Oct 2026 10:00:00 +0000', 'Content-Type: text/plain; charset=utf-8', '', 'Synthetic candidate table for a local test only.', 'Synthetic Example A 230001', 'Synthetic Example B 230002'].join('\r\n');
  failDeliveries = true;
  const job = (await call('/api/v1/mail/import', { method: 'POST', owner: true, raw, expected: 201 })).value;
  await call('/api/v1/automation/notify', { method: 'POST', owner: true, data: {} });
  let retry;
  for (let n = 0; n < 30; n++) {
    retry = await db.prepare("SELECT id, status, attempts, last_status FROM agent_deliveries ORDER BY created_at DESC LIMIT 1").first();
    if (retry?.status === 'pending' && retry.attempts > 0) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(retry.status, 'pending'); assert.equal(retry.last_status, 503); assert.equal(received.length, 0);
  failDeliveries = false;
  await db.prepare('UPDATE agent_deliveries SET next_attempt_at = ? WHERE id = ?').bind('2000-01-01T00:00:00.000Z', retry.id).run();
  await call('/api/v1/automation/notify', { method: 'POST', owner: true, data: {} });
  for (let n = 0; n < 30 && received.length < 1; n++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(received.length, 1); assert.equal(received[0].data.actionable_count, 1);
  assert.equal(received[0].eventId, retry.id, 'Receipt retries preserve the event ID');
  assert.equal(JSON.stringify(received[0]).includes('Synthetic'), false, 'Event payload never includes source content or students');
  await call('/api/v1/automation/notify', { method: 'POST', owner: true, data: {} }); assert.equal(received.length, 1, 'Unchanged queue does not wake the agent again');
  const claimed = JSON.parse((await tool('portal_write', { path: `mail-jobs/${job.id}/claim`, body: {} })).content[0].text);
  assert.ok(claimed.lease_token);
  const processing = JSON.parse((await tool('queue_status')).content[0].text); assert.equal(processing.actionable_count, 0); assert.equal(processing.processing_count, 1);
  const source = JSON.parse((await tool('portal_read', { path: `mail-jobs/${job.id}` })).content[0].text);
  assert.match(source.source.text, /230001/);
  const draft = JSON.parse((await tool('portal_write', { path: 'shortlists', body: { company: 'Synthetic MCP fixture', role: 'Unknown', round: 'Interview', season: 'Synthetic only', master_id: master.id, rows: lookup.results.slice(0, 2).map(result => result.matches[0]), mail_job_id: job.id, mail_lease_token: claimed.lease_token, source_upload_ids: source.job.source_upload_ids, processing_notes: 'Verified explicit synthetic source rolls and exact current master records. No role in source: Unknown.' } })).content[0].text);
  assert.ok(draft.version_id); assert.equal(draft.candidate_count, 2);
  const publication = JSON.parse((await tool('portal_write', { path: `shortlists/${draft.shortlist_id}/publish`, body: { version_id: draft.version_id, expected_current_version_id: null, acknowledge_warnings: true, mail_lease_token: claimed.lease_token } })).content[0].text);
  assert.equal(publication.published, true);
  const published = (await call('/api/v1/shortlists/' + draft.shortlist_id)).value;
  assert.deepEqual(published.rows, rows); assert.equal(published.shortlist.role, 'Unknown'); assert.match(published.shortlist.added_at, /^2026-10-25T10:00:00/);
  await tool('portal_write', { path: `mail-jobs/${job.id}/complete`, body: { lease_token: claimed.lease_token, note: 'Published and publicly verified both synthetic source candidates with preserved CPI and order.' } });
  assert.equal((await db.prepare('SELECT status FROM mail_jobs WHERE id = ?').bind(job.id).first()).status, 'done');
  await mcp('events/unsubscribe', subParams('https://connectors.api.openai.com/queue-callback'));
  assert.ok((await db.prepare('SELECT revoked_at FROM agent_subscriptions WHERE id = ?').bind(subscribed.result.id).first()).revoked_at);
  const secondJob = (await call('/api/v1/mail/import', { method: 'POST', owner: true, raw: raw.replace('synthetic-events-fixture@', 'synthetic-second-fixture@'), expected: 201 })).value;
  const secondClaim = JSON.parse((await tool('portal_write', { path: `mail-jobs/${secondJob.id}/claim`, body: {} })).content[0].text);
  await tool('portal_write', { path: `mail-jobs/${secondJob.id}/ignore`, body: { lease_token: secondClaim.lease_token, note: 'Synthetic retry fixture.' } });
  await call(`/api/v1/mail-jobs/${secondJob.id}/retry`, { method: 'POST', owner: true, data: { comment: 'Synthetic requeue fixture' } });
  await call('/api/v1/automation/notify', { method: 'POST', owner: true, data: {} }); assert.equal(received.length, 1, 'Unsubscribed callback is never invoked');
  const connection = await db.prepare("SELECT id FROM access_keys WHERE label = 'ChatGPT event workflow'").first();
  await call('/api/v1/keys/' + connection.id, { method: 'DELETE', owner: true });
  await mcp('tools/list', {}, 401);
  await call('/oauth/token', { method: 'POST', form: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refresh_token, client_id: client.client_id, resource: origin + '/mcp' }), expected: 400 });
  await call('/oauth/token', { method: 'POST', form: tokenParams, expected: 400 });
  console.log(JSON.stringify({ passed: true, checks, synthetic_only: true, event_deliveries: received.length, verified: ['OAuth PKCE and single-use code', 'browser-bound single-use consent', 'ChatGPT-only redirect allowlist', 'private MCP authentication and scopes', 'restricted agent writes', 'signed callback verification', 'redirect refusal', 'idempotent subscriptions', 'empty queue silence', '503 delivery retry with stable event ID', 'one event per changed queue', 'live-claim exclusion', 'MCP master lookup, evidence, draft, publication and completion', 'public source order, missing CPI, Unknown role and receipt date', 'unsubscribe', 'owner revocation and refresh denial'] }, null, 2));
} finally { await mf.dispose(); }

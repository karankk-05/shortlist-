import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const origin = 'http://127.0.0.1:8788';
const ownerKey = 'own_' + randomBytes(32).toString('base64url');
const ownerHash = createHash('sha256').update(ownerKey).digest('hex');
const state = '.wrangler/integration';
rmSync(state, { recursive: true, force: true });
const cli = 'node_modules/wrangler/bin/wrangler.js';
const migrated = spawnSync(process.execPath, [cli, 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', state], { encoding: 'utf8' });
if (migrated.status !== 0) throw new Error(migrated.stdout + migrated.stderr);
const server = spawn(process.execPath, [cli, 'dev', '--local', '--ip', '127.0.0.1', '--port', '8788', '--persist-to', state, '--var', 'ADMIN_KEY_SHA256:' + ownerHash], { stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => { logs = (logs + chunk).slice(-12000); });
try {
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (server.exitCode !== null) throw new Error('Preview exited: ' + logs);
    try { const response = await fetch(origin + '/api/v1/health'); if (response.ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!ready) throw new Error('Preview failed to start: ' + logs);
let ownerCookie = '', uploaderKey = '', count = 0;
for (const path of ['/agent', '/agent.txt', '/api/v1/agent']) {
  const response = await fetch(origin + path);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/plain/);
  const guide = await response.text();
  assert.ok(guide.includes(origin + '/api/v1/master'));
  assert.ok(guide.includes('name, roll, programme, branch, cpi, email'));
  count++;
}
const robots = await fetch(origin + '/robots.txt');
assert.equal(robots.status, 200);
assert.match(robots.headers.get('content-type'), /^text\/plain/);
assert.match(await robots.text(), /Allow: \/agent/); count++;

async function call(path, { method = 'GET', owner = false, key = false, data, expected = 200, cookie, evil = false, form } = {}) {
  const response = await fetch(origin + '/api/v1/' + path, { method, headers: { ...(owner ? { Cookie: ownerCookie } : cookie ? { Cookie: cookie } : {}), ...(key ? { Authorization: `Bearer ${uploaderKey}` } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { Origin: evil ? 'https://evil.example.invalid' : origin } : {}) }, body: form || (data ? JSON.stringify(data) : undefined), redirect: 'manual' });
  const result = response.headers.get('Content-Type')?.includes('application/json') ? await response.json() : await response.text();
  assert.equal(response.status, expected, `${method} ${path}: ${typeof result === 'object' ? result.error : response.status}`); count++;
  return { result, response };
}
const signin = await call('session', { method: 'POST', data: { key: ownerKey } });
ownerCookie = signin.response.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ');
assert.match(ownerCookie, /^shortlist_session=/);
const spoofed = await fetch(origin + '/api/v1/me', { headers: { 'X-ChatGPT-User-Email': 'owner@example.invalid', 'X-ChatGPT-User-Id': 'owner', 'X-ChatGPT-User': '{"email":"owner@example.invalid"}' } });
assert.equal((await spoofed.json()).role, 'public', 'Untrusted identity headers must never authorize the owner'); count++;
await call('session', { method: 'POST', data: { key: 'own_' + 'a'.repeat(43) }, expected: 401 });
assert.equal((await call('me', { owner: true })).result.role, 'admin');
await call('master', { expected: 401 });
await call('uploads', { expected: 401 });
await call('keys', { expected: 401 });
await call('shortlists', { method: 'POST', data: {}, expected: 401 });
await call('keys', { owner: true, method: 'POST', evil: true, data: { label: 'bad' }, expected: 403 });
const rows = [{ name: 'Synthetic Test A', roll: '0230001', programme: 'BTech', branch: 'Test department', cpi: null, email: 'qa-a@example.invalid' }, { name: 'Synthetic Test B', roll: '230002', programme: 'BS', branch: 'Test department', cpi: 0, email: 'qa-b@example.invalid' }];
const master = (await call('master', { method: 'PUT', owner: true, data: { name: 'Synthetic QA master', rows }, expected: 201 })).result;
const key = (await call('keys', { method: 'POST', owner: true, data: { label: 'Temporary local QA key', expires_in_days: 1 }, expected: 201 })).result;
uploaderKey = key.key;
const readMaster = (await call('master', { key: true })).result;
assert.deepEqual(readMaster.rows, rows); assert.equal(readMaster.rows[0].roll, '0230001');
await call('keys', { key: true, expected: 403 });
await call('master', { method: 'PUT', key: true, data: { name: 'unauthorized', rows }, expected: 403 });
const form = new FormData(); form.set('file', new File(['name,roll\nSynthetic,230001'], 'synthetic-source.csv'));
const upload = (await call('uploads', { method: 'POST', key: true, form, expected: 201 })).result;
await call('uploads/' + upload.id, { expected: 401 });
assert.match((await call('uploads/' + upload.id, { key: true })).result, /Synthetic/);
const bigBytes = Uint8Array.from({ length: 2 * 1024 * 1024 + 37 }, (_, index) => index % 251);
const bigForm = new FormData(); bigForm.set('file', new File([bigBytes], 'synthetic-binary.xlsx'));
const large = (await call('uploads', { method: 'POST', key: true, form: bigForm, expected: 201 })).result;
const largeResponse = await fetch(origin + '/api/v1/uploads/' + large.id, { headers: { Authorization: 'Bearer ' + uploaderKey } });
assert.equal(largeResponse.status, 200);
assert.deepEqual(new Uint8Array(await largeResponse.arrayBuffer()), bigBytes); count++;
const input = { company: 'Synthetic QA Studio ' + Date.now(), role: 'Test role', round: 'Interview', season: 'QA only', master_id: master.id, rows, source_upload_ids: [upload.id], processing_notes: 'Private synthetic reconciliation note.' };
await call('shortlists', { method: 'POST', key: true, data: { ...input, rows: [rows[0], rows[0]] }, expected: 400 });
await call('shortlists', { method: 'POST', key: true, data: { ...input, rows: [{ ...rows[0], blood_group: 'not-allowed' }] }, expected: 400 });
const draft = (await call('shortlists', { method: 'POST', key: true, data: input, expected: 201 })).result;
await call('shortlists/' + draft.shortlist_id, { expected: 404 });
assert.equal((await call('shortlists')).result.shortlists.some(list => list.id === draft.shortlist_id), false);
await call(`shortlists/${draft.shortlist_id}/publish`, { method: 'POST', data: { version_id: draft.version_id, expected_current_version_id: null }, expected: 401 });
await call(`shortlists/${draft.shortlist_id}/publish`, { method: 'POST', key: true, data: { version_id: draft.version_id, expected_current_version_id: null } });
const published = (await call('shortlists/' + draft.shortlist_id)).result;
assert.deepEqual(published.rows, rows); assert.equal(JSON.stringify(published).includes('reconciliation'), false);
assert.deepEqual(published.columns, ['name', 'roll', 'programme', 'branch', 'cpi', 'email']);
const csv = (await call(`shortlists/${draft.shortlist_id}/export.csv`)).result; assert.match(csv, /0230001/);
await call(`shortlists/${draft.shortlist_id}/versions`, { expected: 401 });
const v2data = { master_id: master.id, rows: [rows[1]], expected_latest_version_id: draft.version_id, processing_notes: 'Second synthetic version' };
const v2 = (await call(`shortlists/${draft.shortlist_id}/versions`, { method: 'POST', key: true, data: v2data, expected: 201 })).result;
await call(`shortlists/${draft.shortlist_id}/versions`, { method: 'POST', key: true, data: v2data, expected: 409 });
await call(`shortlists/${draft.shortlist_id}/publish`, { method: 'POST', key: true, data: { version_id: v2.version_id, expected_current_version_id: null }, expected: 409 });
await call(`shortlists/${draft.shortlist_id}/publish`, { method: 'POST', key: true, data: { version_id: v2.version_id, expected_current_version_id: draft.version_id } });
await call(`shortlists/${draft.shortlist_id}/restore`, { method: 'POST', key: true, data: { version_id: draft.version_id, expected_current_version_id: v2.version_id }, expected: 403 });
await call(`shortlists/${draft.shortlist_id}/restore`, { method: 'POST', owner: true, data: { version_id: draft.version_id, expected_current_version_id: v2.version_id } });
assert.equal((await call('shortlists/' + draft.shortlist_id)).result.rows.length, 2);
await call('keys/' + key.id, { method: 'DELETE', owner: true });
await call('master', { key: true, expected: 401 });
console.log(JSON.stringify({ passed: true, http_checks: count, all_records_synthetic: true, checked: ['private master', 'anonymous write denial', 'uploader scopes', 'private source files', 'six columns', 'draft privacy', 'publication', 'CSV', 'version conflicts', 'restore', 'key revocation', 'CSRF'] }, null, 2));

} finally {
  server.kill('SIGTERM');
  await new Promise(resolve => { if (server.exitCode !== null) resolve(); else { server.once('exit', resolve); setTimeout(() => { server.kill('SIGKILL'); resolve(); }, 3000).unref(); } });
  rmSync(state, { recursive: true, force: true });
}

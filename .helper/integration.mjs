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
const server = spawn(process.execPath, [cli, 'dev', '--local', '--test-scheduled', '--ip', '127.0.0.1', '--port', '8788', '--persist-to', state, '--var', 'ADMIN_KEY_SHA256:' + ownerHash], { stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => { logs = (logs + chunk).slice(-12000); });
try {
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (server.exitCode !== null) throw new Error('Preview exited: ' + logs);
    try { const response = await fetch(origin + '/api/v1/health', { headers: { Connection: 'close' } }); if (response.ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!ready) throw new Error('Preview failed to start: ' + logs);
let ownerCookie = '', uploaderKey = '', count = 0;
async function call(path, { method = 'GET', owner = false, key = false, data, expected = 200, cookie, evil = false, form, raw } = {}) {
  // Synchronous SQL fixture commands can outlast the local server's keep-alive timeout.
  // Close test connections so Node 22 never reuses a stale socket after a fixture write.
  const response = await fetch(origin + '/api/v1/' + path, { method, headers: { Connection: 'close', ...(owner ? { Cookie: ownerCookie } : cookie ? { Cookie: cookie } : {}), ...(key ? { Authorization: `Bearer ${uploaderKey}` } : {}), ...(raw ? { 'Content-Type': 'message/rfc822' } : data ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { Origin: evil ? 'https://evil.example.invalid' : origin } : {}) }, body: raw || form || (data ? JSON.stringify(data) : undefined), redirect: 'manual' });
  const result = response.headers.get('Content-Type')?.includes('application/json') ? await response.json() : await response.text();
  assert.equal(response.status, expected, `${method} ${path}: ${typeof result === 'object' ? result.error : response.status}`); count++;
  return { result, response };
}
const signin = await call('session', { method: 'POST', data: { key: ownerKey } });
ownerCookie = signin.response.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ');
assert.match(ownerCookie, /^shortlist_session=/);
const spoofed = await fetch(origin + '/api/v1/me', { headers: { Connection: 'close', 'X-ChatGPT-User-Email': 'owner@example.invalid', 'X-ChatGPT-User-Id': 'owner', 'X-ChatGPT-User': '{"email":"owner@example.invalid"}' } });
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
const largeResponse = await fetch(origin + '/api/v1/uploads/' + large.id, { headers: { Connection: 'close', Authorization: 'Bearer ' + uploaderKey } });
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
const listPath = 'shortlists/' + draft.shortlist_id;
const current = (await call(listPath)).result.shortlist;
await call(listPath, { method: 'DELETE', data: { expected_updated_at: current.updated_at }, expected: 401 });
await call(listPath, { method: 'DELETE', key: true, data: { expected_updated_at: current.updated_at }, expected: 403 });
await call(listPath, { method: 'DELETE', owner: true, evil: true, data: { expected_updated_at: current.updated_at }, expected: 403 });
await call(listPath, { method: 'DELETE', owner: true, data: {}, expected: 400 });
await call(listPath, { method: 'DELETE', owner: true, data: { expected_updated_at: 'stale' }, expected: 409 });
const removed = (await call(listPath, { method: 'DELETE', owner: true, data: { expected_updated_at: current.updated_at } })).result;
assert.equal(removed.deleted, true);
await call(listPath, { expected: 404 });
await call(listPath + '/export.csv', { expected: 404 });
await call(listPath + '?version_id=' + draft.version_id, { owner: true, expected: 404 });
await call(listPath + '/versions', { key: true, expected: 404 });
await call(listPath + '/versions', { method: 'POST', key: true, data: { ...v2data, expected_latest_version_id: v2.version_id }, expected: 404 });
await call(listPath + '/publish', { method: 'POST', key: true, data: { version_id: draft.version_id, expected_current_version_id: draft.version_id }, expected: 404 });
assert.equal((await call('shortlists')).result.shortlists.some(list => list.id === draft.shortlist_id), false);
assert.equal((await call('shortlists?include_drafts=1', { key: true })).result.shortlists.some(list => list.id === draft.shortlist_id), false);
await call('shortlists/deleted', { expected: 401 });
await call('shortlists/deleted', { key: true, expected: 403 });
const trash = (await call('shortlists/deleted', { owner: true })).result.shortlists;
assert.equal(trash.find(list => list.id === draft.shortlist_id)?.version_count, 2);
await call('shortlists', { method: 'POST', key: true, data: input, expected: 409 });
await call(listPath + '/undelete', { method: 'POST', key: true, data: { expected_updated_at: removed.updated_at }, expected: 403 });
await call(listPath + '/undelete', { method: 'POST', owner: true, data: { expected_updated_at: current.updated_at }, expected: 409 });
await call(listPath + '/undelete', { method: 'POST', owner: true, data: { expected_updated_at: removed.updated_at } });
await call(listPath + '/undelete', { method: 'POST', owner: true, data: { expected_updated_at: removed.updated_at }, expected: 409 });
assert.deepEqual((await call(listPath)).result.rows, rows);
assert.equal((await call('shortlists/deleted', { owner: true })).result.shortlists.length, 0);
// Private drafts can also be deleted and restored without becoming public.
const privateDraft = (await call('shortlists', { method: 'POST', key: true, data: { ...input, company: input.company + ' private' }, expected: 201 })).result;
const privateList = (await call('shortlists?include_drafts=1', { owner: true })).result.shortlists.find(list => list.id === privateDraft.shortlist_id);
const privateRemoved = (await call('shortlists/' + privateList.id, { method: 'DELETE', owner: true, data: { expected_updated_at: privateList.updated_at } })).result;
await call('shortlists/' + privateList.id + '/undelete', { method: 'POST', owner: true, data: { expected_updated_at: privateRemoved.updated_at } });
await call('shortlists/' + privateList.id, { expected: 404 });
assert.equal((await call('shortlists?include_drafts=1', { owner: true })).result.shortlists.some(list => list.id === privateList.id), true);
await call('mail/status', { expected: 401 });
await call('mail-jobs', { expected: 401 });
assert.equal((await call('mail/status', { key: true })).result.configured, false);
await call('mail/sync', { method: 'POST', key: true, data: {}, expected: 503 });
const mailConfig = { enabled: true, folder: 'INBOX', lookback_days: 30, senders: [], link_domains: ['iitk.ac.in','docs.google.com'] };
await call('mail/config', { method: 'PUT', key: true, data: mailConfig, expected: 403 });
await call('mail/config', { method: 'PUT', owner: true, data: mailConfig });
for (const phrase of ['short', 'shortly', 'myshortlist', 'shortlistify']) {
  const unrelated = (await call('mail/import', { method: 'POST', owner: true, raw: `From: Academic <academic@example.invalid>\r\nSubject: Course announcement\r\n\r\nA ${phrase} course update. https://docs.google.com/course\r\n`, expected: 201 })).result;
  assert.equal(unrelated.filtered, true);
  assert.equal(unrelated.queued, undefined);
}
assert.equal((await call('mail-jobs?status=all', { owner: true })).result.jobs.length, 0, 'Filtered mail must not enter the queue');
const eml = 'From: Placement <placement@example.invalid>\r\nSubject: Synthetic shortlist notice\r\nMessage-ID: <mail-qa@example.invalid>\r\nDate: Sat, 24 Oct 2026 10:00:00 +0530\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="qa"\r\n\r\n--qa\r\nContent-Type: text/plain\r\n\r\nSynthetic shortlist. https://docs.google.com/spreadsheets/d/synthetic https://iitk.ac.in.evil.example/sheet\r\n--qa\r\nContent-Type: text/csv\r\nContent-Disposition: attachment; filename="synthetic-mail.csv"\r\n\r\nname,roll\r\nSynthetic Test A,0230001\r\n--qa--\r\n';
await call('mail/import', { method: 'POST', key: true, raw: eml, expected: 403 });
const mail = (await call('mail/import', { method: 'POST', owner: true, raw: eml, expected: 201 })).result;
assert.equal(mail.status, 'pending');
assert.equal((await call('mail/import', { method: 'POST', owner: true, raw: eml, expected: 201 })).result.duplicate, true);
const duplicateMail = (await call('mail/import', { method: 'POST', owner: true, raw: eml.replace('mail-qa@','mail-qa-second@'), expected: 201 })).result;
assert.equal(duplicateMail.status, 'pending', 'A content duplicate must remain available for agent event verification');
await call('mail-jobs/' + mail.id, { expected: 401 });
const mailDetail = (await call('mail-jobs/' + mail.id, { key: true })).result;
assert.match(mailDetail.source.text, /Synthetic shortlist/);
assert.equal(mailDetail.source.sent_at, '2026-10-24T04:30:00.000Z', 'Preserve the original Date header privately for event interpretation');
assert.equal(mailDetail.source.links[0].allowed, true); assert.equal(mailDetail.source.links[1].allowed, false);
assert.equal(mailDetail.source.attachments.length, 1);
assert.equal(JSON.stringify(mailDetail).includes('lease_hash'), false);
await call('uploads/' + mailDetail.source.attachments[0].id, { expected: 401 });
assert.match((await call('uploads/' + mailDetail.source.attachments[0].id, { key: true })).result, /Synthetic Test A/);
assert.equal((await call('mail-jobs', { key: true })).result.jobs.length, 2);
const claim = (await call(`mail-jobs/${mail.id}/claim`, { method: 'POST', key: true, data: {} })).result;
await call(`mail-jobs/${mail.id}/claim`, { method: 'POST', owner: true, data: {}, expected: 409 });
await call(`mail-jobs/${mail.id}/complete`, { method: 'POST', key: true, data: { lease_token: 'wrong' }, expected: 409 });
await call(`mail-jobs/${mail.id}/complete`, { method: 'POST', key: true, data: { lease_token: claim.lease_token }, expected: 400 });
const mailInput = { ...input, company: input.company + ' mail', source_upload_ids: mailDetail.job.source_upload_ids, mail_job_id: mail.id, mail_lease_token: claim.lease_token };
await call('shortlists', { method: 'POST', key: true, data: { ...mailInput, mail_lease_token: 'wrong' }, expected: 409 });
await call('shortlists', { method: 'POST', key: true, data: { ...mailInput, source_upload_ids: [] }, expected: 400 });
const mailDraft = (await call('shortlists', { method: 'POST', key: true, data: mailInput, expected: 201 })).result;
await call(`shortlists/${mailDraft.shortlist_id}/versions`, { method: 'POST', key: true, data: { ...mailInput, expected_latest_version_id: mailDraft.version_id }, expected: 409 });
await call(`shortlists/${mailDraft.shortlist_id}/publish`, { method: 'POST', key: true, data: { version_id: mailDraft.version_id, expected_current_version_id: null }, expected: 409 });
await call(`shortlists/${mailDraft.shortlist_id}/publish`, { method: 'POST', key: true, data: { version_id: mailDraft.version_id, expected_current_version_id: null, mail_lease_token: claim.lease_token } });
const publishedMail = (await call('shortlists/' + mailDraft.shortlist_id)).result;
assert.equal(publishedMail.shortlist.added_at, mailDetail.job.received_at, 'Date added must use the source date rather than publication time');
assert.notEqual(publishedMail.shortlist.added_at, publishedMail.shortlist.updated_at, 'Audit time must remain separate from the displayed source date');
// Simulate an interrupted agent after publication. A later run resumes the same result.
const expired = spawnSync(process.execPath, [cli, 'd1','execute','DB','--local','--persist-to',state,'--command',`UPDATE mail_jobs SET lease_until = '2000-01-01T00:00:00.000Z' WHERE id = '${mail.id}'`], { encoding: 'utf8' });
assert.equal(expired.status, 0, 'Synthetic lease expiry failed');
assert.equal((await call('mail-jobs', { key: true })).result.jobs.some(job => job.id === mail.id), true);
const reclaimed = (await call(`mail-jobs/${mail.id}/claim`, { method: 'POST', key: true, data: {} })).result;
const resumed = (await call('mail-jobs/' + mail.id, { key: true })).result;
assert.equal(resumed.versions.length,1); assert.equal(resumed.versions[0].published_version_id,mailDraft.version_id);
await call(`mail-jobs/${mail.id}/complete`, { method: 'POST', key: true, data: { lease_token: claim.lease_token }, expected: 409 });
await call(`mail-jobs/${mail.id}/complete`, { method: 'POST', key: true, data: { lease_token: reclaimed.lease_token, note: 'Verified synthetic public result.' } });
await call(`mail-jobs/${mail.id}/claim`, { method: 'POST', key: true, data: {}, expected: 409 });
assert.equal((await call('mail-jobs?status=done', { key: true })).result.jobs[0].result_version_ids[0],mailDraft.version_id);
const duplicateClaim = (await call(`mail-jobs/${duplicateMail.id}/claim`, { method: 'POST', key: true, data: {} })).result;
await call(`mail-jobs/${duplicateMail.id}/review`, { method: 'POST', key: true, data: { lease_token: duplicateClaim.lease_token, note: 'Event identity is ambiguous after inspecting this suspected duplicate.' } });
await call(`mail-jobs/${duplicateMail.id}/retry`, { method: 'POST', key: true, data: {}, expected: 403 });
await call(`mail-jobs/${duplicateMail.id}/retry`, { method: 'POST', owner: true, data: {} });
const reviewClaim = (await call(`mail-jobs/${duplicateMail.id}/claim`, { method: 'POST', key: true, data: {} })).result;
await call(`mail-jobs/${duplicateMail.id}/review`, { method: 'POST', key: true, data: { lease_token: reviewClaim.lease_token, note: 'Ambiguous source; owner review needed.' } });
assert.equal((await call('mail-jobs?status=needs_review', { owner: true })).result.jobs.length,1);
const noMessageId = eml.replace('Message-ID: <mail-qa@example.invalid>\r\n','');
const importedWithoutId = (await call('mail/import', { method: 'POST', owner: true, raw: noMessageId, expected: 201 })).result;
const anotherWithoutId = (await call('mail/import', { method: 'POST', owner: true, raw: noMessageId.replace('Synthetic shortlist.','Another synthetic shortlist.'), expected: 201 })).result;
assert.equal(importedWithoutId.queued,true); assert.equal(anotherWithoutId.queued,true);
assert.notEqual(importedWithoutId.id,anotherWithoutId.id,'Distinct messages without Message-ID must not collapse into one import');
for (const phrase of ['short list', 'short-listed']) {
  const result = (await call('mail/import', { method: 'POST', owner: true, raw: `From: Placement <placement@example.invalid>\r\nSubject: Company ${phrase}\r\n\r\nCandidates are attached.\r\n`, expected: 201 })).result;
  assert.equal(result.queued, true, phrase);
  assert.equal(result.status, 'pending');
}
const encoded = Buffer.from('The short list is attached.').toString('base64');
const decodedMatch = (await call('mail/import', { method: 'POST', owner: true, raw: `From: Placement <placement@example.invalid>\r\nSubject: Company update\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${encoded}\r\n`, expected: 201 })).result;
assert.equal(decodedMatch.queued, true, 'Check MIME-decoded body text');
const hiddenMatch = (await call('mail/import', { method: 'POST', owner: true, raw: 'From: Academic <academic@example.invalid>\r\nSubject: Course update\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Class begins shortly.</p><a href="https://docs.google.com/shortlist">Course portal</a><script>shortlist</script>\r\n', expected: 201 })).result;
assert.equal(hiddenMatch.filtered, true, 'Raw HTML URLs and scripts alone must not qualify an email');
// Separate emails for the same event reuse a verified result without another draft or publication.
const resend = (await call('mail/import', { method: 'POST', owner: true, raw: 'From: RAS <ras@example.invalid>\r\nSubject: Synthetic company shortlists\r\nDate: Fri, 23 Oct 2026 12:00:00 +0530\r\n\r\nShortlisted candidates: 0230001, 230002.\r\n', expected: 201 })).result;
const resendClaim = (await call(`mail-jobs/${resend.id}/claim`, { method: 'POST', key: true, data: {} })).result;
const reuse = { lease_token: resendClaim.lease_token, shortlist_id: mailDraft.shortlist_id, version_id: mailDraft.version_id, note: 'Verified same company, role, interview round, event date/time and candidate rolls in the RAS resend.' };
await call(`mail-jobs/${resend.id}/reuse`, { method: 'POST', data: reuse, expected: 401 });
await call(`mail-jobs/${resend.id}/reuse`, { method: 'POST', key: true, data: { ...reuse, lease_token: 'wrong' }, expected: 409 });
await call(`mail-jobs/${resend.id}/reuse`, { method: 'POST', key: true, data: { ...reuse, note: '' }, expected: 400 });
const sameResult = (await call(`shortlists/${mailDraft.shortlist_id}/versions`, { method: 'POST', key: true, data: { ...mailInput, rows: rows.slice().reverse(), mail_job_id: resend.id, mail_lease_token: resendClaim.lease_token, source_upload_ids: [], expected_latest_version_id: mailDraft.version_id }, expected: 409 })).result;
assert.equal(sameResult.duplicate, true); assert.equal(sameResult.version_id, mailDraft.version_id);
assert.equal((await call(`mail-jobs/${resend.id}/reuse`, { method: 'POST', key: true, data: reuse })).result.reused, true);
await call(`mail-jobs/${resend.id}/reuse`, { method: 'POST', key: true, data: reuse });
assert.equal((await call(`mail-jobs/${resend.id}`, { key: true })).result.versions.length, 1);
await call(`mail-jobs/${resend.id}/ignore`, { method: 'POST', key: true, data: { lease_token: resendClaim.lease_token, note: 'Cannot ignore a linked result.' }, expected: 400 });
await call(`mail-jobs/${resend.id}/complete`, { method: 'POST', key: true, data: { lease_token: resendClaim.lease_token } });
const reusedJob = (await call(`mail-jobs/${resend.id}`, { key: true })).result;
assert.equal(reusedJob.job.status, 'done'); assert.deepEqual(reusedJob.job.result_version_ids, [mailDraft.version_id]);
assert.equal((await call(`shortlists/${mailDraft.shortlist_id}/versions`, { key: true })).result.versions.length, 1, 'Duplicate mail must not add a version');
assert.equal((await call('shortlists/' + mailDraft.shortlist_id)).result.shortlist.added_at, publishedMail.shortlist.added_at, 'A resend must not bump Date added');
// Only a current publication can be reused; a new event/time gets its own identity.
const newerMail = (await call('mail/import', { method: 'POST', owner: true, raw: 'From: SPO <spo@example.invalid>\r\nSubject: New event short lists\r\nDate: Sat, 24 Oct 2026 12:00:00 +0530\r\n\r\nShort listed students: 0230001, 230002.\r\n', expected: 201 })).result;
const newerClaim = (await call(`mail-jobs/${newerMail.id}/claim`, { method: 'POST', key: true, data: {} })).result;
const newEvent = (await call('shortlists', { method: 'POST', key: true, data: { ...input, company: input.company + ' mail', round: 'Interview 2026-10-27 10:00 IST', mail_job_id: newerMail.id, mail_lease_token: newerClaim.lease_token, source_upload_ids: [] }, expected: 201 })).result;
await call(`mail-jobs/${newerMail.id}/reuse`, { method: 'POST', key: true, data: { ...reuse, lease_token: newerClaim.lease_token, shortlist_id: newEvent.shortlist_id, version_id: newEvent.version_id }, expected: 409 });
const sortedQueue = (await call('mail-jobs?status=all&limit=50', { owner: true })).result.jobs;
for (let index = 1; index < sortedQueue.length; index++) assert.ok((sortedQueue[index - 1].received_at || sortedQueue[index - 1].created_at) >= (sortedQueue[index].received_at || sortedQueue[index].created_at), 'Queue must be newest received first');
assert.ok(sortedQueue.findIndex(job => job.id === newerMail.id) < sortedQueue.findIndex(job => job.id === resend.id), 'Date order must not follow import order');
// TXT and image mail attachments remain private and preserve their bytes.
const mediaEml = 'From: SPO <spo@example.invalid>\r\nSubject: Image and TXT shortlists\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="media"\r\n\r\n--media\r\nContent-Type: text/plain\r\n\r\nShortlisted students are attached.\r\n--media\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename="candidates.txt"\r\n\r\nSynthetic 230002\r\n--media\r\nContent-Type: image/png\r\nContent-Disposition: inline; filename="candidates.png"\r\nContent-ID: <candidates>\r\nContent-Transfer-Encoding: base64\r\n\r\niVBORw0KGgo=\r\n--media--\r\n';
const mediaJob = (await call('mail/import', { method: 'POST', owner: true, raw: mediaEml, expected: 201 })).result;
const mediaSource = (await call('mail-jobs/' + mediaJob.id, { key: true })).result.source;
assert.equal(mediaSource.attachments.length, 2); assert.equal(mediaSource.attachments[1].inline, true);
await call('uploads/' + mediaSource.attachments[0].id, { expected: 401 });
assert.match((await call('uploads/' + mediaSource.attachments[0].id, { key: true })).result, /Synthetic 230002/);
const imageDownload = await fetch(origin + '/api/v1/uploads/' + mediaSource.attachments[1].id, { headers: { Connection: 'close', Authorization: 'Bearer ' + uploaderKey } });
assert.equal(imageDownload.status, 200); assert.deepEqual(new Uint8Array(await imageDownload.arrayBuffer()), new Uint8Array(Buffer.from('iVBORw0KGgo=', 'base64'))); count++;
// Simulate a message collected before image/TXT support: a rescan upgrades that same job.
const legacySource = JSON.stringify({ ...mediaSource, attachments: [] });
const legacyBytes = Buffer.from(legacySource);
const legacySql = `UPDATE object_chunks SET bytes = X'${legacyBytes.toString('hex')}' WHERE object_key = (SELECT object_key FROM mail_jobs WHERE id = '${mediaJob.id}'); UPDATE objects SET size = ${legacyBytes.length}, chunks = 1 WHERE key = (SELECT object_key FROM mail_jobs WHERE id = '${mediaJob.id}'); UPDATE mail_jobs SET source_upload_ids = '[]' WHERE id = '${mediaJob.id}';`;
const legacySeed = spawnSync(process.execPath, [cli, 'd1','execute','DB','--local','--persist-to',state,'--command',legacySql], { encoding: 'utf8' });
assert.equal(legacySeed.status, 0, 'Synthetic legacy source setup failed');
const upgraded = (await call('mail/import', { method: 'POST', owner: true, raw: mediaEml, expected: 201 })).result;
assert.equal(upgraded.updated, true); assert.equal(upgraded.added_attachments, 2); assert.equal(upgraded.id, mediaJob.id);
const upgradedDetail = (await call('mail-jobs/' + mediaJob.id, { key: true })).result;
assert.equal(upgradedDetail.source.attachments.length, 2); assert.equal(upgradedDetail.job.source_upload_ids.length, 2);
assert.equal((await call('mail/import', { method: 'POST', owner: true, raw: mediaEml, expected: 201 })).result.updated, undefined, 'A second rescan must not upload those files again');
// Publishing an old email after a newer one must not move it ahead in the dashboard.
await call(`shortlists/${newEvent.shortlist_id}/publish`, { method: 'POST', key: true, data: { version_id: newEvent.version_id, expected_current_version_id: null, mail_lease_token: newerClaim.lease_token } });
const historicalMail = (await call('mail/import', { method: 'POST', owner: true, raw: 'From: SPO <spo@example.invalid>\r\nSubject: Historical test shortlist\r\nDate: Thu, 1 Oct 2026 12:00:00 +0530\r\n\r\nBusiness Analyst shortlisted for an online assessment: 0230001, 230002.\r\n', expected: 201 })).result;
const historicalDetail = (await call('mail-jobs/' + historicalMail.id, { key: true })).result;
const historicalClaim = (await call(`mail-jobs/${historicalMail.id}/claim`, { method: 'POST', key: true, data: {} })).result;
const historicalDraft = (await call('shortlists', { method: 'POST', key: true, data: { ...input, company: input.company + ' historical', role: 'Business Analyst', round: 'Online assessment', mail_job_id: historicalMail.id, mail_lease_token: historicalClaim.lease_token, source_upload_ids: [] }, expected: 201 })).result;
await call(`shortlists/${historicalDraft.shortlist_id}/publish`, { method: 'POST', key: true, data: { version_id: historicalDraft.version_id, expected_current_version_id: null, mail_lease_token: historicalClaim.lease_token } });
const datedIndex = (await call('shortlists')).result.shortlists;
for(let index = 1; index < datedIndex.length; index++) assert.ok(datedIndex[index - 1].added_at >= datedIndex[index].added_at, 'Dashboard sorts by Date added');
assert.ok(datedIndex.findIndex(list => list.id === newEvent.shortlist_id) < datedIndex.findIndex(list => list.id === historicalDraft.shortlist_id));
assert.equal(datedIndex.find(list => list.id === historicalDraft.shortlist_id).added_at, historicalDetail.job.received_at);
// A real revision adopts its own source date; restoring the original restores its date too.
const revisionMail = (await call('mail/import', { method: 'POST', owner: true, raw: 'From: SPO <spo@example.invalid>\r\nSubject: Revised interview shortlist\r\nDate: Sun, 25 Oct 2026 12:00:00 +0530\r\n\r\nRevised shortlisted candidates: 0230001. This replaces the earlier list for the same interview.\r\n', expected: 201 })).result;
const revisionDetail = (await call('mail-jobs/' + revisionMail.id, { key: true })).result;
const revisionClaim = (await call(`mail-jobs/${revisionMail.id}/claim`, { method: 'POST', key: true, data: {} })).result;
const revision = (await call(`shortlists/${mailDraft.shortlist_id}/versions`, { method: 'POST', key: true, data: { ...input, rows: rows.slice(0,1), mail_job_id: revisionMail.id, mail_lease_token: revisionClaim.lease_token, source_upload_ids: [], expected_latest_version_id: mailDraft.version_id }, expected: 201 })).result;
await call(`shortlists/${mailDraft.shortlist_id}/publish`, { method: 'POST', key: true, data: { version_id: revision.version_id, expected_current_version_id: mailDraft.version_id, mail_lease_token: revisionClaim.lease_token } });
assert.equal((await call('shortlists/' + mailDraft.shortlist_id)).result.shortlist.added_at, revisionDetail.job.received_at);
await call(`shortlists/${mailDraft.shortlist_id}/restore`, { method: 'POST', owner: true, data: { version_id: mailDraft.version_id, expected_current_version_id: revision.version_id, acknowledge_warnings: true } });
assert.equal((await call('shortlists/' + mailDraft.shortlist_id)).result.shortlist.added_at, publishedMail.shortlist.added_at);
// Seven-day retention deletes completed sources without changing any shortlist or master.
function retentionSql(command, fail = false) {
  const result = spawnSync(process.execPath, [cli, 'd1', 'execute', 'DB', '--local', '--persist-to', state, '--json', '--command', command], { encoding: 'utf8' });
  if (fail) { assert.notEqual(result.status, 0); assert.match(result.stdout + result.stderr, /source_upload_unavailable/); return; }
  assert.equal(result.status, 0, 'Synthetic retention SQL failed: ' + result.stdout + result.stderr);
  return JSON.parse(result.stdout).map(item => item.results);
}
const sqlText = value => "'" + String(value).replaceAll("'", "''") + "'";
const protectedSnapshotSql = `SELECT * FROM shortlists ORDER BY id; SELECT * FROM versions ORDER BY id; SELECT * FROM masters ORDER BY id;
SELECT * FROM objects WHERE key IN (SELECT object_key FROM masters UNION SELECT object_key FROM versions) ORDER BY key;
SELECT object_key, chunk_index, hex(bytes) AS content FROM object_chunks WHERE object_key IN (SELECT object_key FROM masters UNION SELECT object_key FROM versions) ORDER BY object_key, chunk_index;`;
await call('mail/cleanup', { method: 'POST', data: {}, expected: 401 });
await call('mail/cleanup', { method: 'POST', key: true, data: {}, expected: 403 });
await call('mail/cleanup', { method: 'POST', owner: true, evil: true, data: {}, expected: 403 });
await call('mail/cleanup', { method: 'POST', owner: true, data: { retention_days: 0 }, expected: 400 });
const policy = (await call('mail/status', { owner: true })).result.retention;
assert.equal(policy.days, 7); assert.equal(policy.check_interval, 'hourly');
const attachmentId = mailDetail.source.attachments[0].id;
const sharedJob = (await call('mail-jobs/' + duplicateMail.id, { key: true })).result;
const protectedDraft = (await call('shortlists', { method: 'POST', key: true, data: { ...input, company: input.company + ' retention-protected draft', source_upload_ids: [attachmentId] }, expected: 201 })).result;
const ignoredMail = (await call('mail/import', { method: 'POST', owner: true, raw: eml.replace('mail-qa@', 'mail-retention-ignored@'), expected: 201 })).result;
const ignoredClaim = (await call(`mail-jobs/${ignoredMail.id}/claim`, { method: 'POST', key: true, data: {} })).result;
await call(`mail-jobs/${ignoredMail.id}/ignore`, { method: 'POST', key: true, data: { lease_token: ignoredClaim.lease_token, note: 'Synthetic ignored source stays outside completed-only cleanup.' } });
const oldCompletion = new Date(Date.now() - 7 * 86400000 - 1000).toISOString();
const recentCompletion = new Date().toISOString();
const firstMailKey = 'mail/' + mail.id + '.json', oldSourceKey = 'mail/' + mail.id + '-superseded.json';
retentionSql(`UPDATE mail_jobs SET completed_at = ${sqlText(oldCompletion)}, updated_at = ${sqlText(new Date().toISOString())} WHERE id = ${sqlText(mail.id)};
UPDATE mail_jobs SET received_at = '2000-01-01T00:00:00.000Z', completed_at = NULL WHERE id = ${sqlText(resend.id)};
UPDATE mail_jobs SET status = 'done', updated_at = ${sqlText(recentCompletion)} WHERE id = ${sqlText(resend.id)};
UPDATE mail_jobs SET completed_at = '2000-01-01T00:00:00.000Z', created_at = '2000-01-01T00:00:00.000Z' WHERE id IN (${[duplicateMail.id, historicalMail.id, mediaJob.id, ignoredMail.id].map(sqlText).join(',')});
UPDATE mail_jobs SET source_upload_ids = json_insert(source_upload_ids, '$[#]', ${sqlText(attachmentId)}) WHERE id = ${sqlText(duplicateMail.id)};
INSERT INTO objects SELECT ${sqlText(oldSourceKey)}, size, chunks FROM objects WHERE key = ${sqlText(firstMailKey)};
INSERT INTO object_chunks SELECT ${sqlText(oldSourceKey)}, chunk_index, bytes FROM object_chunks WHERE object_key = ${sqlText(firstMailKey)};`);
const beforeProtected = retentionSql(protectedSnapshotSql);
const beforeMailRows = (await call('shortlists/' + mailDraft.shortlist_id)).result;
const beforeMasterRows = (await call('master', { owner: true })).result.rows;
const firstCleanup = (await call('mail/cleanup', { method: 'POST', owner: true, data: {} })).result;
assert.equal(firstCleanup.jobs_cleaned, 1); assert.equal(firstCleanup.attachments_deleted, 0, 'Unfinished jobs and drafts protect shared attachments');
assert.ok(firstCleanup.bytes_deleted > 0);
assert.deepEqual(retentionSql(protectedSnapshotSql), beforeProtected, 'Every shortlist, version, master and their exact object bytes must be unchanged');
const expiredSource = (await call('mail-jobs/' + mail.id, { key: true })).result;
assert.ok(expiredSource.job.source_deleted_at); assert.equal(expiredSource.job.completed_at, oldCompletion);
assert.equal(expiredSource.job.received_at, mailDetail.job.received_at);
assert.deepEqual(expiredSource.source.attachments, []); assert.deepEqual(expiredSource.source.links, []); assert.equal(expiredSource.source.text, '');
assert.equal(expiredSource.versions[0].id, mailDraft.version_id);
assert.match((await call('uploads/' + attachmentId, { key: true })).result, /Synthetic Test A/);
assert.deepEqual(retentionSql(`SELECT count(*) AS count FROM objects WHERE key IN (${sqlText(firstMailKey)},${sqlText(oldSourceKey)}); SELECT count(*) AS count FROM object_chunks WHERE object_key IN (${sqlText(firstMailKey)},${sqlText(oldSourceKey)});`), [[{ count: 0 }], [{ count: 0 }]], 'Delete current and superseded source chunks');
const reimportExpired = (await call('mail/import', { method: 'POST', owner: true, raw: eml, expected: 201 })).result;
assert.equal(reimportExpired.duplicate, true); assert.equal(reimportExpired.queued, undefined, 'A rescan must not recreate a completed, cleaned mail');
for (const keptId of [resend.id, duplicateMail.id, historicalMail.id, mediaJob.id, ignoredMail.id]) {
  const kept = (await call('mail-jobs/' + keptId, { key: true })).result;
  assert.equal(kept.job.source_deleted_at, null); assert.ok(kept.source.text, 'Recent completion or unfinished/ignored status must retain its source');
  if (keptId === resend.id) assert.equal(kept.job.completed_at, recentCompletion, 'Database records completion even for a legacy Worker during deployment');
}
retentionSql(`UPDATE mail_jobs SET source_upload_ids = ${sqlText(JSON.stringify(sharedJob.job.source_upload_ids))} WHERE id = ${sqlText(duplicateMail.id)};`);
const stillDraft = (await call('mail/cleanup', { method: 'POST', owner: true, data: {} })).result;
assert.equal(stillDraft.attachments_deleted, 0, 'An unpublished draft alone must protect its source');
await call(`shortlists/${protectedDraft.shortlist_id}/publish`, { method: 'POST', key: true, data: { version_id: protectedDraft.version_id, expected_current_version_id: null, acknowledge_warnings: true } });
const publishedProtected = retentionSql(protectedSnapshotSql);
const finalCleanup = (await call('mail/cleanup', { method: 'POST', owner: true, data: {} })).result;
assert.equal(finalCleanup.jobs_cleaned, 0); assert.equal(finalCleanup.attachments_deleted, 1); assert.ok(finalCleanup.bytes_deleted > 0);
assert.deepEqual(retentionSql(protectedSnapshotSql), publishedProtected, 'Cleaning attachments must preserve complete version history, drafts and masters');
await call('uploads/' + attachmentId, { expected: 401 });
await call('uploads/' + attachmentId, { key: true, expected: 410 });
assert.equal((await call('uploads', { key: true })).result.uploads.some(file => file.id === attachmentId), false);
assert.deepEqual((await call('master', { owner: true })).result.rows, beforeMasterRows);
assert.deepEqual((await call('shortlists/' + mailDraft.shortlist_id)).result, beforeMailRows, 'Public values, version ID and Date added must remain identical');
assert.deepEqual((await call('shortlists/' + protectedDraft.shortlist_id)).result.rows, rows);
assert.match((await call('uploads/' + upload.id, { key: true })).result, /Synthetic/, 'Manual uploads are never expired by mail retention');
assert.deepEqual(retentionSql(`SELECT count(*) AS count FROM objects WHERE key = 'inputs/${attachmentId}'; SELECT count(*) AS count FROM object_chunks WHERE object_key = 'inputs/${attachmentId}'; SELECT purged_at IS NOT NULL AS marked FROM uploads WHERE id = ${sqlText(attachmentId)};`), [[{ count: 0 }], [{ count: 0 }], [{ marked: 1 }]], 'Delete attachment bytes and retain an explicit audit marker');
await call('shortlists', { method: 'POST', key: true, data: { ...input, company: input.company + ' expired attachment', source_upload_ids: [attachmentId] }, expected: 400 });
retentionSql(`INSERT INTO versions (id, shortlist_id, number, object_key, row_count, master_id, created_at, created_by, processing_notes, warnings, source_upload_ids, published_at, source_mail_job_id)
SELECT ${sqlText('synthetic-race-' + Date.now())}, shortlist_id, 99999, object_key, row_count, master_id, created_at, created_by, processing_notes, warnings, ${sqlText(JSON.stringify([attachmentId]))}, NULL, NULL FROM versions WHERE id = ${sqlText(protectedDraft.version_id)};`, true);
const idempotentCleanup = (await call('mail/cleanup', { method: 'POST', owner: true, data: {} })).result;
assert.equal(idempotentCleanup.jobs_cleaned, 0); assert.equal(idempotentCleanup.attachments_deleted, 0); assert.equal(idempotentCleanup.bytes_deleted, 0);
await call(`shortlists/${mailDraft.shortlist_id}/restore`, { method: 'POST', owner: true, data: { version_id: revision.version_id, expected_current_version_id: mailDraft.version_id, acknowledge_warnings: true } });
await call(`shortlists/${mailDraft.shortlist_id}/restore`, { method: 'POST', owner: true, data: { version_id: mailDraft.version_id, expected_current_version_id: revision.version_id, acknowledge_warnings: true } });
assert.deepEqual((await call('shortlists/' + mailDraft.shortlist_id)).result.rows, rows, 'Historical versions remain restorable after source expiry');
const cron = new URL('/__scheduled', origin); cron.searchParams.set('cron', '0 * * * *');
const cronRun = await fetch(cron, { headers: { Connection: 'close' } });
assert.equal(cronRun.status, 200, 'Local Cloudflare scheduled handler must execute successfully'); count++;
const finalRetentionState = (await call('mail/status', { owner: true })).result.retention.last_run;
assert.equal(finalRetentionState.status, 'ok'); assert.equal(finalRetentionState.jobs_cleaned, 0);

// Company/round grouping is a server-owned read view; uploaded event identities stay intact.
const groupCompany = input.company + ' Display';
const groupingSources = [
  { company: groupCompany + ' Ltd.', role: 'Hardware', round: 'Technical Test', date: '2026-10-10T00:00:00.000Z' },
  { company: groupCompany.toLowerCase() + ' Private Limited', role: 'Hardware', round: 'Online Aptitude Test — 25 October 2026, 1:30 PM', date: '2026-10-25T00:00:00.000Z' },
  { company: groupCompany, role: 'Developer', round: 'GD', date: '2026-10-12T00:00:00.000Z' },
  { company: groupCompany, role: 'Analyst', round: 'Group Discussion', date: '2026-10-11T00:00:00.000Z' },
  { company: groupCompany, role: 'Developer', round: 'Technical Interview', date: '2026-10-13T00:00:00.000Z' },
  { company: input.company + ' Other company', role: 'Developer', round: 'Test', date: '2026-10-24T00:00:00.000Z' },
];
const groupingPublished = [];
for (const source of groupingSources) {
  const draft = (await call('shortlists', { method: 'POST', key: true, data: { ...input, company: source.company, role: source.role, round: source.round }, expected: 201 })).result;
  await call(`shortlists/${draft.shortlist_id}/publish`, { method: 'POST', key: true, data: { version_id: draft.version_id, expected_current_version_id: null, acknowledge_warnings: true } });
  groupingPublished.push({ ...draft, source });
}
retentionSql(groupingPublished.map(draft => `UPDATE versions SET created_at = ${sqlText(draft.source.date)} WHERE id = ${sqlText(draft.version_id)};`).join('\n'));
const groupingHidden = (await call('shortlists', { method: 'POST', key: true, data: { ...input, company: groupCompany, role: 'Private role', round: 'HR interview' }, expected: 201 })).result;
const rawIndex = (await call('shortlists')).result;
assert.equal(rawIndex.company_groups, undefined, 'Existing flat API contract stays unchanged');
const groupedIndex = (await call('shortlists?grouped=1')).result;
assert.deepEqual(groupedIndex.shortlists, rawIndex.shortlists);
const companyGroup = groupedIndex.company_groups.find(group => group.shortlists.some(list => list.id === groupingPublished[0].shortlist_id));
assert.equal(companyGroup.shortlists.length, 5, 'Legal suffix/case aliases must group across roles and dates');
assert.equal(companyGroup.added_at, '2026-10-25T00:00:00.000Z');
assert.equal(companyGroup.shortlists.filter(list => list.round_categories.includes('Test')).length, 2);
assert.equal(companyGroup.shortlists.filter(list => list.round_categories.includes('Group Discussion')).length, 2);
assert.equal(companyGroup.shortlists.filter(list => list.round_categories.includes('Interview')).length, 1);
for (const draft of groupingPublished.slice(0, 5)) {
  const member = companyGroup.shortlists.find(list => list.id === draft.shortlist_id);
  assert.equal(member.company, draft.source.company); assert.equal(member.role, draft.source.role); assert.equal(member.round, draft.source.round); assert.equal(member.added_at, draft.source.date);
}
const nestedTests = companyGroup.rounds.find(stage => stage.round === 'Test');
assert.equal(nestedTests.roles.length, 1);
assert.equal(nestedTests.roles[0].role, 'Hardware');
assert.equal(nestedTests.roles[0].shortlists.length, 2);
assert.deepEqual(groupedIndex.company_groups.flatMap(company => company.rounds.flatMap(stage => stage.roles.flatMap(role => role.shortlists.map(list => list.id)))).sort(), rawIndex.shortlists.map(list => list.id).sort(), 'Every list appears exactly once in company / round / role nesting');
const otherCompanyGroup = groupedIndex.company_groups.find(group => group.shortlists.some(list => list.id === groupingPublished[5].shortlist_id));
assert.ok(groupedIndex.company_groups.indexOf(companyGroup) < groupedIndex.company_groups.indexOf(otherCompanyGroup), 'Companies are ordered by their latest Date added');
const groupedIds = groupedIndex.company_groups.flatMap(group => group.shortlists.map(list => list.id));
assert.equal(groupedIds.includes(groupingHidden.shortlist_id), false);
assert.deepEqual([...groupedIds].sort(), rawIndex.shortlists.map(list => list.id).sort(), 'Every public list appears exactly once');
assert.equal(groupedIndex.round_categories.filter(category => category === 'Test').length, 1);
assert.equal(groupedIndex.round_categories.includes('Technical Test'), false);
assert.equal(groupedIndex.round_categories.includes('Group Discussion'), true);
assert.deepEqual((await call('shortlists')).result, rawIndex, 'Grouping does not change stored identities, values or dates');
await call('shortlists?include_drafts=1&grouped=1', { expected: 401 });
const privateGroups = (await call('shortlists?include_drafts=1&grouped=1', { key: true })).result;
assert.ok(privateGroups.company_groups.some(group => group.shortlists.some(list => list.id === groupingHidden.shortlist_id)), 'Authorized draft index still works');

// Ambiguous identities are published normally, with exactly one count per source entry.
const ambiguousEntry = { source_name: 'Synthetic source name', source_index: 2, reason: 'Two supported master records; the source has no unique roll.', possible_rolls: rows.map(row => row.roll) };
const ambiguityInput = { ...input, company: input.company + ' ambiguity', rows: [rows[1]], unresolved_candidates: [ambiguousEntry] };
await call('shortlists', { method: 'POST', key: true, data: { ...ambiguityInput, unresolved_candidates: [{ ...ambiguousEntry, possible_rolls: ['not-in-master'] }] }, expected: 400 });
await call('shortlists', { method: 'POST', key: true, data: { ...ambiguityInput, unresolved_candidates: [{ ...ambiguousEntry, possible_matches: rows }] }, expected: 400 });
const ambiguousDraft = (await call('shortlists', { method: 'POST', key: true, data: ambiguityInput, expected: 201 })).result;
assert.equal(ambiguousDraft.row_count, 1); assert.equal(ambiguousDraft.unresolved_count, 1); assert.equal(ambiguousDraft.candidate_count, 2);
await call('shortlists/' + ambiguousDraft.shortlist_id, { expected: 404 });
await call(`shortlists/${ambiguousDraft.shortlist_id}/publish`, { method: 'POST', key: true, data: { version_id: ambiguousDraft.version_id, expected_current_version_id: null } });
const ambiguousPublic = (await call('shortlists/' + ambiguousDraft.shortlist_id)).result;
assert.deepEqual(ambiguousPublic.rows, [rows[1]]);
assert.equal(ambiguousPublic.unresolved_candidates.length, 1);
assert.deepEqual(ambiguousPublic.unresolved_candidates[0].possible_matches, rows);
assert.equal(ambiguousPublic.version.candidate_count, 2, 'Alternatives must not inflate shortlist size');
const ambiguousCsv = (await call(`shortlists/${ambiguousDraft.shortlist_id}/export.csv`)).result;
assert.match(ambiguousCsv, /"Synthetic source name","","","","",""/);
assert.equal(ambiguousCsv.includes('0230001'), false, 'Do not export a possible roll as a confirmed identity');
const ambiguousIndex = (await call('shortlists?grouped=1')).result.shortlists.find(list => list.id === ambiguousDraft.shortlist_id);
assert.equal(ambiguousIndex.row_count + ambiguousIndex.unresolved_count, 2);
const onlyAmbiguous = (await call('shortlists', { method: 'POST', key: true, data: { ...ambiguityInput, company: input.company + ' all ambiguous', rows: [] }, expected: 201 })).result;
assert.equal(onlyAmbiguous.candidate_count, 1);
await call(`shortlists/${onlyAmbiguous.shortlist_id}/publish`, { method: 'POST', key: true, data: { version_id: onlyAmbiguous.version_id, expected_current_version_id: null } });
const originalAmbiguity = structuredClone(ambiguousPublic.unresolved_candidates);
await call('master', { method: 'PUT', owner: true, data: { name: 'Synthetic changed master', rows: rows.map(row => ({ ...row, cpi: 9 })) }, expected: 201 });
assert.deepEqual((await call('shortlists/' + ambiguousDraft.shortlist_id)).result.unresolved_candidates, originalAmbiguity, 'Possible details remain a pinned snapshot after a master update');
const ambiguityMail = (await call('mail/import', { method: 'POST', owner: true, raw: eml.replace('mail-qa@', 'mail-ambiguity@').replace('Synthetic shortlist.', 'Synthetic ambiguous shortlist.'), expected: 201 })).result;
const ambiguitySource = (await call('mail-jobs/' + ambiguityMail.id, { key: true })).result;
const ambiguityClaim = (await call(`mail-jobs/${ambiguityMail.id}/claim`, { method: 'POST', key: true, data: {} })).result;
const ambiguityMailDraft = (await call('shortlists', { method: 'POST', key: true, data: { ...ambiguityInput, company: input.company + ' mail ambiguity', source_upload_ids: ambiguitySource.job.source_upload_ids, mail_job_id: ambiguityMail.id, mail_lease_token: ambiguityClaim.lease_token }, expected: 201 })).result;
await call(`shortlists/${ambiguityMailDraft.shortlist_id}/publish`, { method: 'POST', key: true, data: { version_id: ambiguityMailDraft.version_id, expected_current_version_id: null, mail_lease_token: ambiguityClaim.lease_token } });
await call(`mail-jobs/${ambiguityMail.id}/complete`, { method: 'POST', key: true, data: { lease_token: ambiguityClaim.lease_token, note: 'All source candidates published, including one ambiguous identity with alternatives.' } });
assert.equal((await call('mail-jobs/' + ambiguityMail.id, { key: true })).result.job.status, 'done', 'Name ambiguity does not create a review state');

await call('keys/' + key.id, { method: 'DELETE', owner: true });
await call('master', { key: true, expected: 401 });
console.log(JSON.stringify({ passed: true, http_checks: count, all_records_synthetic: true, checked: ['private master', 'anonymous write denial', 'uploader scopes', 'private source files', 'six columns', 'draft privacy', 'publication', 'CSV', 'version conflicts', 'restore', 'owner-only deletion', 'deleted export denial', 'stale deletion rejection', 'deleted shortlist recovery', 'private draft recovery', 'private mail ingestion', 'mail attachment storage', 'duplicate message detection', 'unapproved links', 'exclusive job claims', 'lease expiry and crash recovery', 'mail result publication', 'review and owner retry', 'seven-day completed-only retention', 'shared attachment protection', 'exact shortlist/master byte preservation', 'source deletion audit markers', 'retention idempotency', 'cron handler', 'server-owned company grouping', 'round alias categories', 'unchanged flat API and source event identities', 'grouped draft privacy', 'company-round-role nesting', 'published ambiguous identities and one-per-source counts', 'pinned alternative details', 'unblocked ambiguous mail completion', 'key revocation', 'CSRF'] }, null, 2));

} finally {
  server.kill('SIGTERM');
  await new Promise(resolve => { if (server.exitCode !== null) resolve(); else { server.once('exit', resolve); setTimeout(() => { server.kill('SIGKILL'); resolve(); }, 3000).unref(); } });
  rmSync(state, { recursive: true, force: true });
}

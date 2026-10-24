import { env } from 'cloudflare:workers';
import { objectStore } from './object-store';
import { agentGuide } from './agent-guide';
import { mailGuide } from './mail-guide';
import { mailConfig, mailHash, mailLease, mailStatus, saveMail, syncMail } from './mail-service';
import { validateMailConfig } from './mail-content';
import { COLUMNS, csvRows, InputError, sameShortlistRows, StudentRow, toCSV, validateRows } from './records';

type Actor = { role: 'admin' | 'uploader'; id: string; label: string };
type List = { id: string; company: string; role: string; round: string; season: string; notes: string; published_version_id: string | null; created_at: string; updated_at: string };
type Version = { id: string; shortlist_id: string; number: number; object_key: string; row_count: number; master_id: string; processing_notes: string; warnings: string; source_upload_ids: string; created_at: string; published_at: string | null; source_mail_job_id: string | null };
type Master = { id: string; name: string; object_key: string; row_count: number; cpi_count: number; created_at: string; source_hash: string };
type Data = Record<string, unknown>;
const db = () => { if (!env.DB) throw new InputError('Database is not connected yet.', 503); return env.DB; };
const bucket = () => objectStore(db());
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const responseHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' };
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(data, { status, headers: { ...responseHeaders, ...headers } });
const plain = (data: string, type = 'text/plain; charset=utf-8', headers: Record<string, string> = {}) => new Response(data, { headers: { ...responseHeaders, 'Content-Type': type, ...headers } });

async function sha256(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(n => n.toString(16).padStart(2, '0')).join('');
}
function equal(a: string, b: string) { let diff = a.length ^ b.length; for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); return diff === 0; }
function bearer(request: Request) { return request.headers.get('Authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1] || ''; }
function sessionKey(request: Request) { return request.headers.get('Cookie')?.split(';').map(value => value.trim()).find(value => value.startsWith('shortlist_session='))?.slice('shortlist_session='.length) || ''; }
async function keyActor(token: string): Promise<Actor | null> {
  if (/^own_[A-Za-z0-9_-]{43}$/.test(token)) {
    if (!env.ADMIN_KEY_SHA256 || !/^[a-f0-9]{64}$/.test(env.ADMIN_KEY_SHA256)) return null;
    return equal(await sha256(token), env.ADMIN_KEY_SHA256) ? { role: 'admin', id: 'owner', label: 'Owner' } : null;
  }
  if (!/^upl_[A-Za-z0-9_-]{40,60}$/.test(token)) return null;
  const key = await db().prepare('SELECT id, label FROM access_keys WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?').bind(await sha256(token), now()).first<{ id: string; label: string }>();
  return key ? { role: 'uploader', id: key.id, label: key.label } : null;
}
async function actor(request: Request): Promise<Actor | null> {
  return keyActor(bearer(request) || sessionKey(request));
}
async function access(request: Request, admin = false) {
  const user = await actor(request);
  if (!user) throw new InputError('Provide a valid owner or uploader access key.', 401);
  if (admin && user.role !== 'admin') throw new InputError('This action is reserved for the owner.', 403);
  return user;
}
function assertMutationOrigin(request: Request) {
  if (request.method === 'GET' || request.method === 'HEAD' || bearer(request)) return;
  const origin = request.headers.get('Origin');
  if (!origin || origin !== new URL(request.url).origin) throw new InputError('This action must originate from this portal.', 403);
}
async function limited(request: Request, maximum = 6 * 1024 * 1024): Promise<Uint8Array> {
  if (Number(request.headers.get('Content-Length') || 0) > maximum) throw new InputError('Request too large.', 413);
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader(); const chunks = []; let length = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    length += value.length; if (length > maximum) { await reader.cancel(); throw new InputError('Request too large.', 413); } chunks.push(value);
  }
  const result = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; } return result;
}
async function body(request: Request): Promise<Data> {
  let data; try { data = JSON.parse(new TextDecoder().decode(await limited(request))); } catch (error) { if (error instanceof InputError) throw error; throw new InputError('Send a valid JSON object.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new InputError('Send a JSON object.'); return data;
}
function string(input: unknown, label: string, maximum = 180, required = false) {
  if (input === undefined || input === null) { if (required) throw new InputError(`${label} is required.`); return ''; }
  if (typeof input !== 'string' || input.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(input)) throw new InputError(`Invalid ${label}.`);
  if (required && !input.trim()) throw new InputError(`${label} is required.`); return input.trim();
}
async function currentMaster(): Promise<Master | null> {
  return db().prepare("SELECT masters.* FROM masters JOIN settings ON settings.key = 'current_master_id' AND settings.value = masters.id").first<Master>();
}
async function masterRows(master: Master) {
  const object = await bucket().get(master.object_key); if (!object) throw new InputError('The master file is temporarily unavailable.', 503);
  return object.json<StudentRow[]>();
}
async function findList(listId: string) {
  const list = await db().prepare('SELECT * FROM shortlists WHERE id = ? AND deleted_at IS NULL').bind(listId).first<List>();
  if (!list) throw new InputError('Shortlist not found.', 404); return list;
}
async function findVersion(versionId: string, listId: string) {
  const version = await db().prepare('SELECT * FROM versions WHERE id = ? AND shortlist_id = ?').bind(versionId, listId).first<Version>();
  if (!version) throw new InputError('Version not found.', 404); return version;
}
async function versionRows(version: Version) {
  const object = await bucket().get(version.object_key); if (!object) throw new InputError('The shortlist file is temporarily unavailable.', 503); return object.json<StudentRow[]>();
}
async function mailVersions(jobId: string) {
  return db().prepare('SELECT v.id, v.shortlist_id, v.number, v.row_count, v.published_at, s.company, s.role, s.round, s.season, s.published_version_id, s.deleted_at FROM versions v JOIN shortlists s ON s.id = v.shortlist_id WHERE v.source_mail_job_id = ? OR v.id IN (SELECT value FROM json_each((SELECT result_version_ids FROM mail_jobs WHERE id = ?))) ORDER BY v.created_at')
    .bind(jobId, jobId).all<{ id: string; shortlist_id: string; published_at: string | null; published_version_id: string | null; deleted_at: string | null }>();
}
const publicVersion = (version: Version) => ({ id: version.id, number: version.number, row_count: version.row_count, created_at: version.created_at, published_at: version.published_at });
async function log(action: string, actorId: string, target: string) {
  await db().prepare('INSERT INTO audit (id, action, actor, target_id, created_at) VALUES (?, ?, ?, ?, ?)').bind(id(), action, actorId, target, now()).run();
}

async function writeMaster(request: Request) {
  const owner = await access(request, true);
  const input = await body(request); const name = string(input.name, 'Master name', 200, true);
  const { rows, warnings } = validateRows(input.rows);
  const masterId = id(), createdAt = now(), key = `masters/${masterId}.json`, serialized = JSON.stringify(rows);
  await bucket().put(key, serialized, { httpMetadata: { contentType: 'application/json' } });
  try {
    const statements = [db().prepare('INSERT INTO masters (id, name, object_key, row_count, cpi_count, created_at, source_hash) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(masterId, name, key, rows.length, rows.filter(row => row.cpi !== null).length, createdAt, await sha256(serialized)),
      db().prepare("INSERT INTO settings (key, value) VALUES ('current_master_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(masterId)];
    await db().batch(statements);
  } catch (error) { await bucket().delete(key); throw error; }
  await log('master_imported', owner.id, masterId);
  return json({ id: masterId, name, row_count: rows.length, cpi_count: rows.filter(row => row.cpi !== null).length, warnings, created_at: createdAt }, 201);
}

async function createDraft(request: Request, listId?: string) {
  const user = await access(request); const input = await body(request);
  if (input.rows !== undefined && input.csv_text !== undefined) throw new InputError('Supply rows or csv_text, not both.');
  const { rows, warnings } = validateRows(typeof input.csv_text === 'string' ? csvRows(input.csv_text) : input.rows);
  const masterId = string(input.master_id, 'master_id', 80, true);
  const master = await db().prepare('SELECT id FROM masters WHERE id = ?').bind(masterId).first();
  if (!master) throw new InputError('Choose an existing private master version.');
  const processingNotes = string(input.processing_notes, 'processing_notes', 24000);
  if (input.source_upload_ids !== undefined && (!Array.isArray(input.source_upload_ids) || input.source_upload_ids.length > 20 || input.source_upload_ids.some(value => typeof value !== 'string' || value.length > 80))) throw new InputError('Invalid source_upload_ids.');
  const sourceIds = (input.source_upload_ids || []) as string[];
  const mailJobId = string(input.mail_job_id, 'mail_job_id', 80);
  if (mailJobId) {
    const job = await mailLease(db(), mailJobId, input.mail_lease_token);
    if ((JSON.parse(job.source_upload_ids) as string[]).some(value => !sourceIds.includes(value))) throw new InputError('Link every attachment from this mail job in source_upload_ids, including any you explain as irrelevant in processing_notes.');
  }
  for (const sourceId of sourceIds) if (!(await db().prepare('SELECT id FROM uploads WHERE id = ?').bind(sourceId).first())) throw new InputError('A source upload does not exist.');
  let list: List; let number = 1; let latestVersionId: string | null = null;
  if (listId) {
    list = await findList(listId);
    const latest = await db().prepare('SELECT id, number FROM versions WHERE shortlist_id = ? ORDER BY number DESC LIMIT 1').bind(listId).first<{ id: string; number: number }>();
    if (!Object.hasOwn(input, 'expected_latest_version_id') || input.expected_latest_version_id !== (latest?.id || null)) throw new InputError('Another version exists. Read the latest versions and retry with expected_latest_version_id.', 409);
    number = (latest?.number || 0) + 1;
    latestVersionId = latest?.id || null;
  } else {
    list = { id: id(), company: string(input.company, 'Company', 120, true), role: string(input.role, 'Role', 180, true), round: string(input.round, 'Round', 80, true), season: string(input.season, 'Season', 40, true), notes: string(input.notes, 'Public notes', 1500), created_at: now(), updated_at: now(), published_version_id: null };
    const duplicate = await db().prepare('SELECT id, deleted_at FROM shortlists WHERE lower(company) = lower(?) AND lower(role) = lower(?) AND lower(round) = lower(?) AND lower(season) = lower(?)').bind(list.company, list.role, list.round, list.season).first<{ id: string; deleted_at: string | null }>();
    if (duplicate) return json({ error: duplicate.deleted_at ? 'This shortlist was deleted. Ask the owner to restore it before creating a new version.' : 'This company, role, round and season already exist. Create a new version instead.', shortlist_id: duplicate.id }, 409);
  }
  if (mailJobId) {
    if ((await mailVersions(mailJobId)).results.some(version => version.shortlist_id === list.id)) throw new InputError('This mail job already has a result for this shortlist. Resume or reuse that result.', 409);
    for (const existingId of new Set([latestVersionId, list.published_version_id].filter((value): value is string => !!value))) {
      const existing = await findVersion(existingId, list.id);
      if (sameShortlistRows(rows, await versionRows(existing))) return json({ error: 'This shortlist already has the same six-column result. Verify the event and reuse the published version through the mail job reuse endpoint; do not create another version.', duplicate: true, shortlist_id: list.id, version_id: existing.id, published: existing.id === list.published_version_id }, 409);
    }
  }
  const versionId = id(), createdAt = now(), key = `shortlists/${list.id}/${versionId}.json`;
  await bucket().put(key, JSON.stringify(rows), { httpMetadata: { contentType: 'application/json' } });
  try {
    const statements = [];
    if (!listId) statements.push(db().prepare('INSERT INTO shortlists (id, company, role, round, season, notes, created_at, updated_at, published_version_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)').bind(list.id, list.company, list.role, list.round, list.season, list.notes, list.created_at, list.updated_at));
    statements.push(db().prepare('INSERT INTO versions (id, shortlist_id, number, object_key, row_count, master_id, created_at, created_by, processing_notes, warnings, source_upload_ids, published_at, source_mail_job_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)').bind(versionId, list.id, number, key, rows.length, masterId, createdAt, user.id, processingNotes, JSON.stringify(warnings), JSON.stringify(sourceIds), mailJobId || null));
    statements.push(db().prepare('UPDATE shortlists SET updated_at = ? WHERE id = ?').bind(createdAt, list.id));
    await db().batch(statements);
  } catch (error) {
    await bucket().delete(key);
    if (String(error).includes('UNIQUE')) throw new InputError('Another draft was created in parallel. Refresh versions and retry.', 409);
    throw error;
  }
  await log('draft_created', user.id, versionId);
  return json({ shortlist_id: list.id, version_id: versionId, number, row_count: rows.length, warnings, published: false, expected_current_version_id: list.published_version_id, public_url: `${new URL(request.url).origin}/?list=${list.id}` }, 201);
}

async function publish(request: Request, listId: string, restore = false) {
  const user = await access(request, restore); const input = await body(request); const list = await findList(listId);
  const version = await findVersion(string(input.version_id, 'version_id', 80, true), listId);
  if (version.source_mail_job_id && user.role !== 'admin') await mailLease(db(), version.source_mail_job_id, input.mail_lease_token);
  if (!Object.hasOwn(input, 'expected_current_version_id') || input.expected_current_version_id !== list.published_version_id) throw new InputError('The published version changed. Refresh before publishing.', 409);
  if (restore && !version.published_at) throw new InputError('Restore an already-published version.');
  const warnings = JSON.parse(version.warnings);
  if (warnings.length && input.acknowledge_warnings !== true) throw new InputError('Review the draft warnings and set acknowledge_warnings to true before publication.');
  const time = now();
  const [changed] = await db().batch([
    db().prepare('UPDATE shortlists SET published_version_id = ?, updated_at = ? WHERE id = ? AND published_version_id IS ? AND deleted_at IS NULL').bind(version.id, time, listId, list.published_version_id),
    db().prepare('UPDATE versions SET published_at = coalesce(published_at, ?) WHERE id = ? AND EXISTS (SELECT 1 FROM shortlists WHERE id = ? AND published_version_id = ?)').bind(time, version.id, listId, version.id),
  ]);
  if (changed.meta.changes !== 1) throw new InputError('Another publisher changed this shortlist. Refresh and retry.', 409);
  await log(restore ? 'version_restored' : 'version_published', user.id, version.id);
  return json({ shortlist_id: listId, version_id: version.id, published: true, public_url: `${new URL(request.url).origin}/?list=${listId}`, row_count: version.row_count });
}

async function deleteShortlist(request: Request, listId: string, restore = false) {
  const owner = await access(request, true), input = await body(request);
  const expected = string(input.expected_updated_at, 'expected_updated_at', 80, true);
  const list = await db().prepare('SELECT id, updated_at, deleted_at FROM shortlists WHERE id = ?').bind(listId).first<{ id: string; updated_at: string; deleted_at: string | null }>();
  if (!list) throw new InputError('Shortlist not found.', 404);
  if (restore ? !list.deleted_at : !!list.deleted_at) throw new InputError(restore ? 'This shortlist has already been restored.' : 'This shortlist has already been deleted.', 409);
  const time = now();
  const result = await db().prepare(`UPDATE shortlists SET deleted_at = ?, deleted_by = ?, updated_at = ? WHERE id = ? AND updated_at = ? AND deleted_at IS ${restore ? 'NOT NULL' : 'NULL'}`)
    .bind(restore ? null : time, restore ? null : owner.id, time, listId, expected).run();
  if (result.meta.changes !== 1) throw new InputError('This shortlist changed. Refresh and review it before trying again.', 409);
  await log(restore ? 'shortlist_restored' : 'shortlist_deleted', owner.id, listId);
  return json({ shortlist_id: listId, deleted: !restore, updated_at: time });
}

export async function handle(request: Request): Promise<Response> {
  try {
    assertMutationOrigin(request);
    const url = new URL(request.url), method = request.method;
    const parts = url.pathname.replace(/^\/api\/v1\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    if (parts.length > 3) throw new InputError('Endpoint not found.', 404);
    const [resource, item, action] = parts;
    if (method === 'GET' && resource === 'health') return json({ status: 'ok', service: 'shortlist-desk', version: 1, merging: 'external-agent' });
    if (method === 'GET' && resource === 'agent') return plain(agentGuide(url.origin), 'text/markdown; charset=utf-8');
    if (method === 'GET' && resource === 'mail-agent') return plain(mailGuide(url.origin), 'text/markdown; charset=utf-8');
    if (method === 'GET' && resource === 'openapi.json') return json(openapi(url.origin));
    if (method === 'GET' && resource === 'me') {
      const user = await actor(request);
      return json({ role: user?.role || 'public', label: user?.label || null, owner_configured: /^[a-f0-9]{64}$/.test(env.ADMIN_KEY_SHA256 || '') });
    }
    if (resource === 'session' && method === 'POST') {
      const input = await body(request), token = string(input.key, 'Access key', 100, true); const user = await keyActor(token);
      if (!user) throw new InputError('Invalid, expired or revoked access key.', 401);
      const secure = url.protocol === 'https:' ? '; Secure' : '';
      return json({ role: user.role, label: user.label }, 200, { 'Set-Cookie': `shortlist_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${secure}` });
    }
    if (resource === 'session' && method === 'DELETE') return json({ ok: true }, 200, { 'Set-Cookie': `shortlist_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${url.protocol === 'https:' ? '; Secure' : ''}` });
    if (resource === 'mail') {
      const user = await access(request);
      if (method === 'GET' && item === 'status') return json(await mailStatus(db(), env, user.role === 'admin'));
      if (method === 'PUT' && item === 'config') {
        await access(request, true);
        if (await db().prepare('SELECT account_id FROM mail_state WHERE lock_until > ? LIMIT 1').bind(now()).first()) throw new InputError('Wait for the current mail sync to finish before changing settings.', 409);
        const config = validateMailConfig(await body(request));
        await db().batch([
          db().prepare("INSERT INTO settings (key, value) VALUES ('mail_config', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify(config)),
          db().prepare('UPDATE mail_state SET last_uid = 0, uid_validity = NULL WHERE lock_until IS NULL OR lock_until < ?').bind(now()),
        ]);
        await log('mail_configured', user.id, 'mail'); return json({ config });
      }
      if (method === 'POST' && item === 'sync') { const result = await syncMail(db(), env); await log('mail_synced', user.id, 'mail'); return json(result); }
      if (method === 'POST' && item === 'import') {
        await access(request, true);
        if (!request.headers.get('Content-Type')?.startsWith('message/rfc822')) throw new InputError('Send an EML message as message/rfc822.');
        const raw = await limited(request, 10 * 1024 * 1024); if (!raw.length) throw new InputError('The message is empty.');
        const result = await saveMail(db(), raw, { account: 'owner-import', validity: 'manual', uid: 0, config: await mailConfig(db()) });
        await log('mail_imported', user.id, 'mail'); return json(result, 201);
      }
      throw new InputError('Mail endpoint not found.', 404);
    }
    if (resource === 'mail-jobs') {
      const user = await access(request);
      const fields = 'id, subject, sender, received_at, status, note, duplicate_of, lease_until, result_version_ids, created_at, updated_at';
      if (method === 'GET' && !item) {
        const status = url.searchParams.get('status') || 'pending';
        if (!['pending', 'processing', 'needs_review', 'done', 'ignored', 'all'].includes(status)) throw new InputError('Invalid mail job status.');
        const limit = Math.floor(Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20)));
        const where = status === 'all' ? '' : status === 'pending' ? "WHERE status = 'pending' OR (status = 'processing' AND lease_until <= ?)" : 'WHERE status = ?';
        const query = db().prepare(`SELECT ${fields} FROM mail_jobs ${where} ORDER BY coalesce(received_at, created_at) DESC, created_at DESC, id DESC LIMIT ?`);
        const result = await (status === 'all' ? query.bind(limit) : query.bind(status === 'pending' ? now() : status, limit)).all();
        return json({ jobs: result.results.map(row => ({ ...row, result_version_ids: JSON.parse(row.result_version_ids as string) })), limit });
      }
      if (method === 'GET' && item && !action) {
        const job = await db().prepare(`SELECT ${fields}, object_key, source_upload_ids FROM mail_jobs WHERE id = ?`).bind(item).first<Record<string, unknown>>();
        if (!job) throw new InputError('Mail job not found.', 404);
        const object = await bucket().get(job.object_key as string); if (!object) throw new InputError('Mail source is unavailable.', 503);
        const versions = await mailVersions(item);
        const { object_key: _key, ...metadata } = job;
        return json({ job: { ...metadata, result_version_ids: JSON.parse(job.result_version_ids as string), source_upload_ids: JSON.parse(job.source_upload_ids as string) }, source: await object.json(), versions: versions.results });
      }
      if (method === 'POST' && item && action === 'claim') {
        const token = id(), time = now(), until = new Date(Date.now() + 7200000).toISOString();
        const result = await db().prepare("UPDATE mail_jobs SET status = 'processing', claimed_by = ?, lease_hash = ?, lease_until = ?, updated_at = ? WHERE id = ? AND (status = 'pending' OR (status = 'processing' AND lease_until <= ?))").bind(user.id, await mailHash(token), until, time, item, time).run();
        if (result.meta.changes !== 1) throw new InputError('Job is already claimed, finished or awaiting review. Refresh the queue.', 409);
        await log('mail_job_claimed', user.id, item); return json({ id: item, lease_token: token, lease_until: until });
      }
      if (method === 'POST' && item && action === 'reuse') {
        const input = await body(request); await mailLease(db(), item, input.lease_token);
        const note = string(input.note, 'Duplicate event and candidate evidence', 24000, true);
        const list = await findList(string(input.shortlist_id, 'shortlist_id', 80, true));
        const version = await findVersion(string(input.version_id, 'version_id', 80, true), list.id);
        if (!version.published_at || version.id !== list.published_version_id) throw new InputError('Only the current published version can be reused. Review a draft or changed result instead.', 409);
        const linked = (await mailVersions(item)).results;
        if (linked.some(value => value.shortlist_id === list.id && value.id !== version.id)) throw new InputError('This job already has a different result for that shortlist. Review the conflict.', 409);
        const job = await db().prepare('SELECT result_version_ids FROM mail_jobs WHERE id = ?').bind(item).first<{ result_version_ids: string }>();
        const ids = [...new Set([...(JSON.parse(job!.result_version_ids) as string[]), version.id])];
        const result = await db().prepare("UPDATE mail_jobs SET result_version_ids = ?, note = ?, updated_at = ? WHERE id = ? AND status = 'processing' AND lease_hash = ? AND lease_until > ? AND result_version_ids = ? AND EXISTS (SELECT 1 FROM shortlists WHERE id = ? AND published_version_id = ? AND deleted_at IS NULL) AND NOT EXISTS (SELECT 1 FROM versions WHERE source_mail_job_id = ? AND shortlist_id = ? AND id != ?)")
          .bind(JSON.stringify(ids), note, now(), item, await mailHash(input.lease_token as string), now(), job!.result_version_ids, list.id, version.id, item, list.id, version.id).run();
        if (result.meta.changes !== 1) throw new InputError('The job or published result changed. Refresh before reusing it.', 409);
        await log('mail_result_reused', user.id, item);
        return json({ id: item, reused: true, shortlist_id: list.id, version_id: version.id, public_url: `${url.origin}/?list=${list.id}` });
      }
      if (method === 'POST' && item && ['complete', 'review', 'ignore'].includes(action)) {
        const input = await body(request); await mailLease(db(), item, input.lease_token);
        const note = string(input.note, 'Processing note', 24000, action !== 'complete');
        const versions = await mailVersions(item);
        if (action === 'complete' && (!versions.results.length || versions.results.some(version => !version.published_at || version.deleted_at || version.published_version_id !== version.id))) throw new InputError('Every draft linked to this mail job must be the current public version before completion. Otherwise mark the job for review.');
        if (action === 'ignore' && versions.results.length) throw new InputError('This mail job already has draft or published results. Mark it for review instead.');
        const status = action === 'complete' ? 'done' : action === 'review' ? 'needs_review' : 'ignored';
        const result = await db().prepare("UPDATE mail_jobs SET status = ?, note = ?, result_version_ids = ?, lease_hash = NULL, lease_until = NULL, claimed_by = NULL, updated_at = ? WHERE id = ? AND status = 'processing' AND lease_hash = ? AND lease_until > ?").bind(status, note, JSON.stringify(versions.results.filter(version => version.published_at).map(version => version.id)), now(), item, await mailHash(input.lease_token as string), now()).run();
        if (result.meta.changes !== 1) throw new InputError('The job lease changed. Refresh before retrying.', 409);
        await log('mail_job_' + status, user.id, item); return json({ id: item, status });
      }
      if (method === 'POST' && item && action === 'retry') {
        await access(request, true);
        const result = await db().prepare("UPDATE mail_jobs SET status = 'pending', lease_hash = NULL, lease_until = NULL, claimed_by = NULL, updated_at = ? WHERE id = ? AND status IN ('needs_review','ignored')").bind(now(), item).run();
        if (result.meta.changes !== 1) throw new InputError('Only a reviewed or ignored job can be retried.', 409);
        await log('mail_job_retried', user.id, item); return json({ id: item, status: 'pending' });
      }
      throw new InputError('Mail job endpoint not found.', 404);
    }
    if (resource === 'master' && method === 'PUT') return await writeMaster(request);
    if ((resource === 'master' || resource === 'master.csv') && method === 'GET') {
      await access(request); const master = await currentMaster(); if (!master) throw new InputError('No master has been imported yet.', 404);
      const { object_key: _key, ...metadata } = master;
      if (item === 'info') return json(metadata);
      if (item === 'versions') return json({ versions: (await db().prepare('SELECT id, name, row_count, cpi_count, created_at, source_hash FROM masters ORDER BY created_at DESC').all()).results });
      const rows = await masterRows(master);
      if (resource === 'master.csv') return plain(toCSV(rows), 'text/csv; charset=utf-8', { 'Content-Disposition': 'attachment; filename="iitk-student-master.csv"' });
      return json({ ...metadata, columns: COLUMNS, rows });
    }
    if (resource === 'keys') {
      const user = await access(request, true);
      if (method === 'GET') return json({ keys: (await db().prepare('SELECT id, label, created_at, expires_at, revoked_at FROM access_keys ORDER BY created_at DESC').all()).results });
      if (method === 'POST' && !item) {
        const input = await body(request); const label = string(input.label, 'Key label', 100, true);
        const days = Number(input.expires_in_days ?? 30); if (![1, 7, 30, 90].includes(days)) throw new InputError('Choose an expiry of 1, 7, 30 or 90 days.');
        const bytes = crypto.getRandomValues(new Uint8Array(32)); const token = 'upl_' + btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
        const keyId = id(), createdAt = now(), expiresAt = new Date(Date.now() + days * 86400000).toISOString();
        await db().prepare('INSERT INTO access_keys (id, token_hash, label, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)').bind(keyId, await sha256(token), label, createdAt, expiresAt).run();
        await log('key_created', user.id, keyId); return json({ id: keyId, label, key: token, expires_at: expiresAt, message: 'Shown once. Store this key securely; it is not available again.' }, 201);
      }
      if (method === 'DELETE' && item) { const result = await db().prepare('UPDATE access_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').bind(now(), item).run(); if (!result.meta.changes) throw new InputError('Active key not found.', 404); await log('key_revoked', user.id, item); return json({ revoked: true }); }
    }
    if (resource === 'uploads') {
      const user = await access(request);
      if (method === 'GET' && !item) return json({ uploads: (await db().prepare('SELECT id, filename, size, content_type, created_at FROM uploads ORDER BY created_at DESC LIMIT 100').all()).results });
      if (method === 'GET' && item) {
        const file = await db().prepare('SELECT * FROM uploads WHERE id = ?').bind(item).first<{ object_key: string; filename: string; content_type: string }>();
        if (!file) throw new InputError('Upload not found.', 404); const object = await bucket().get(file.object_key); if (!object) throw new InputError('File unavailable.', 404);
        return new Response(object.body, { headers: { ...responseHeaders, 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}` } });
      }
      if (method === 'POST' && !item) {
        const raw = await limited(request, 11 * 1024 * 1024);
        let form; try { form = await new Request(request.url, { method: 'POST', headers: { 'Content-Type': request.headers.get('Content-Type') || '' }, body: raw.buffer as ArrayBuffer }).formData(); } catch { throw new InputError('Use multipart/form-data with a file field named file.'); }
        const file = form.get('file'); if (!file || typeof file === 'string') throw new InputError('Upload a file in the file field.');
        if (file.size > 10 * 1024 * 1024 || !file.size || !/\.(xlsx?|csv|tsv|json)$/i.test(file.name)) throw new InputError('Use a non-empty XLSX, XLS, CSV, TSV or JSON file up to 10 MB.');
        const uploadId = id(), filename = file.name.replace(/[\r\n\x00]/g, '').slice(0, 240), key = `inputs/${uploadId}`;
        await bucket().put(key, await file.arrayBuffer(), { httpMetadata: { contentType: 'application/octet-stream' } });
        await db().prepare('INSERT INTO uploads (id, filename, object_key, size, content_type, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(uploadId, filename, key, file.size, file.type || 'application/octet-stream', now(), user.id).run();
        await log('input_uploaded', user.id, uploadId); return json({ id: uploadId, filename, size: file.size, private: true, download_url: `${url.origin}/api/v1/uploads/${uploadId}` }, 201);
      }
    }
    if (resource === 'shortlists') {
      if (method === 'GET' && item === 'deleted' && !action) {
        await access(request, true);
        const result = await db().prepare('SELECT s.*, v.row_count, v.number AS version_number, (SELECT count(*) FROM versions WHERE shortlist_id = s.id) AS version_count FROM shortlists s LEFT JOIN versions v ON v.id = s.published_version_id WHERE s.deleted_at IS NOT NULL ORDER BY s.deleted_at DESC').all();
        return json({ shortlists: result.results });
      }
      if (method === 'GET' && !item) {
        const drafts = url.searchParams.get('include_drafts') === '1'; if (drafts) await access(request);
        const result = await db().prepare(`SELECT s.*, v.row_count, v.number AS version_number, v.published_at, (SELECT count(*) FROM versions WHERE shortlist_id = s.id) AS version_count FROM shortlists s LEFT JOIN versions v ON v.id = s.published_version_id WHERE s.deleted_at IS NULL ${drafts ? '' : 'AND s.published_version_id IS NOT NULL'} ORDER BY s.updated_at DESC`).all();
        return json({ shortlists: result.results });
      }
      if (method === 'DELETE' && item && !action) return await deleteShortlist(request, item);
      if (method === 'POST' && item && action === 'undelete') return await deleteShortlist(request, item, true);
      if (method === 'POST' && !item) return await createDraft(request);
      if (method === 'POST' && action === 'versions') return await createDraft(request, item);
      if (method === 'POST' && action === 'publish') return await publish(request, item);
      if (method === 'POST' && action === 'restore') return await publish(request, item, true);
      if (method === 'GET' && item) {
        const list = await findList(item);
        if (action === 'versions') {
          await access(request); const result = await db().prepare('SELECT * FROM versions WHERE shortlist_id = ? ORDER BY number DESC').bind(item).all<Version>();
          return json({ shortlist: list, versions: result.results.map(({ object_key: _key, ...version }) => ({ ...version, warnings: JSON.parse(version.warnings), source_upload_ids: JSON.parse(version.source_upload_ids) })) });
        }
        if (action && action !== 'export.csv') throw new InputError('Endpoint not found.', 404);
        let versionId = list.published_version_id;
        if (url.searchParams.has('version_id')) { await access(request); versionId = url.searchParams.get('version_id'); }
        if (!versionId) throw new InputError('This shortlist has not been published.', 404);
        const version = await findVersion(versionId, item), rows = await versionRows(version);
        if (action === 'export.csv') return plain(toCSV(rows), 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="${list.company.replace(/[^a-zA-Z0-9_-]/g, '_')}_shortlist.csv"` });
        return json({ shortlist: list, version: publicVersion(version), columns: COLUMNS, rows });
      }
    }
    throw new InputError('Endpoint not found. See /api/v1/openapi.json.', 404);
  } catch (error) {
    if (error instanceof InputError) return json({ error: error.message }, error.status);
    console.error('Portal request failed:', error instanceof Error ? error.name : 'UnknownError');
    return json({ error: 'The operation could not be completed. Please retry; existing versions are preserved.' }, 500);
  }
}

function openapi(origin: string) {
  const secured = [{ UploaderKey: [] }];
  const ownerOnly = [{ OwnerKey: [] }];
  const student = { type: 'object', additionalProperties: false, required: COLUMNS, properties: Object.fromEntries(COLUMNS.map(key => [key, key === 'cpi' ? { type: ['number', 'null'], minimum: 0, maximum: 10 } : { type: 'string' }])) };
  const response = { '200': { description: 'Success' }, '400': { description: 'Invalid input' }, '401': { description: 'Access key or owner session required' }, '403': { description: 'Owner access required' }, '404': { description: 'Not found or deleted' }, '409': { description: 'Concurrent update or duplicate shortlist' } };
  const draft = { type: 'object', properties: { company: { type: 'string' }, role: { type: 'string' }, round: { type: 'string' }, season: { type: 'string' }, master_id: { type: 'string' }, rows: { type: 'array', items: student }, csv_text: { type: 'string' }, processing_notes: { type: 'string' }, source_upload_ids: { type: 'array', items: { type: 'string' } }, expected_latest_version_id: { type: ['string', 'null'] }, mail_job_id: { type: 'string' }, mail_lease_token: { type: 'string' } }, required: ['master_id'] };
  const bodySchema = (schema: unknown) => ({ required: true, content: { 'application/json': { schema } } });
  const parameter = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
  const deleteBody = bodySchema({ type: 'object', required: ['expected_updated_at'], properties: { expected_updated_at: { type: 'string', description: 'updated_at from the latest shortlist metadata, to reject stale changes.' } } });
  const mailAction = bodySchema({ type: 'object', required: ['lease_token'], properties: { lease_token: { type: 'string' }, note: { type: 'string' } } });
  return { openapi: '3.1.0', info: { title: 'Shortlist Desk', version: '1.0.0', description: 'Gemini performs interpretation and merging. The portal validates, stores and publishes exact six-column results.' }, servers: [{ url: origin + '/api/v1' }], components: { securitySchemes: { UploaderKey: { type: 'http', scheme: 'bearer', description: 'Revocable uploader key issued by the owner.' }, OwnerKey: { type: 'http', scheme: 'bearer', description: 'Private owner key. Uploader keys cannot delete or restore shortlists.' } }, schemas: { Student: student } }, paths: {
    '/health': { get: { operationId: 'health', summary: 'Health check', responses: response } },
    '/mail-agent': { get: { operationId: 'mailAgentGuide', summary: 'Public workflow instructions without mailbox data', responses: response } },
    '/mail/status': { get: { operationId: 'mailStatus', summary: 'Private mailbox connection state and configuration; never returns the password', security: secured, responses: response } },
    '/mail/config': { put: { operationId: 'configureMail', summary: 'Owner only: mailbox folder, lookback, sender and link-domain rules', security: ownerOnly, requestBody: bodySchema({ type: 'object', required: ['enabled','folder','lookback_days','senders','link_domains'], properties: { enabled: { type: 'boolean' }, folder: { type: 'string' }, lookback_days: { type: 'integer', minimum: 1, maximum: 365 }, senders: { type: 'array', items: { type: 'string' } }, link_domains: { type: 'array', items: { type: 'string' } } } }), responses: response } },
    '/mail/sync': { post: { operationId: 'syncMail', summary: 'Read matching mail into a private queue; repeat while more is true', security: secured, responses: { ...response, '502': { description: 'IITK IMAP sync failed' }, '503': { description: 'Mail credentials have not been configured' } } } },
    '/mail/import': { post: { operationId: 'importOwnMail', summary: 'Owner only: import an owned EML message for testing or manual ingestion', security: ownerOnly, requestBody: { required: true, content: { 'message/rfc822': { schema: { type: 'string', format: 'binary' } } } }, responses: { ...response, '201': { description: 'Queued, duplicate or sender/keyword-filtered message' } } } },
    '/mail-jobs': { get: { operationId: 'listMailJobs', summary: 'Private queue, newest received first; pending includes expired job claims', security: secured, parameters: [{ name: 'status', in: 'query', schema: { type: 'string', enum: ['pending','processing','needs_review','done','ignored','all'], default: 'pending' } }, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50 } }], responses: response } },
    '/mail-jobs/{id}': { parameters: [parameter], get: { operationId: 'readMailJob', summary: 'Private email text, attachments, links and previously prepared results', security: secured, responses: response } },
    '/mail-jobs/{id}/claim': { parameters: [parameter], post: { operationId: 'claimMailJob', summary: 'Exclusively claim a pending/expired job for two hours; returns lease_token once', security: secured, responses: response } },
    '/mail-jobs/{id}/reuse': { parameters: [parameter], post: { operationId: 'reuseMailResult', summary: 'Reuse the current published result for a verified duplicate event/candidate list without another draft', security: secured, requestBody: bodySchema({ type: 'object', required: ['lease_token','shortlist_id','version_id','note'], properties: { lease_token: { type: 'string' }, shortlist_id: { type: 'string' }, version_id: { type: 'string' }, note: { type: 'string', description: 'Explain matching company, role, round, event date/time and candidate evidence.' } } }), responses: response } },
    '/mail-jobs/{id}/complete': { parameters: [parameter], post: { operationId: 'completeMailJob', summary: 'Complete a claimed job after every linked result is currently published', security: secured, requestBody: mailAction, responses: response } },
    '/mail-jobs/{id}/review': { parameters: [parameter], post: { operationId: 'reviewMailJob', summary: 'Leave an unresolved job for owner review; note is required', security: secured, requestBody: mailAction, responses: response } },
    '/mail-jobs/{id}/ignore': { parameters: [parameter], post: { operationId: 'ignoreMailJob', summary: 'Ignore an irrelevant claimed email with an explanation', security: secured, requestBody: mailAction, responses: response } },
    '/mail-jobs/{id}/retry': { parameters: [parameter], post: { operationId: 'retryMailJob', summary: 'Owner only: requeue a reviewed/ignored source', security: ownerOnly, responses: response } },
    '/shortlists': { get: { operationId: 'listShortlists', summary: 'List published shortlists', parameters: [{ name: 'include_drafts', in: 'query', schema: { type: 'integer', enum: [1] }, description: 'Requires authentication when set.' }], responses: response }, post: { operationId: 'createShortlistDraft', summary: 'Create a shortlist and its first draft', security: secured, requestBody: bodySchema(draft), responses: { ...response, '201': { description: 'Draft created; not public until published' } } } },
    '/shortlists/{id}': { parameters: [parameter], get: { operationId: 'readShortlist', summary: 'Read current published six-column rows', responses: response }, delete: { operationId: 'deleteShortlist', summary: 'Owner only: hide a shortlist and retain its versions for recovery', security: ownerOnly, requestBody: deleteBody, responses: response } },
    '/shortlists/deleted': { get: { operationId: 'listDeletedShortlists', summary: 'Owner only: list deleted shortlists', security: ownerOnly, responses: response } },
    '/shortlists/{id}/undelete': { parameters: [parameter], post: { operationId: 'undeleteShortlist', summary: 'Owner only: restore a deleted shortlist and its previous publication', security: ownerOnly, requestBody: deleteBody, responses: response } },
    '/shortlists/{id}/export.csv': { parameters: [parameter], get: { operationId: 'downloadShortlist', summary: 'Download published CSV', responses: response } },
    '/shortlists/{id}/versions': { parameters: [parameter], get: { operationId: 'listVersions', security: secured, responses: response }, post: { operationId: 'createVersion', security: secured, requestBody: bodySchema(draft), responses: response } },
    '/shortlists/{id}/publish': { parameters: [parameter], post: { operationId: 'publishVersion', security: secured, requestBody: bodySchema({ type: 'object', required: ['version_id', 'expected_current_version_id'], properties: { version_id: { type: 'string' }, expected_current_version_id: { type: ['string', 'null'] }, acknowledge_warnings: { type: 'boolean' }, mail_lease_token: { type: 'string', description: 'Required for uploader publication of a mail-linked version.' } } }), responses: response } },
    '/master': { get: { operationId: 'readPrivateMaster', security: secured, summary: 'Read current master metadata and rows', responses: response } },
    '/master/info': { get: { operationId: 'readMasterInfo', security: secured, responses: response } },
    '/master.csv': { get: { operationId: 'downloadPrivateMaster', security: secured, responses: response } },
    '/uploads': { get: { operationId: 'listPrivateInputs', security: secured, responses: response }, post: { operationId: 'uploadPrivateInput', security: secured, requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } } } } }, responses: response } },
    '/uploads/{id}': { parameters: [parameter], get: { operationId: 'downloadPrivateInput', security: secured, responses: response } },
  } };
}

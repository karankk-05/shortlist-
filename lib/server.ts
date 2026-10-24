import { env } from 'cloudflare:workers';
import { objectStore } from './object-store';
import { agentGuide } from './agent-guide';
import { COLUMNS, csvRows, InputError, StudentRow, toCSV, validateRows } from './records';

type Actor = { role: 'admin' | 'uploader'; id: string; label: string };
type List = { id: string; company: string; role: string; round: string; season: string; notes: string; published_version_id: string | null; created_at: string; updated_at: string };
type Version = { id: string; shortlist_id: string; number: number; object_key: string; row_count: number; master_id: string; processing_notes: string; warnings: string; source_upload_ids: string; created_at: string; published_at: string | null };
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
  const list = await db().prepare('SELECT * FROM shortlists WHERE id = ?').bind(listId).first<List>();
  if (!list) throw new InputError('Shortlist not found.', 404); return list;
}
async function findVersion(versionId: string, listId: string) {
  const version = await db().prepare('SELECT * FROM versions WHERE id = ? AND shortlist_id = ?').bind(versionId, listId).first<Version>();
  if (!version) throw new InputError('Version not found.', 404); return version;
}
async function versionRows(version: Version) {
  const object = await bucket().get(version.object_key); if (!object) throw new InputError('The shortlist file is temporarily unavailable.', 503); return object.json<StudentRow[]>();
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
  for (const sourceId of sourceIds) if (!(await db().prepare('SELECT id FROM uploads WHERE id = ?').bind(sourceId).first())) throw new InputError('A source upload does not exist.');
  let list: List; let number = 1;
  if (listId) {
    list = await findList(listId);
    const latest = await db().prepare('SELECT id, number FROM versions WHERE shortlist_id = ? ORDER BY number DESC LIMIT 1').bind(listId).first<{ id: string; number: number }>();
    if (!Object.hasOwn(input, 'expected_latest_version_id') || input.expected_latest_version_id !== (latest?.id || null)) throw new InputError('Another version exists. Read the latest versions and retry with expected_latest_version_id.', 409);
    number = (latest?.number || 0) + 1;
  } else {
    list = { id: id(), company: string(input.company, 'Company', 120, true), role: string(input.role, 'Role', 180, true), round: string(input.round, 'Round', 80, true), season: string(input.season, 'Season', 40, true), notes: string(input.notes, 'Public notes', 1500), created_at: now(), updated_at: now(), published_version_id: null };
    const duplicate = await db().prepare('SELECT id FROM shortlists WHERE lower(company) = lower(?) AND lower(role) = lower(?) AND lower(round) = lower(?) AND lower(season) = lower(?)').bind(list.company, list.role, list.round, list.season).first<{ id: string }>();
    if (duplicate) return json({ error: 'This company, role, round and season already exist. Create a new version instead.', shortlist_id: duplicate.id }, 409);
  }
  const versionId = id(), createdAt = now(), key = `shortlists/${list.id}/${versionId}.json`;
  await bucket().put(key, JSON.stringify(rows), { httpMetadata: { contentType: 'application/json' } });
  try {
    const statements = [];
    if (!listId) statements.push(db().prepare('INSERT INTO shortlists (id, company, role, round, season, notes, created_at, updated_at, published_version_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)').bind(list.id, list.company, list.role, list.round, list.season, list.notes, list.created_at, list.updated_at));
    statements.push(db().prepare('INSERT INTO versions (id, shortlist_id, number, object_key, row_count, master_id, created_at, created_by, processing_notes, warnings, source_upload_ids, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)').bind(versionId, list.id, number, key, rows.length, masterId, createdAt, user.id, processingNotes, JSON.stringify(warnings), JSON.stringify(sourceIds)));
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
  if (!Object.hasOwn(input, 'expected_current_version_id') || input.expected_current_version_id !== list.published_version_id) throw new InputError('The published version changed. Refresh before publishing.', 409);
  if (restore && !version.published_at) throw new InputError('Restore an already-published version.');
  const warnings = JSON.parse(version.warnings);
  if (warnings.length && input.acknowledge_warnings !== true) throw new InputError('Review the draft warnings and set acknowledge_warnings to true before publication.');
  const time = now();
  const [changed] = await db().batch([
    db().prepare('UPDATE shortlists SET published_version_id = ?, updated_at = ? WHERE id = ? AND published_version_id IS ?').bind(version.id, time, listId, list.published_version_id),
    db().prepare('UPDATE versions SET published_at = coalesce(published_at, ?) WHERE id = ? AND EXISTS (SELECT 1 FROM shortlists WHERE id = ? AND published_version_id = ?)').bind(time, version.id, listId, version.id),
  ]);
  if (changed.meta.changes !== 1) throw new InputError('Another publisher changed this shortlist. Refresh and retry.', 409);
  await log(restore ? 'version_restored' : 'version_published', user.id, version.id);
  return json({ shortlist_id: listId, version_id: version.id, published: true, public_url: `${new URL(request.url).origin}/?list=${listId}`, row_count: version.row_count });
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
      if (method === 'GET' && !item) {
        const drafts = url.searchParams.get('include_drafts') === '1'; if (drafts) await access(request);
        const result = await db().prepare(`SELECT s.*, v.row_count, v.number AS version_number, v.published_at, (SELECT count(*) FROM versions WHERE shortlist_id = s.id) AS version_count FROM shortlists s LEFT JOIN versions v ON v.id = s.published_version_id ${drafts ? '' : 'WHERE s.published_version_id IS NOT NULL'} ORDER BY s.updated_at DESC`).all();
        return json({ shortlists: result.results });
      }
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
  const student = { type: 'object', additionalProperties: false, required: COLUMNS, properties: Object.fromEntries(COLUMNS.map(key => [key, key === 'cpi' ? { type: ['number', 'null'], minimum: 0, maximum: 10 } : { type: 'string' }])) };
  const response = { '200': { description: 'Success' }, '400': { description: 'Invalid input' }, '401': { description: 'Access key or owner session required' }, '409': { description: 'Concurrent update or duplicate shortlist' } };
  const draft = { type: 'object', properties: { company: { type: 'string' }, role: { type: 'string' }, round: { type: 'string' }, season: { type: 'string' }, master_id: { type: 'string' }, rows: { type: 'array', items: student }, csv_text: { type: 'string' }, processing_notes: { type: 'string' }, source_upload_ids: { type: 'array', items: { type: 'string' } }, expected_latest_version_id: { type: ['string', 'null'] } }, required: ['master_id'] };
  const bodySchema = (schema: unknown) => ({ required: true, content: { 'application/json': { schema } } });
  const parameter = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
  return { openapi: '3.1.0', info: { title: 'Shortlist Desk', version: '1.0.0', description: 'Gemini performs interpretation and merging. The portal validates, stores and publishes exact six-column results.' }, servers: [{ url: origin + '/api/v1' }], components: { securitySchemes: { UploaderKey: { type: 'http', scheme: 'bearer', description: 'Revocable uploader key issued by the owner.' } }, schemas: { Student: student } }, paths: {
    '/health': { get: { operationId: 'health', summary: 'Health check', responses: response } },
    '/shortlists': { get: { operationId: 'listShortlists', summary: 'List published shortlists', parameters: [{ name: 'include_drafts', in: 'query', schema: { type: 'integer', enum: [1] }, description: 'Requires authentication when set.' }], responses: response }, post: { operationId: 'createShortlistDraft', summary: 'Create a shortlist and its first draft', security: secured, requestBody: bodySchema(draft), responses: { ...response, '201': { description: 'Draft created; not public until published' } } } },
    '/shortlists/{id}': { parameters: [parameter], get: { operationId: 'readShortlist', summary: 'Read current published six-column rows', responses: response } },
    '/shortlists/{id}/export.csv': { parameters: [parameter], get: { operationId: 'downloadShortlist', summary: 'Download published CSV', responses: response } },
    '/shortlists/{id}/versions': { parameters: [parameter], get: { operationId: 'listVersions', security: secured, responses: response }, post: { operationId: 'createVersion', security: secured, requestBody: bodySchema(draft), responses: response } },
    '/shortlists/{id}/publish': { parameters: [parameter], post: { operationId: 'publishVersion', security: secured, requestBody: bodySchema({ type: 'object', required: ['version_id', 'expected_current_version_id'], properties: { version_id: { type: 'string' }, expected_current_version_id: { type: ['string', 'null'] }, acknowledge_warnings: { type: 'boolean' } } }), responses: response } },
    '/master': { get: { operationId: 'readPrivateMaster', security: secured, summary: 'Read current master metadata and rows', responses: response } },
    '/master/info': { get: { operationId: 'readMasterInfo', security: secured, responses: response } },
    '/master.csv': { get: { operationId: 'downloadPrivateMaster', security: secured, responses: response } },
    '/uploads': { get: { operationId: 'listPrivateInputs', security: secured, responses: response }, post: { operationId: 'uploadPrivateInput', security: secured, requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } } } } }, responses: response } },
    '/uploads/{id}': { parameters: [parameter], get: { operationId: 'downloadPrivateInput', security: secured, responses: response } },
  } };
}

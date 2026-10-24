import { connect } from 'cloudflare:sockets';
import { objectStore } from './object-store';
import { InputError } from './records';
import { ImapReader, IMAP_HOST, IMAP_PORT, MAX_MAIL_BYTES, MailError } from './imap';
import { DEFAULT_MAIL_CONFIG, hasShortlistKeyword, parseMail, type MailConfig } from './mail-content';
import { MAIL_RETENTION_DAYS } from './mail-retention';

export async function mailHash(value: string | Uint8Array) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))].map(n => n.toString(16).padStart(2, '0')).join('');
}
export async function mailConfig(db: D1Database): Promise<MailConfig> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'mail_config'").first<{ value: string }>();
  return row ? JSON.parse(row.value) : DEFAULT_MAIL_CONFIG;
}
export async function mailStatus(db: D1Database, env: Cloudflare.Env, admin: boolean) {
  const config = await mailConfig(db);
  const account = env.MAIL_USERNAME ? await mailHash(env.MAIL_USERNAME.toLowerCase() + '\n' + config.folder) : null;
  const state = account ? await db.prepare('SELECT last_attempt_at, last_success_at, last_error, lock_until FROM mail_state WHERE account_id = ?').bind(account).first() : null;
  const counts = await db.prepare('SELECT status, count(*) AS count FROM mail_jobs GROUP BY status').all();
  const cleanup = await db.prepare("SELECT value FROM settings WHERE key = 'mail_cleanup_last_run'").first<{ value: string }>();
  return { configured: !!(env.MAIL_USERNAME && env.MAIL_PASSWORD), ...(admin ? { username: env.MAIL_USERNAME || null } : {}), config, state, counts: counts.results, host: IMAP_HOST, port: IMAP_PORT, read_only: true, retention: { days: MAIL_RETENTION_DAYS, status: 'done', check_interval: 'hourly', last_run: cleanup ? JSON.parse(cleanup.value) : null } };
}
type StoredFile = { id: string; filename: string; size: number; content_type: string; inline?: boolean; content_id?: string };
type ExistingMail = { id: string; object_key: string; status: string; note: string; received_at: string | null; updated_at: string; result_version_ids: string };
type MailSaveResult = { queued?: boolean; duplicate?: boolean; filtered?: boolean; updated?: boolean; added_attachments?: number; id?: string; status?: string };
/** Recover newly supported image/TXT sources without duplicating a job or changing in-flight results. */
async function refreshMailFiles(db: D1Database, existing: ExistingMail, parsed: Awaited<ReturnType<typeof parseMail>>, receivedAt?: string, headersOnly = false): Promise<MailSaveResult> {
  let dateUpdated = false;
  if (receivedAt && receivedAt !== existing.received_at) {
    const time = new Date().toISOString();
    const changed = await db.prepare('UPDATE mail_jobs SET received_at = ?, updated_at = ? WHERE id = ? AND received_at IS ? AND updated_at = ?').bind(receivedAt, time, existing.id, existing.received_at, existing.updated_at).run();
    if (changed.meta.changes !== 1) return { duplicate: true };
    existing.received_at = receivedAt; existing.updated_at = time; dateUpdated = true;
  }
  const unchanged = (): MailSaveResult => ({ duplicate: true, ...(dateUpdated ? { updated: true } : {}) });
  if (headersOnly || parsed.truncated || !['pending', 'needs_review'].includes(existing.status) || existing.result_version_ids !== '[]' || existing.status === 'needs_review' && !existing.note.startsWith('Matching source content was seen before.')) return unchanged();
  if (await db.prepare('SELECT id FROM versions WHERE source_mail_job_id = ? LIMIT 1').bind(existing.id).first()) return unchanged();
  const store = objectStore(db), object = await store.get(existing.object_key);
  if (!object) return unchanged();
  const previous = await object.json<{ attachments: StoredFile[]; links: { url: string; allowed: boolean }[]; sent_at?: string | null }>();
  const pool = previous.attachments.slice(), files: StoredFile[] = [], added: { file: StoredFile; key: string }[] = [], keys: string[] = [];
  const sourceKey = `mail/${existing.id}-${crypto.randomUUID()}.json`;
  try {
    for (const attachment of parsed.attachments) {
      if (!attachment.bytes.length) continue;
      const index = pool.findIndex(file => file.filename === attachment.filename && file.size === attachment.bytes.length && file.content_type === attachment.content_type);
      if (index >= 0) { files.push({ ...pool.splice(index, 1)[0], inline: attachment.inline, content_id: attachment.content_id }); continue; }
      const file = { id: crypto.randomUUID(), filename: attachment.filename, size: attachment.bytes.length, content_type: attachment.content_type, inline: attachment.inline, content_id: attachment.content_id };
      const key = `inputs/${file.id}`; await store.put(key, attachment.bytes.slice().buffer); keys.push(key); added.push({ file, key }); files.push(file);
    }
    files.push(...pool);
    if (!added.length && JSON.stringify(previous.links) === JSON.stringify(parsed.links) && (previous.sent_at || null) === parsed.received_at) return unchanged();
    const hashes = await Promise.all(parsed.attachments.map(file => mailHash(file.bytes)));
    const contentHash = await mailHash(JSON.stringify({ files: hashes.sort(), links: parsed.links.map(link => link.url).sort() }));
    const duplicate = await db.prepare('SELECT id FROM mail_jobs WHERE content_hash = ? AND id != ? ORDER BY created_at LIMIT 1').bind(contentHash, existing.id).first<{ id: string }>();
    const note = duplicate ? 'Matching source content was seen before. Check whether this is a repeated announcement or a separate shortlist.' : existing.note.startsWith('Matching source content was seen before.') || added.length && existing.note.startsWith('No supported attachment') ? '' : existing.note;
    const status = existing.status === 'needs_review' ? 'pending' : existing.status;
    await store.put(sourceKey, JSON.stringify({ text: parsed.text, links: parsed.links, attachments: files, sent_at: parsed.received_at })); keys.push(sourceKey);
    const statements = [db.prepare("UPDATE mail_jobs SET object_key = ?, source_upload_ids = ?, content_hash = ?, duplicate_of = ?, status = ?, note = ?, updated_at = ? WHERE id = ? AND updated_at = ? AND status IN ('pending','needs_review') AND result_version_ids = '[]' AND NOT EXISTS (SELECT 1 FROM versions WHERE source_mail_job_id = ?)")
      .bind(sourceKey, JSON.stringify(files.map(file => file.id)), contentHash, duplicate?.id || null, status, note, new Date().toISOString(), existing.id, existing.updated_at, existing.id)];
    for (const { file, key } of added) statements.push(db.prepare("INSERT INTO uploads (id, filename, object_key, size, content_type, created_at, created_by) SELECT ?, ?, ?, ?, ?, ?, 'mail-collector' WHERE EXISTS (SELECT 1 FROM mail_jobs WHERE id = ? AND object_key = ?)")
      .bind(file.id, file.filename, key, file.size, file.content_type, new Date().toISOString(), existing.id, sourceKey));
    const [changed] = await db.batch(statements);
    if (changed.meta.changes !== 1) { for (const key of keys) await store.delete(key); return { duplicate: true }; }
    return { duplicate: true, updated: true, added_attachments: added.length, id: existing.id };
  } catch (error) { for (const key of keys) await store.delete(key); throw error; }
}
export async function saveMail(db: D1Database, raw: Uint8Array, context: { account: string; validity: string; uid: number; config: MailConfig; oversized?: boolean; receivedAt?: string }): Promise<MailSaveResult> {
  let parsed: Awaited<ReturnType<typeof parseMail>>;
  try { parsed = await parseMail(raw, context.config, context.oversized); }
  catch { parsed = { message_id: '', subject: `Unreadable matching email (UID ${context.uid})`, sender: '', received_at: null, text: 'The MIME message could not be parsed. Inspect the original mailbox before processing this item.', links: [], attachments: [], truncated: true }; }
  if (context.config.senders.length && !context.config.senders.includes(parsed.sender)) return { filtered: true };
  // Do not trust raw MIME/server substring matches (URLs, encodings and longer words can match).
  // An incomplete source cannot be safely excluded; keep those candidates for review.
  if (!context.oversized && !parsed.truncated && !hasShortlistKeyword(parsed.subject, parsed.text)) return { filtered: true };
  const rawHash = await mailHash(raw);
  const messageKey = await mailHash(context.account + '\n' + (parsed.message_id || context.validity + ':' + context.uid) + '\n' + rawHash);
  const existing = await db.prepare('SELECT id, object_key, status, note, received_at, updated_at, result_version_ids FROM mail_jobs WHERE message_key = ?').bind(messageKey).first<ExistingMail>();
  if (existing) return refreshMailFiles(db, existing, parsed, context.receivedAt, context.oversized);
  const attachmentHashes = await Promise.all(parsed.attachments.map(file => mailHash(file.bytes)));
  const contentHash = await mailHash(JSON.stringify({ files: attachmentHashes.slice().sort(), links: parsed.links.map(link => link.url).sort() }));
  const comparable = parsed.attachments.length || parsed.links.length;
  const duplicate = comparable ? await db.prepare('SELECT id FROM mail_jobs WHERE content_hash = ? ORDER BY created_at LIMIT 1').bind(contentHash).first<{ id: string }>() : null;
  const jobId = crypto.randomUUID(), time = new Date().toISOString(), key = `mail/${jobId}.json`, store = objectStore(db);
  const sourceIds: string[] = [], keys: string[] = [];
  try {
    const files = [];
    for (const file of parsed.attachments) {
      if (!file.bytes.length) continue;
      const uploadId = crypto.randomUUID(), fileKey = `inputs/${uploadId}`;
      await store.put(fileKey, file.bytes.slice().buffer); keys.push(fileKey); sourceIds.push(uploadId);
      files.push({ id: uploadId, filename: file.filename, size: file.bytes.length, content_type: file.content_type, inline: file.inline, content_id: file.content_id });
    }
    const note = context.oversized ? 'Email exceeds 10 MiB. Only headers were saved; review the original mailbox.' : parsed.truncated ? 'Source exceeds the text, link or attachment count limit. The saved source is incomplete; review the original mailbox.' : duplicate ? 'Matching source content was seen before. Check whether this is a repeated announcement or a separate shortlist.' : !comparable ? 'No supported attachment or HTTPS link was found. Inspect the email text for candidate records.' : '';
    // Shared files/links are only a duplicate hint; the agent verifies event identity itself.
    const status = context.oversized || parsed.truncated ? 'needs_review' : 'pending';
    await store.put(key, JSON.stringify({ text: parsed.text, links: parsed.links, attachments: files, sent_at: parsed.received_at })); keys.push(key);
    await db.batch([
      ...files.map((file, index) => db.prepare('INSERT INTO uploads (id, filename, object_key, size, content_type, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(file.id, file.filename, keys[index], file.size, file.content_type, time, 'mail-collector')),
      db.prepare('INSERT INTO mail_jobs (id, account_id, message_key, message_id, uid, subject, sender, received_at, object_key, source_upload_ids, content_hash, duplicate_of, status, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(jobId, context.account, messageKey, parsed.message_id, context.uid, parsed.subject, parsed.sender, context.receivedAt || parsed.received_at, key, JSON.stringify(sourceIds), contentHash, duplicate?.id || null, status, note, time, time),
    ]);
    return { queued: true, status, id: jobId };
  } catch (error) { for (const objectKey of keys) await store.delete(objectKey); throw error; }
}
export async function syncMail(db: D1Database, env: Cloudflare.Env) {
  if (!env.MAIL_USERNAME || !env.MAIL_PASSWORD) throw new InputError('Mail is not connected. Run npm run setup:mail privately in the project terminal.', 503);
  const config = await mailConfig(db);
  if (!config.enabled) throw new InputError('Mailbox syncing is paused by the owner.', 409);
  const account = await mailHash(env.MAIL_USERNAME.toLowerCase() + '\n' + config.folder), token = crypto.randomUUID(), time = new Date().toISOString();
  const locked = await db.prepare('INSERT INTO mail_state (account_id, lock_token, lock_until, last_attempt_at) VALUES (?, ?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET lock_token = excluded.lock_token, lock_until = excluded.lock_until, last_attempt_at = excluded.last_attempt_at WHERE mail_state.lock_until IS NULL OR mail_state.lock_until < ?').bind(account, token, new Date(Date.now() + 300000).toISOString(), time, time).run();
  if (locked.meta.changes !== 1) throw new InputError('Another mail sync is running. Try again shortly.', 409);
  let client: ImapReader | undefined;
  try {
    const socket = connect({ hostname: IMAP_HOST, port: IMAP_PORT }, { secureTransport: 'on', allowHalfOpen: false });
    client = new ImapReader(socket);
    await client.greeting(); await client.login(env.MAIL_USERNAME, env.MAIL_PASSWORD);
    const mailbox = await client.examine(config.folder);
    const state = await db.prepare('SELECT uid_validity, last_uid FROM mail_state WHERE account_id = ?').bind(account).first<{ uid_validity: string | null; last_uid: number }>();
    let cursor = state?.uid_validity === mailbox.validity ? state.last_uid : 0;
    const since = new Date(Date.now() - config.lookback_days * 86400000);
    const candidates = await client.search(cursor + 1, mailbox.lastUid, since);
    let processed = 0, queued = 0, duplicates = 0, filtered = 0, updated = 0, bytes = 0;
    const started = Date.now();
    for (const uid of candidates) {
      if (processed >= 5 || bytes >= 10 * 1024 * 1024 || Date.now() - started > 25000) break;
      const header = await client.header(uid);
      if (header) {
        const oversized = header.size > MAX_MAIL_BYTES;
        // Check sender before downloading the full body or attachments.
        const metadata = await parseMail(header.bytes, config, true).catch(() => ({ sender: '' }));
        if (config.senders.length && !config.senders.includes(metadata.sender)) filtered++;
        else {
          const raw = oversized ? header.bytes : await client.message(uid);
          if (raw) {
            bytes += raw.length;
            const result = await saveMail(db, raw, { account, validity: mailbox.validity, uid, config, oversized, receivedAt: header.receivedAt });
            if (result.queued) queued++; if (result.duplicate) duplicates++; if (result.filtered) filtered++;
            if ('updated' in result && result.updated) updated++;
          }
        }
      }
      cursor = uid; processed++;
      await db.prepare('UPDATE mail_state SET uid_validity = ?, last_uid = ? WHERE account_id = ? AND lock_token = ?').bind(mailbox.validity, cursor, account, token).run();
    }
    const more = processed < candidates.length;
    if (!more) cursor = Math.max(cursor, mailbox.lastUid);
    await db.prepare('UPDATE mail_state SET uid_validity = ?, last_uid = ?, last_success_at = ?, last_error = NULL WHERE account_id = ? AND lock_token = ?').bind(mailbox.validity, cursor, new Date().toISOString(), account, token).run();
    return { processed, queued, duplicates, filtered, updated, more, read_only: true };
  } catch (error) {
    const code = error instanceof MailError ? error.code : 'sync_failed';
    await db.prepare('UPDATE mail_state SET last_error = ? WHERE account_id = ? AND lock_token = ?').bind(code, account, token).run();
    throw new InputError(`Mail sync failed (${code}). Check the private mail credentials, IITK access and folder. No mailbox messages were modified.`, 502);
  } finally {
    if (client) await client.close().catch(() => {});
    await db.prepare('UPDATE mail_state SET lock_token = NULL, lock_until = NULL WHERE account_id = ? AND lock_token = ?').bind(account, token).run();
  }
}
export async function mailLease(db: D1Database, jobId: string, token: unknown) {
  if (typeof token !== 'string' || token.length > 100) throw new InputError('Provide the active mail job lease_token.', 409);
  const job = await db.prepare("SELECT id, source_upload_ids FROM mail_jobs WHERE id = ? AND status = 'processing' AND lease_hash = ? AND lease_until > ?").bind(jobId, await mailHash(token), new Date().toISOString()).first<{ id: string; source_upload_ids: string }>();
  if (!job) throw new InputError('The mail job lease is missing or expired. Claim the job again before changing it.', 409);
  return job;
}

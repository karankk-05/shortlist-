import { connect } from 'cloudflare:sockets';
import { objectStore } from './object-store';
import { InputError } from './records';
import { ImapReader, IMAP_HOST, IMAP_PORT, MAX_MAIL_BYTES, MailError } from './imap';
import { DEFAULT_MAIL_CONFIG, parseMail, type MailConfig } from './mail-content';

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
  return { configured: !!(env.MAIL_USERNAME && env.MAIL_PASSWORD), ...(admin ? { username: env.MAIL_USERNAME || null } : {}), config, state, counts: counts.results, host: IMAP_HOST, port: IMAP_PORT, read_only: true };
}
export async function saveMail(db: D1Database, raw: Uint8Array, context: { account: string; validity: string; uid: number; config: MailConfig; oversized?: boolean }) {
  let parsed: Awaited<ReturnType<typeof parseMail>>;
  try { parsed = await parseMail(raw, context.config, context.oversized); }
  catch { parsed = { message_id: '', subject: `Unreadable matching email (UID ${context.uid})`, sender: '', received_at: null, text: 'The MIME message could not be parsed. Inspect the original mailbox before processing this item.', links: [], attachments: [], truncated: true }; }
  if (context.config.senders.length && !context.config.senders.includes(parsed.sender)) return { filtered: true };
  const rawHash = await mailHash(raw);
  const messageKey = await mailHash(context.account + '\n' + (parsed.message_id || context.validity + ':' + context.uid) + '\n' + rawHash);
  if (await db.prepare('SELECT id FROM mail_jobs WHERE message_key = ?').bind(messageKey).first()) return { duplicate: true };
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
      files.push({ id: uploadId, filename: file.filename, size: file.bytes.length, content_type: file.content_type });
    }
    const note = context.oversized ? 'Email exceeds 10 MiB. Only headers were saved; review the original mailbox.' : parsed.truncated ? 'Source exceeds the text, link or attachment count limit. The saved source is incomplete; review the original mailbox.' : duplicate ? 'Matching source content was seen before. Check whether this is a repeated announcement or a separate shortlist.' : !comparable ? 'No supported attachment or HTTPS link was found. Inspect the email text for candidate records.' : '';
    const status = context.oversized || parsed.truncated || duplicate ? 'needs_review' : 'pending';
    await store.put(key, JSON.stringify({ text: parsed.text, links: parsed.links, attachments: files })); keys.push(key);
    await db.batch([
      ...files.map((file, index) => db.prepare('INSERT INTO uploads (id, filename, object_key, size, content_type, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(file.id, file.filename, keys[index], file.size, file.content_type, time, 'mail-collector')),
      db.prepare('INSERT INTO mail_jobs (id, account_id, message_key, message_id, uid, subject, sender, received_at, object_key, source_upload_ids, content_hash, duplicate_of, status, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(jobId, context.account, messageKey, parsed.message_id, context.uid, parsed.subject, parsed.sender, parsed.received_at, key, JSON.stringify(sourceIds), contentHash, duplicate?.id || null, status, note, time, time),
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
    let processed = 0, queued = 0, duplicates = 0, filtered = 0, bytes = 0;
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
            const result = await saveMail(db, raw, { account, validity: mailbox.validity, uid, config, oversized });
            if (result.queued) queued++; if (result.duplicate) duplicates++; if (result.filtered) filtered++;
          }
        }
      }
      cursor = uid; processed++;
      await db.prepare('UPDATE mail_state SET uid_validity = ?, last_uid = ? WHERE account_id = ? AND lock_token = ?').bind(mailbox.validity, cursor, account, token).run();
    }
    const more = processed < candidates.length;
    if (!more) cursor = Math.max(cursor, mailbox.lastUid);
    await db.prepare('UPDATE mail_state SET uid_validity = ?, last_uid = ?, last_success_at = ?, last_error = NULL WHERE account_id = ? AND lock_token = ?').bind(mailbox.validity, cursor, new Date().toISOString(), account, token).run();
    return { processed, queued, duplicates, filtered, more, read_only: true };
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

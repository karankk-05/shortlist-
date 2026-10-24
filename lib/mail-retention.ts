export const MAIL_RETENTION_DAYS = 7;
const JOB_LIMIT = 10, FILE_LIMIT = 20;
export function mailRetentionCutoff(at: Date) {
  return new Date(at.getTime() - MAIL_RETENTION_DAYS * 86400000).toISOString();
}

/** Delete only completed mail payloads. Shortlists, versions and masters are never mutated. */
export async function cleanupMail(db: D1Database, at = new Date()) {
  const time = at.toISOString(), cutoff = mailRetentionCutoff(at), token = crypto.randomUUID();
  const lease = JSON.stringify({ token, until: new Date(at.getTime() + 300000).toISOString() });
  const lock = await db.prepare("INSERT INTO settings (key, value) VALUES ('mail_cleanup_lock', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE json_extract(settings.value, '$.until') <= ?")
    .bind(lease, time).run();
  if (lock.meta.changes !== 1) return { skipped: true, reason: 'already_running' };
  const result = { run_at: time, retention_days: MAIL_RETENTION_DAYS, cutoff, jobs_cleaned: 0, attachments_deleted: 0, bytes_deleted: 0, batch_full: false };
  try {
    const jobs = await db.prepare("SELECT id FROM mail_jobs WHERE status = 'done' AND completed_at <= ? AND source_deleted_at IS NULL ORDER BY completed_at, id LIMIT ?")
      .bind(cutoff, JOB_LIMIT).all<{ id: string }>();
    for (const job of jobs.results) {
      // Include superseded source JSON objects left by earlier source refreshes.
      const condition = `status = 'done' AND completed_at <= ? AND source_deleted_at IS NULL`;
      const sourceWhere = `(key = 'mail/' || ? || '.json' OR key GLOB 'mail/' || ? || '-*.json')
        AND NOT EXISTS (SELECT 1 FROM masters WHERE object_key = objects.key)
        AND NOT EXISTS (SELECT 1 FROM versions WHERE object_key = objects.key)
        AND NOT EXISTS (SELECT 1 FROM uploads WHERE object_key = objects.key)
        AND NOT EXISTS (SELECT 1 FROM mail_jobs WHERE id != ? AND object_key = objects.key)`;
      const sources = await db.prepare(`SELECT coalesce(sum(size), 0) AS bytes FROM objects WHERE ${sourceWhere}`)
        .bind(job.id, job.id, job.id).first<{ bytes: number }>();
      const [changed] = await db.batch([
        db.prepare(`UPDATE mail_jobs SET source_deleted_at = ? WHERE id = ? AND ${condition}`).bind(time, job.id, cutoff),
        db.prepare(`DELETE FROM objects WHERE ${sourceWhere} AND EXISTS (SELECT 1 FROM mail_jobs WHERE id = ? AND source_deleted_at = ? AND status = 'done' AND completed_at <= ?)`)
          .bind(job.id, job.id, job.id, job.id, time, cutoff),
      ]);
      if (changed.meta.changes === 1) { result.jobs_cleaned++; result.bytes_deleted += sources?.bytes || 0; }
    }

    // Revisit retained attachments on later runs, after their other users finish.
    const eligibleFile = `u.created_by = 'mail-collector' AND u.purged_at IS NULL AND u.object_key = 'inputs/' || u.id
      AND EXISTS (SELECT 1 FROM mail_jobs j, json_each(j.source_upload_ids) source WHERE source.value = u.id AND j.status = 'done' AND j.completed_at <= ? AND j.source_deleted_at IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM mail_jobs j, json_each(j.source_upload_ids) source WHERE source.value = u.id AND j.source_deleted_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM versions v, json_each(v.source_upload_ids) source WHERE source.value = u.id AND v.published_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM masters WHERE object_key = u.object_key)
      AND NOT EXISTS (SELECT 1 FROM versions WHERE object_key = u.object_key)`;
    const files = await db.prepare(`SELECT u.id, u.object_key, coalesce(o.size, 0) AS bytes FROM uploads u LEFT JOIN objects o ON o.key = u.object_key WHERE ${eligibleFile} ORDER BY u.created_at, u.id LIMIT ?`)
      .bind(cutoff, FILE_LIMIT).all<{ id: string; object_key: string; bytes: number }>();
    for (const file of files.results) {
      const [changed] = await db.batch([
        db.prepare(`UPDATE uploads AS u SET purged_at = ? WHERE u.id = ? AND ${eligibleFile}`).bind(time, file.id, cutoff),
        db.prepare("DELETE FROM objects WHERE key = ? AND EXISTS (SELECT 1 FROM uploads WHERE id = ? AND purged_at = ? AND created_by = 'mail-collector') AND NOT EXISTS (SELECT 1 FROM masters WHERE object_key = objects.key) AND NOT EXISTS (SELECT 1 FROM versions WHERE object_key = objects.key)")
          .bind(file.object_key, file.id, time),
      ]);
      if (changed.meta.changes === 1) { result.attachments_deleted++; result.bytes_deleted += file.bytes; }
    }
    result.batch_full = jobs.results.length === JOB_LIMIT || files.results.length === FILE_LIMIT;
    await db.batch([
      db.prepare("INSERT INTO settings (key, value) VALUES ('mail_cleanup_last_run', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify({ ...result, status: 'ok' })),
      db.prepare("INSERT INTO audit (id, action, actor, target_id, created_at) VALUES (?, 'mail_cleanup_completed', 'retention', 'mail', ?)").bind(crypto.randomUUID(), time),
    ]);
    return result;
  } catch (error) {
    await db.prepare("INSERT INTO settings (key, value) VALUES ('mail_cleanup_last_run', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(JSON.stringify({ ...result, status: 'failed', error: 'cleanup_failed' })).run();
    throw error;
  } finally {
    await db.prepare("DELETE FROM settings WHERE key = 'mail_cleanup_lock' AND json_extract(value, '$.token') = ?").bind(token).run();
  }
}

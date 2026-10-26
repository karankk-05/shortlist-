import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { FREE_LIMITS, quota, summarizeUsage, utcUsageDay } from '../lib/usage.ts';

// Local visual fixture. All metrics and account responses are synthetic.
const root = resolve('dist'), now = Date.now(), day = utcUsageDay(now), owner = '/synthetic-owner';
const rows = Array.from({ length: 24 }, (_, index) => ({ hour: new Date(now - (23 - index) * 3600000).toISOString().slice(0, 13) + ':00:00.000Z', category: index % 2 ? 'shortlist_reads' : 'assets', samples: 100 + index * 13, requests: 1000 + index * 130, duration_ms: 26000 + index * 300, server_errors: 0, client_errors: index % 5 ? 0 : 10, blocked: index % 5 ? 0 : 10, slow: 0 }));
const data = { checked_at: new Date(now).toISOString(), started_at: new Date(now - 86400000).toISOString(), day, sample_rate: .1, retention_days: 31, ...summarizeUsage(rows, now), cloudflare: { connected: true, data: { fetched_at: new Date(now).toISOString(), error: null }, stale: false }, quotas: {
  requests: { ...quota(23520, FREE_LIMITS.worker_requests), source: 'cloudflare', complete: true }, rows_read: quota(382000, FREE_LIMITS.d1_rows_read), rows_written: quota(5120, FREE_LIMITS.d1_rows_written), storage: quota(16700000, FREE_LIMITS.database_bytes), kv_reads: quota(2400, FREE_LIMITS.kv_reads), kv_writes: quota(70, FREE_LIMITS.kv_writes), kv_deletes: quota(20, FREE_LIMITS.kv_deletes), kv_lists: quota(1000, FREE_LIMITS.kv_lists),
} };
const json = (response, value) => { response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1:8792');
  if (url.pathname === '/api/v1/me') return json(response, { role: 'admin', label: 'Synthetic owner', owner_configured: true, owner_entry_path: owner });
  if (url.pathname === '/api/v1/usage') return json(response, data);
  if (url.pathname === '/api/v1/master/info') return json(response, { name: 'Synthetic source', row_count: 1, cpi_count: 1, created_at: new Date(now).toISOString() });
  if (url.pathname.startsWith('/api/')) return json(response, { keys: [], shortlists: [], company_groups: [], round_categories: [] });
  const path = url.pathname === owner || url.pathname === '/' ? '/index.html' : url.pathname;
  const file = resolve(root, '.' + path);
  if (!file.startsWith(root + '/')) { response.writeHead(404); response.end(); return; }
  try {
    let bytes = await readFile(file);
    if (path === '/index.html') bytes = Buffer.from(bytes.toString().replace('<html ', '<html data-owner-entry="true" '));
    response.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[extname(file)] || 'application/octet-stream' }); response.end(bytes);
  } catch { response.writeHead(404); response.end(); }
});
server.listen(8792, '127.0.0.1', () => console.log('Synthetic usage preview: http://127.0.0.1:8792' + owner));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close());

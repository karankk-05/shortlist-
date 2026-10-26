/** Only fixed categories and aggregate numbers are retained. Never store request URLs,
 * query strings, IPs, headers, identities, credentials, or request/response bodies. */
export const SAMPLE_RATE = 0.1;
export const USAGE_RETENTION_DAYS = 31;
export const FREE_LIMITS = { worker_requests: 100_000, d1_rows_read: 5_000_000, d1_rows_written: 100_000, database_bytes: 500_000_000, kv_reads: 100_000, kv_writes: 1_000, kv_deletes: 1_000, kv_lists: 1_000 };
export const CATEGORY_LABELS = {
  pages: 'Pages', assets: 'Scripts, styles & images', shortlist_reads: 'Shortlist views & downloads',
  shortlist_writes: 'Shortlist publishing & edits', mail: 'Mail & queue', agent: 'Agent / MCP',
  auth: 'Sign-in & OAuth', owner: 'Owner & source data', other: 'Other requests',
} as const;
export type UsageCategory = keyof typeof CATEGORY_LABELS;
export type UsageBucket = { hour: string; category: UsageCategory; samples: number; requests: number; client_errors: number; server_errors: number; blocked: number; duration_ms: number; slow: number };

export function requestCategory(request: Request): UsageCategory {
  const { pathname: path } = new URL(request.url);
  if (path === '/mcp' || path.startsWith('/mcp/')) return 'agent';
  if (path.startsWith('/oauth/') || path.startsWith('/.well-known/') || /^\/api\/v1\/(session|me)(\/|$)/.test(path)) return 'auth';
  if (/^\/api\/v1\/shortlists(\/|$)/.test(path)) return ['GET', 'HEAD'].includes(request.method) ? 'shortlist_reads' : 'shortlist_writes';
  if (/^\/api\/v1\/(mail|mail-jobs|queue-status|automation)(\/|$)/.test(path)) return 'mail';
  if (/^\/api\/v1\/(master(?:\.csv)?|uploads|keys|usage)(\/|$)/.test(path) || path.startsWith('/gate/')) return 'owner';
  if (path.startsWith('/api/')) return 'other';
  if (path.startsWith('/assets/') || /\.(?:js|css|png|svg|ico|webp|woff2?)$/i.test(path)) return 'assets';
  return 'pages';
}

export function utcUsageDay(time = Date.now()) {
  const start = new Date(time).toISOString().slice(0, 10) + 'T00:00:00.000Z';
  return { start, reset_at: new Date(Date.parse(start) + 86_400_000).toISOString() };
}
export function quota(used: number | null, limit: number) {
  if (used === null || !Number.isFinite(used) || used < 0) return { used: null, limit, remaining: null, percent: null, status: 'unavailable' as const };
  const percent = used / limit * 100;
  return { used, limit, remaining: Math.max(0, limit - used), percent, status: percent >= 100 ? 'exhausted' as const : percent >= 90 ? 'critical' as const : percent >= 75 ? 'warning' as const : 'normal' as const };
}
export type Quota = ReturnType<typeof quota>;

/** Random sampling bounds monitoring writes to about 10% of HTTP traffic. Logging
 * never blocks a response, and any failure is isolated from the application. */
export async function recordUsage(db: D1Database, request: Request, status: number, duration: number, time = Date.now()) {
  const hour = new Date(time).toISOString().slice(0, 13) + ':00:00.000Z', weight = 1 / SAMPLE_RATE;
  await db.prepare(`INSERT INTO usage_hourly (hour, category, samples, requests, client_errors, server_errors, blocked, duration_ms, slow)
    VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(hour, category) DO UPDATE SET samples = samples + 1, requests = requests + excluded.requests,
      client_errors = client_errors + excluded.client_errors, server_errors = server_errors + excluded.server_errors,
      blocked = blocked + excluded.blocked, duration_ms = duration_ms + excluded.duration_ms, slow = slow + excluded.slow`)
    .bind(hour, requestCategory(request), weight, status >= 400 && status < 500 ? weight : 0, status >= 500 ? weight : 0, [401, 403].includes(status) ? weight : 0, Math.max(0, Math.min(duration, 120_000)) * weight, duration >= 1000 ? weight : 0).run();
}

export function summarizeUsage(rows: UsageBucket[], time = Date.now()) {
  const day = utcUsageDay(time), last24 = new Date(time - 23 * 3_600_000).toISOString().slice(0, 13) + ':00:00.000Z';
  const aggregate = (values: UsageBucket[]) => {
    const total = values.reduce((out, row) => ({ requests: out.requests + row.requests, samples: out.samples + row.samples, client_errors: out.client_errors + row.client_errors, server_errors: out.server_errors + row.server_errors, blocked: out.blocked + row.blocked, duration_ms: out.duration_ms + row.duration_ms, slow: out.slow + row.slow }), { requests: 0, samples: 0, client_errors: 0, server_errors: 0, blocked: 0, duration_ms: 0, slow: 0 });
    return { ...total, average_response_ms: total.requests ? Math.round(total.duration_ms / total.requests) : null };
  };
  const today = rows.filter(row => row.hour >= day.start);
  return { today: aggregate(today), last_24_hours: aggregate(rows.filter(row => row.hour >= last24)),
    categories: Object.entries(CATEGORY_LABELS).map(([key, label]) => ({ key, label, ...aggregate(today.filter(row => row.category === key)) })),
    hourly: Array.from({ length: 24 }, (_, index) => {
      const hour = new Date(time - (23 - index) * 3_600_000).toISOString().slice(0, 13) + ':00:00.000Z';
      return { hour, ...aggregate(rows.filter(row => row.hour === hour)) };
    }),
  };
}

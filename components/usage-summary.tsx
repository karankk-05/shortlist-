import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Activity, LoaderCircle, RefreshCw } from 'lucide-react';
import type { UsageSummary } from '../lib/usage-service';
import type { Quota } from '../lib/usage';

const number = (value: number) => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1 }).format(value);
const time = (value: string) => new Date(value).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true });
async function call(path = '', options?: RequestInit) {
  const response = await fetch('/api/v1/usage' + path, { cache: 'no-store', credentials: 'same-origin', ...options });
  const data: any = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not read usage.');
  return data;
}
function Allowance({ label, value, bytes = false, note }: { label: string; value: Quota; bytes?: boolean; note: string }) {
  const format = (n: number) => bytes ? `${number(n / 1_000_000)} MB` : number(n);
  return <div className={'usage-allowance ' + value.status}>
    <div className="usage-line"><strong>{label}</strong><span>{value.percent === null ? 'Not connected' : `${number(value.percent)}% used`}</span></div>
    <div className="usage-meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={value.limit} aria-valuenow={value.used === null ? undefined : Math.min(value.limit, value.used)} aria-valuetext={value.used === null ? 'Usage unavailable' : `${format(value.used)} of ${format(value.limit)} used`}><span style={{ width: `${Math.min(100, value.percent || 0)}%` }} /></div>
    <div className="usage-line"><span>{value.used === null ? 'Usage unavailable' : `${format(value.used)} / ${format(value.limit)}`}</span><strong>{value.remaining === null ? '— remaining' : `${format(value.remaining)} remaining`}</strong></div>
    <small>{note}</small>
  </div>;
}

export default function UsagePanel() {
  const [data, setData] = useState<UsageSummary | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [token, setToken] = useState(''), [saving, setSaving] = useState(false), [message, setMessage] = useState('');
  const reload = useCallback(async () => {
    setBusy(true); setError('');
    try { setData(await call()); } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  async function connect(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError(''); setMessage('');
    try {
      await call('/cloudflare', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: token.trim() }) });
      setToken(''); setMessage('Read-only analytics connected.'); await reload();
    } catch (error) { setError((error as Error).message); }
    finally { setSaving(false); }
  }
  async function disconnect() {
    setSaving(true); setError('');
    try { await call('/cloudflare', { method: 'DELETE' }); setMessage('Cloudflare connection removed. Local estimates continue.'); await reload(); }
    catch (error) { setError((error as Error).message); }
    finally { setSaving(false); }
  }
  const requests = data?.quotas.requests, provider = data?.cloudflare;
  const warnings = data ? Object.entries(data.quotas).filter(([, value]) => ['warning', 'critical', 'exhausted'].includes(value.status)) : [];
  const maxHour = data ? Math.max(1, ...data.hourly.map(hour => hour.requests)) : 1;
  return <section className="panel usage-panel" aria-label="Server usage">
    <div className="panel-top"><div><h2><Activity size={16} />Traffic & server usage <span className="badge">Owner only</span></h2><p className="panel-subtitle">Summary only · Free-plan allowances · No individual request logs</p></div><button className="secondary" disabled={busy || saving} onClick={() => void reload()}>{busy ? <LoaderCircle size={13} className="spinner" /> : <RefreshCw size={13} />}Refresh</button></div>
    {error && <p className="notice error" role="alert">{error}</p>}{message && <p className="notice success" role="status">{message}</p>}
    {!data ? <div className="loading">{busy ? <><LoaderCircle size={15} className="spinner" />Loading usage…</> : 'Usage unavailable. Try Refresh.'}</div> : <>
      <div className="usage-cards">
        <div><small>Requests today{requests?.source === 'estimate' ? ' · estimated' : ' · account-wide'}</small><strong>{requests?.used == null ? '—' : (requests.source === 'estimate' ? '≈ ' : '') + number(requests.used)}</strong><span>{requests?.remaining == null ? 'Waiting for traffic samples' : `${requests.source === 'estimate' ? '≈ ' : ''}${number(requests.remaining)} left today`}</span></div>
        <div><small>Site requests · last 24 hours</small><strong>{data.last_24_hours.samples ? '≈ ' + number(data.last_24_hours.requests) : '—'}</strong><span>{data.last_24_hours.samples} requests sampled</span></div>
        <div><small>Server errors · last 24 hours</small><strong>{data.last_24_hours.samples ? '≈ ' + number(data.last_24_hours.server_errors) : '—'}</strong><span>{data.last_24_hours.samples ? `≈ ${number(data.last_24_hours.requests ? data.last_24_hours.server_errors / data.last_24_hours.requests * 100 : 0)}% of sampled traffic` : 'Waiting for traffic samples'}</span></div>
        <div><small>Average response · sampled</small><strong>{data.last_24_hours.average_response_ms === null ? '—' : number(data.last_24_hours.average_response_ms) + ' ms'}</strong><span>Time until response headers</span></div>
      </div>
      {!!warnings.length && <p className="notice error" role="status">{warnings.some(([, value]) => value.status === 'exhausted') ? 'An allowance is at or above 100%.' : warnings.some(([, value]) => value.status === 'critical') ? 'Usage has reached 90% of an allowance.' : 'Usage has reached 75% of an allowance.'} Check the remaining quota below.</p>}
      <div className="usage-allowances">
        <Allowance label="Worker requests / day" value={data.quotas.requests} note={requests?.source === 'cloudflare' ? 'Cloudflare-reported · All Workers in this account' : 'Estimate for this site only; other Workers and earlier traffic are excluded'} />
        <Allowance label="Database rows read / day" value={data.quotas.rows_read} note={data.quotas.rows_read.used === null ? 'Account-wide · Connect read-only Cloudflare analytics to measure' : 'Cloudflare-reported · All D1 databases in this account'} />
        <Allowance label="Database rows written / day" value={data.quotas.rows_written} note="Account-wide · Includes mail processing and monitoring writes" />
        <Allowance label="This database’s storage" value={data.quotas.storage} bytes note="Measured database size · Storage does not reset daily" />
      </div>
      <div className="usage-explanation">
        <p>Daily allowances reset at <strong>{time(data.day.reset_at)} IST</strong>. Alerts appear at 75% and 90%.</p>
        <p>Traffic categories use a 10% random sample, scaled to an estimate. Small counts can be noisy. Collection started {data.started_at ? time(data.started_at) + ' IST' : 'recently'}; earlier requests are not included.{!requests?.complete && requests?.source === 'estimate' ? ' Today is a partial tracking day.' : ''}</p>
        <p>Remaining quota is not a countdown to downtime: traffic bursts, per-request CPU limits, authentication storage limits or outages can cause failures earlier. Unconnected metrics remain unavailable. If a daily quota is exhausted, this panel may also be unavailable until reset.</p>
      </div>
      <div className="usage-details">
        <div><h3 className="smallheading">Request types today <span className="badge">Estimated</span></h3><div className="table-wrap"><table><thead><tr><th>Type</th><th>Requests</th><th>4xx</th><th>5xx</th></tr></thead><tbody>{data.categories.map(category => <tr key={category.key}><td>{category.label}</td><td>{category.samples ? '≈ ' + number(category.requests) : '—'}</td><td>{category.samples ? '≈ ' + number(category.client_errors) : '—'}</td><td>{category.samples ? '≈ ' + number(category.server_errors) : '—'}</td></tr>)}</tbody></table></div><p className="usage-caption">4xx: rejected or invalid requests, including campus-network blocks. 5xx: server errors.</p></div>
        <div><h3 className="smallheading">Traffic over the last 24 hours</h3><div className="usage-chart" role="img" aria-label="Estimated hourly requests for the last 24 hours">{data.hourly.map(hour => <div className="usage-chart-column" key={hour.hour} title={`${time(hour.hour)} IST: approximately ${number(hour.requests)} requests`}><span style={{ height: `${Math.max(hour.requests ? 3 : 0, hour.requests / maxHour * 100)}%` }} /></div>)}</div><div className="usage-line usage-caption"><span>{time(data.hourly[0].hour)} IST</span><span>Now</span></div><div className="usage-health"><span>Blocked sign-in / campus requests</span><strong>≈ {number(data.today.blocked)}</strong><span>Responses over 1 second</span><strong>≈ {number(data.today.slow)}</strong></div><p className="usage-caption">Hourly aggregates retained for {data.retention_days} days. No visitor identifiers or request bodies are stored.</p></div>
      </div>
      <details className="usage-connection"><summary>Cloudflare analytics {provider?.connected ? '· connected' : '· optional setup'}</summary>
        <p>Connect a read-only token for account-wide request and database allowances. Totals may lag and are refreshed at most once every five minutes when this panel is opened.</p>
        <ol><li>Open <a className="textlink" href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noopener noreferrer">Cloudflare API tokens</a> and create a custom token.</li><li>Permission: <strong>Account → Account Analytics → Read</strong>. Include only the account hosting Shortlist Desk.</li><li>Paste it below. It is encrypted on the server and never returned to the browser.</li></ol>
        <form onSubmit={connect} className="usage-connect-form"><label className="field">Read-only analytics token<input type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} placeholder="Cloudflare API token" maxLength={300} required /></label><button className="secondary" disabled={saving || !token.trim()}>{saving ? <LoaderCircle size={13} className="spinner" /> : null}{provider?.connected ? 'Replace connection' : 'Connect analytics'}</button>{provider?.connected && <button type="button" className="danger" disabled={saving} onClick={() => void disconnect()}>Disconnect</button>}</form>
        {provider?.stale && <p className="notice error">Cloudflare analytics could not refresh. Stale totals are not used for quota headroom.</p>}
        {provider?.data?.error && <p className="notice error">{provider.data.error}</p>}
        {provider?.data && <p className="usage-caption">Cloudflare totals last fetched {time(provider.data.fetched_at)} IST. Provider analytics can be delayed or sampled; use the Cloudflare dashboard to confirm billing limits.</p>}
      </details>
      <p className="usage-updated">Updated {time(data.checked_at)} IST · Refreshes on opening or with Refresh</p>
    </>}
  </section>;
}

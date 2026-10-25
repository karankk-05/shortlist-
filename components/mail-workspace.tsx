import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { mailTaskPrompt } from '../lib/mail-guide';
import { ArrowRight, BookOpen, Check, Clipboard, FileSpreadsheet, LockKeyhole, Mail, RefreshCw } from 'lucide-react';

type Request = <T = any>(path: string, options?: RequestInit) => Promise<T>;
const stamp = (value?: string) => value ? new Date(value).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : 'Not yet';
export default function MailWorkspace({ admin, request }: { admin: boolean; request: Request }) {
  const [status, setStatus] = useState<any>(null), [jobs, setJobs] = useState<any[]>([]), [selected, setSelected] = useState<any>(null);
  const [filter, setFilter] = useState('pending'), [busy, setBusy] = useState(''), [error, setError] = useState(''), [message, setMessage] = useState(''), [copied, setCopied] = useState(false);
  const [comments, setComments] = useState<Record<string, string>>({});
  const [interval, setInterval] = useState<number | string>(5), [customInterval, setCustomInterval] = useState(false);
  const [config, setConfig] = useState({ enabled: true, folder: 'INBOX', lookback_days: 30, senders: '', link_domains: '' });
  const reload = useCallback(async () => {
    try {
      const [state, queue] = await Promise.all([request('mail/status'), request('mail-jobs?status=' + filter + '&limit=50')]);
      setStatus(state); setJobs(queue.jobs); setInterval(state.schedule?.interval_minutes ?? 5); setCustomInterval(!(state.schedule?.choices || [5, 10, 15, 30, 60]).includes(state.schedule?.interval_minutes ?? 5));
      setConfig({ ...state.config, senders: state.config.senders.join('\n'), link_domains: state.config.link_domains.join('\n') });
    } catch (error) { setError((error as Error).message); }
  }, [filter, request]);
  useEffect(() => { void reload(); }, [reload]);
  const send = (path: string, data: unknown, method = 'POST') => request(path, { method, body: JSON.stringify(data) });
  async function saveInterval(event: FormEvent) {
    event.preventDefault(); setBusy('interval'); setError(''); setMessage('');
    try { await send('mail/interval', { minutes: Number(interval) }, 'PUT'); setMessage(`Automatic sync set to every ${interval} minutes.`); await reload(); }
    catch (error) { setError((error as Error).message); } finally { setBusy(''); }
  }
  async function sync() {
    setBusy('sync'); setError(''); setMessage('');
    try { const result = await send('mail/sync', {}); setMessage(`Checked ${result.processed} matching messages; queued ${result.queued}, duplicates ${result.duplicates}, sources refreshed ${result.updated || 0}, filtered out ${result.filtered}.${result.more ? ' More matching mail remains. Sync again to continue.' : ' Mailbox is up to date.'}`); await reload(); }
    catch (error) { setError((error as Error).message); await reload(); }
    finally { setBusy(''); }
  }
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy('settings'); setError('');
    const lines = (value: string) => value.split(/[\n,]+/).map(item => item.trim()).filter(Boolean);
    try { await send('mail/config', { ...config, lookback_days: Number(config.lookback_days), senders: lines(config.senders), link_domains: lines(config.link_domains) }, 'PUT'); setMessage('Mail settings saved. The next sync rechecks the lookback period; existing messages are deduplicated.'); await reload(); }
    catch (error) { setError((error as Error).message); } finally { setBusy(''); }
  }
  async function queueWithComment(job: any) {
    setError(''); setBusy('retry'); setMessage('');
    const editing = job.status === 'pending';
    try {
      await send(`mail-jobs/${job.id}/${editing ? 'comment' : 'retry'}`, { comment: comments[job.id] ?? job.owner_comment ?? '', expected_updated_at: job.updated_at }, editing ? 'PUT' : 'POST');
      setSelected(null); setMessage(editing ? 'Comment saved for the next agent run.' : 'Job requeued with your comment for the agent.');
      setComments(previous => { const next = { ...previous }; delete next[job.id]; return next; });
      await reload();
    } catch (error) { setError((error as Error).message); } finally { setBusy(''); }
  }
  async function inspect(id: string) { setBusy('detail'); setError(''); try { setSelected(await request('mail-jobs/' + id)); } catch (error) { setError((error as Error).message); } finally { setBusy(''); } }
  const prompt = mailTaskPrompt(location.origin);
  return <>
    {error && <div className="notice error" role="alert">{error}</div>}{message && <div className="notice success" role="status">{message}</div>}
    {admin && <section className="panel" style={{ marginBottom: 24 }}><div className="panel-top"><h2><RefreshCw size={15} /> Automatic mail sync</h2><span className="pill">{status?.config.enabled === false ? 'Paused' : `Every ${status?.schedule?.interval_minutes ?? 5} minutes`}</span></div><form className="cardbody" onSubmit={saveInterval}><div className="top-actions"><label className="field">Sync interval<select aria-label="Automatic mail sync interval" value={customInterval ? 'custom' : String(interval)} disabled={!!busy || !status} onChange={event => { setCustomInterval(event.target.value === 'custom'); if (event.target.value !== 'custom') setInterval(Number(event.target.value)); }}>{(status?.schedule?.choices || [5, 10, 15, 30, 60]).map((minutes: number) => <option value={minutes} key={minutes}>Every {minutes === 60 ? 'hour' : `${minutes} minutes`}</option>)}<option value="custom">Custom…</option></select></label>{customInterval && <label className="field">Minutes<input aria-label="Custom mail sync interval in minutes" type="number" min={status?.schedule?.minimum_minutes ?? 5} max={status?.schedule?.maximum_minutes ?? 1440} step="1" required value={interval} disabled={!!busy || !status} onChange={event => setInterval(event.target.value)} /></label>}<button className="primary" disabled={!!busy || !status || Number(interval) === status?.schedule?.interval_minutes}>{busy === 'interval' ? 'Saving…' : 'Save interval'}</button></div><p className="hero-note">Custom intervals accept 5–1440 whole minutes. Changes apply automatically; your mailbox scan position is preserved.</p></form></section>}
    <div className="grid-two"><section className="panel"><div className="panel-top"><h2><Mail size={15} /> IITK mailbox</h2><span className={'pill ' + (status?.configured ? '' : 'orange')}>{status?.configured ? status.config.enabled ? status.state?.last_success_at ? 'Connected' : 'Ready to test' : 'Paused' : 'Not connected'}</span></div><div className="cardbody">
      <p className="lede">Only the configured account is read. Matches “shortlist”, “shortlists”, “shortlisted”, “short-listed” and “short list” in subjects and bodies. Matching emails, links and attachments stay private until your agent publishes a prepared shortlist.</p>
      <div className="mail-facts"><div><span>Connection</span><strong>{status?.host || 'qasid.iitk.ac.in'} · TLS 993</strong></div>{admin && status?.username && <div><span>Account</span><strong>{status.username}</strong></div>}<div><span>Folder</span><strong>{status?.config.folder || 'INBOX'}</strong></div><div><span>Last successful sync</span><strong>{stamp(status?.state?.last_success_at)}</strong></div></div>
      <div className="mail-facts"><div><span>Automatic cleanup</span><strong>Completed mail copies · 7 days after completion</strong></div><div><span>Cleanup checks</span><strong>Hourly · Shortlists always retained</strong></div><div><span>Last cleanup</span><strong>{stamp(status?.retention?.last_run?.run_at)}</strong></div></div>
      {status?.retention?.last_run?.status === 'failed' && <div className="notice error" role="alert">The last mail cleanup failed. Existing shortlists are preserved; the next hourly run will retry.</div>}
      {status?.state?.last_error && <div className="notice error">Last sync: {status.state.last_error}. Check credentials, IITK access and the folder before retrying.</div>}
      {!status?.configured && <div className="codebox light">{admin ? 'In the project terminal, run:\nnpm run setup:mail\n\nEnter your IITK username and password privately.\nThe password is hidden and saved only as a Worker secret.' : 'The owner needs to connect the mailbox in the project terminal first.'}</div>}
      {admin && <button className="primary" onClick={sync} disabled={!!busy || !status?.configured || !status?.config.enabled}><RefreshCw size={13} className={busy === 'sync' ? 'spinner' : ''} />{busy === 'sync' ? 'Syncing mailbox…' : 'Sync mailbox'}</button>}<p className="hero-note"><LockKeyhole size={11} />Read-only mailbox access. Original IITK messages are not sent, deleted or marked as read.</p>
    </div></section><section className="panel"><div className="panel-top"><h2>Run with your agent</h2><BookOpen size={16} /></div><div className="cardbody"><p className="lede">Use this workflow with the connected Shortlist Desk plugin in a cloud Work chat. The server collects mail and notifies your agent when work is ready.</p><div className="codebox mail-prompt">{prompt}</div><div className="top-actions"><button className="secondary" onClick={async () => { await navigator.clipboard.writeText(prompt); setCopied(true); }}>{copied ? <Check size={13} /> : <Clipboard size={13} />}{copied ? 'Copied' : 'Copy task prompt'}</button><a className="textlink" href="/mail-agent" target="_blank" rel="noreferrer">Full workflow<ArrowRight size={12} /></a></div><p className="hero-note">The agent processes the queue without syncing mail. Keep its event monitor active; a separate polling schedule is unnecessary.</p></div></section></div>
    {admin && <details className="panel" style={{ marginTop: 24 }}><summary className="cardbody">Mailbox settings · Owner only</summary><form className="cardbody" onSubmit={save}><div className="formgrid"><label className="field">IMAP folder<input value={config.folder} required maxLength={200} onChange={e => setConfig({ ...config, folder: e.target.value })} /></label><label className="field">Initial / rescan lookback (days)<input type="number" min="1" max="365" required value={config.lookback_days} onChange={e => setConfig({ ...config, lookback_days: Number(e.target.value) })} /></label><label className="field">Sender addresses (optional)<textarea value={config.senders} placeholder="One full address per line. Empty means all senders." onChange={e => setConfig({ ...config, senders: e.target.value })} /></label><label className="field">Approved link domains<textarea value={config.link_domains} placeholder="One domain per line, without https://" onChange={e => setConfig({ ...config, link_domains: e.target.value })} /></label></div><label className="mail-enable"><input type="checkbox" checked={config.enabled} onChange={e => setConfig({ ...config, enabled: e.target.checked })} />Enable mailbox syncing</label><p className="hero-note">Matches complete shortlist words in decoded subjects and bodies, including “shortlists”, “shortlisted”, “short-listed” and “short list”. “Short” and “shortly” alone do not qualify. The agent checks relevance before publishing.</p><button className="primary" disabled={!!busy}>Save mail settings</button></form></details>}
    <section className="panel" style={{ marginTop: 24 }}><div className="panel-top"><div><h2>Mail processing queue <span className="badge">Private</span></h2><p className="panel-subtitle">Newest received first. Claims prevent overlapping runs; unfinished work can resume after its claim expires.</p></div><div className="top-actions"><select aria-label="Filter mail jobs" value={filter} onChange={e => { setFilter(e.target.value); setSelected(null); }}>{[['pending','Pending'],['processing','Processing'],['needs_review','Needs review'],['done','Completed'],['ignored','Ignored'],['all','All jobs']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><button className="secondary" onClick={reload} disabled={!!busy}><RefreshCw size={12} />Refresh</button></div></div><div className="table-wrap"><table><thead><tr><th>Email</th><th>Status</th><th>Received</th><th>Action</th></tr></thead><tbody>{jobs.map(job => <tr key={job.id}><td><strong>{job.subject}</strong><div className="subtle">{job.sender}</div>{job.note && <div className="subtle">{job.note}</div>}{job.owner_comment && <div className="owner-comment"><strong>Owner comment:</strong> {job.owner_comment}</div>}</td><td><span className={'pill ' + (job.status === 'needs_review' ? 'orange' : '')}>{job.status.replaceAll('_',' ')}</span></td><td>{stamp(job.received_at || job.created_at)}</td><td><button className="secondary" disabled={!!busy} onClick={() => inspect(job.id)}>{job.source_deleted_at ? 'View results' : 'View source'}</button>{admin && ['needs_review','ignored','pending'].includes(job.status) && <form className="mail-requeue" onSubmit={event => { event.preventDefault(); void queueWithComment(job); }}><label>Comment for agent<textarea aria-label={'Comment for agent: ' + job.subject} rows={2} maxLength={2000} placeholder="Optional context or correction…" value={comments[job.id] ?? job.owner_comment ?? ''} disabled={!!busy} onChange={event => setComments(previous => ({ ...previous, [job.id]: event.target.value }))} /></label><button className="secondary" disabled={!!busy || (job.status === 'pending' && (comments[job.id] ?? job.owner_comment ?? '') === (job.owner_comment || ''))}>{job.status === 'pending' ? 'Save comment' : 'Requeue'}</button></form>}</td></tr>)}{!jobs.length && <tr><td colSpan={4} className="muted">No {filter === 'all' ? '' : filter.replaceAll('_',' ') + ' '}mail jobs. Sync the connected mailbox to collect matching emails.</td></tr>}</tbody></table></div></section>
    {selected && <section className="panel" style={{ marginTop: 24 }}>
      <div className="panel-top"><div><h2>{selected.job.subject}</h2><p className="panel-subtitle">{selected.job.sender} · Private source</p></div><button className="quiet" onClick={() => setSelected(null)}>Close</button></div>
      <div className="cardbody">
        {selected.job.note && <p className="lede">{selected.job.note}</p>}{selected.job.owner_comment && <div className="owner-comment"><strong>Owner comment:</strong> {selected.job.owner_comment}</div>}
        {selected.job.source_deleted_at ? <div className="notice info" role="status">This completed mail copy and its attachments were removed on {stamp(selected.job.source_deleted_at)} by the seven-day cleanup policy. Shortlists and version history remain available.</div> : <>
          <pre className="codebox light mail-text">{selected.source.text || 'No email body was saved.'}</pre>
          <h3 className="smallheading">Attachments</h3>
          {selected.source.attachments.map((file: any) => <div className="fileitem" key={file.id}><a href={'/api/v1/uploads/' + file.id}><FileSpreadsheet size={14} />{file.filename}</a><small>{Math.ceil(file.size / 1024)} KB</small></div>)}
          {!selected.source.attachments.length && <p className="muted">No supported attachments.</p>}
          <h3 className="smallheading" style={{ marginTop: 22 }}>Links</h3>
          {selected.source.links.map((link: any) => <div className="fileitem" key={link.url}>{link.allowed ? <a href={link.url} target="_blank" rel="noopener noreferrer">{new URL(link.url).hostname}<ArrowRight size={12} /></a> : <span>{new URL(link.url).hostname}</span>}<span className={'pill ' + (link.allowed ? '' : 'orange')}>{link.allowed ? 'Approved domain' : 'Needs review'}</span></div>)}
          {!selected.source.links.length && <p className="muted">No HTTPS source links.</p>}
        </>}
        {selected.versions.length > 0 && <><h3 className="smallheading" style={{ marginTop: 22 }}>Prepared results</h3>{selected.versions.map((version: any) => <div className="fileitem" key={version.id}><span>{version.company} / {version.role} · Version {version.number}</span>{version.published_at && !version.deleted_at ? <a href={'/?list=' + version.shortlist_id}>View shortlist<ArrowRight size={12} /></a> : <span className="pill orange">Private draft or deleted</span>}</div>)}</>}
      </div>
    </section>}

  </>;
}

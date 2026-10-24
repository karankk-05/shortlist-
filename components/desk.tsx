'use client';
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUp, ArrowUpDown, BookOpen, Check, CheckCircle2, ChevronLeft, ChevronRight, CircleHelp, Clipboard, Eye, EyeOff, FileSpreadsheet, Files, FolderOpen, KeyRound, Layers, LoaderCircle, LockKeyhole, LogOut, RotateCcw, Search, ShieldCheck, SlidersHorizontal, Sparkles, Trash2, Upload, X } from 'lucide-react';
import { COLUMNS, StudentRow, validateRows } from '@/lib/records';
import { agentGuide } from '@/lib/agent-guide';
import MailWorkspace from './mail-workspace';
import { EMPTY_STUDENT_FILTERS, cpiRangeError, studentBatch, viewStudents, type StudentFilters, type StudentSort, type SortDirection } from '@/lib/student-view';

type View = 'library' | 'upload' | 'guide' | 'admin' | 'mail';
type Session = { role: 'public' | 'uploader' | 'admin'; label: string | null; owner_configured: boolean };
type Listing = { id: string; company: string; role: string; round: string; season: string; notes: string; published_version_id: string | null; row_count: number | null; added_at: string; updated_at: string; version_number: number | null; version_count: number; deleted_at?: string | null };
type Master = { id: string; name: string; row_count: number; cpi_count: number; created_at: string };
type Version = { id: string; number: number; row_count: number; published_at: string | null; processing_notes: string; warnings: { row: number; roll: string; issues: string[] }[]; created_at: string };
type Draft = { shortlist_id: string; version_id: string; row_count: number; number: number; warnings: { row: number; roll: string; issues: string[] }[]; expected_current_version_id: string | null; public_url: string };
type StoredFile = { id: string; filename: string; size: number; created_at: string };
const labels: Record<View, string> = { library: 'Shortlists', upload: 'Upload workspace', guide: 'Agent workflow', admin: 'Owner settings', mail: 'Mail workflow' };
async function api<T = any>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch('/api/v1/' + path, { cache: 'no-store', credentials: 'same-origin', ...options, headers: { ...(options?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...options?.headers } });
  const result: any = await response.json(); if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`); return result as T;
}
const send = (path: string, data: unknown, method = 'POST') => api(path, { method, body: JSON.stringify(data) });
const date = (value?: string | null) => value ? new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : 'No publications yet';
const format = (value: number) => new Intl.NumberFormat('en-IN').format(value);
function Alert({ message, type = 'error' }: { message: string; type?: 'error' | 'success' | 'info' }) { return <div role={type === 'error' ? 'alert' : 'status'} className={'notice ' + type}>{type === 'success' ? <CheckCircle2 size={16} /> : <CircleHelp size={16} />}<span>{message}</span></div>; }
function Busy() { return <LoaderCircle size={15} className="spinner" />; }
async function copy(text: string) { await navigator.clipboard.writeText(text); }

function DeleteShortlist({ list, onDeleted, onError }: { list: Listing; onDeleted: () => void; onError: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  async function remove() {
    if (!confirm(`Delete ${list.company} / ${list.role} / ${list.round} / ${list.season}? It will disappear from the public library and upload workspace. The owner can restore it from Deleted shortlists.`)) return;
    setBusy(true);
    try {
      await send(`shortlists/${list.id}`, { expected_updated_at: list.updated_at }, 'DELETE');
      onDeleted();
    } catch (error) { onError((error as Error).message); }
    finally { setBusy(false); }
  }
  return <button className="danger" disabled={busy} onClick={remove}>{busy ? <Busy /> : <Trash2 size={13} />}Delete shortlist</button>;
}

function ManageShortlists() {
  const [active, setActive] = useState<Listing[]>([]), [deleted, setDeleted] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [message, setMessage] = useState(''), [restoring, setRestoring] = useState('');
  const reload = useCallback(async () => {
    setError(''); setLoading(true);
    try {
      const [current, trash] = await Promise.all([api('shortlists?include_drafts=1'), api('shortlists/deleted')]);
      setActive(current.shortlists); setDeleted(trash.shortlists);
    } catch (error) { setError((error as Error).message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  async function restore(list: Listing) {
    if (!confirm(`Restore ${list.company} / ${list.role} / ${list.round} / ${list.season}?${list.published_version_id ? ' Its previous published version will be public again.' : ' It will return as a private draft.'}`)) return;
    setError(''); setMessage(''); setRestoring(list.id);
    try {
      await send(`shortlists/${list.id}/undelete`, { expected_updated_at: list.updated_at });
      setMessage('Shortlist restored with its version history.'); await reload();
    } catch (error) { setError((error as Error).message); }
    finally { setRestoring(''); }
  }
  return <section className="panel" style={{ marginBottom: 24 }}>
    <div className="panel-top"><div><h2>Manage shortlists <span className="badge">Owner only</span></h2><p className="panel-subtitle">Delete a shortlist from the site. Its versions stay available for recovery.</p></div><button className="secondary" onClick={reload} disabled={loading}>Refresh</button></div>
    <div className="cardbody" style={{ paddingBottom: 0 }}>{error && <Alert message={error} />}{message && <Alert message={message} type="success" />}</div>
    {loading ? <div className="loading"><Busy />Loading shortlists…</div> : <>
      <div className="table-wrap"><table><thead><tr><th>Company</th><th>Role</th><th>Round / season</th><th>Status</th><th>Action</th></tr></thead><tbody>
        {active.map(list => <tr key={list.id}><td>{list.published_version_id ? <a className="textlink" href={'/?list=' + list.id}>{list.company}</a> : list.company}</td><td>{list.role}</td><td>{list.round} / {list.season}</td><td><span className={'pill ' + (list.published_version_id ? '' : 'orange')}>{list.published_version_id ? 'Published' : 'Private draft'}</span></td><td><DeleteShortlist list={list} onError={setError} onDeleted={() => { setMessage('Shortlist deleted. You can restore it below.'); void reload(); }} /></td></tr>)}
        {!active.length && <tr><td colSpan={5} className="muted">No active shortlists.</td></tr>}
      </tbody></table></div>
      <details className="cardbody"><summary>Deleted shortlists ({deleted.length})</summary><p className="hero-note">Only the owner can see this list or restore a deleted shortlist.</p>
        {deleted.map(list => <div className="versionrow" key={list.id}><div>{list.company} / {list.role}<small>{list.round} / {list.season} · Deleted {date(list.deleted_at)} · {list.version_count} versions retained</small></div><button className="secondary" disabled={!!restoring} onClick={() => restore(list)}>{restoring === list.id ? <Busy /> : <RotateCcw size={13} />}Restore shortlist</button></div>)}
        {!deleted.length && <p className="muted">No deleted shortlists.</p>}
      </details>
    </>}
  </section>;
}

async function readRows(file: File, master = false): Promise<StudentRow[]> {
  if (file.size > 10 * 1024 * 1024) throw new Error('Choose a file smaller than 10 MB.');
  let data: Record<string, unknown>[];
  if (/\.json$/i.test(file.name)) { const parsed = JSON.parse(await file.text()); data = Array.isArray(parsed) ? parsed : parsed.rows; }
  else {
    const xlsx = await import('xlsx'); const workbook = xlsx.read(await file.arrayBuffer(), { type: 'array', raw: true });
    if (workbook.SheetNames.length !== 1) throw new Error('Upload the prepared, single-sheet result. Ask Gemini to resolve multi-sheet source files first.');
    const matrix = xlsx.utils.sheet_to_json<unknown[]>(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: '', raw: true }).filter(row => row.some(value => value !== '' && value !== null));
    if (matrix.length < 2) throw new Error('The file needs a header row and student records.');
    const headers = matrix[0].map(value => String(value).trim().toLowerCase());
    if (new Set(headers).size !== headers.length || COLUMNS.some(column => !headers.includes(column)) || (!master && headers.length !== 6)) throw new Error('Expected the exact columns: ' + COLUMNS.join(', ') + '. Ask Gemini to prepare this result first.');
    data = matrix.slice(1).map(values => Object.fromEntries((master ? COLUMNS : headers).map(key => {
      const value = values[headers.indexOf(key)] ?? '';
      if (key === 'roll' && typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('A roll number has lost numeric precision. Ask Gemini to verify it against the source.');
      return [key, key === 'cpi' ? value : String(value)];
    })));
  }
  if (master && Array.isArray(data)) data = data.map(row => Object.fromEntries(COLUMNS.map(key => [key, row[key] ?? (key === 'cpi' ? null : '')])));
  return validateRows(data).rows;
}
async function exportXlsx(rows: StudentRow[], filename: string) {
  const xlsx = await import('xlsx'); const sheet = xlsx.utils.json_to_sheet(rows, { header: [...COLUMNS] });
  sheet['!cols'] = [{ wch: 32 }, { wch: 15 }, { wch: 16 }, { wch: 43 }, { wch: 9 }, { wch: 29 }];
  sheet['!autofilter'] = { ref: `A1:F${rows.length + 1}` };
  rows.forEach((row, i) => { if (sheet[`B${i + 2}`]) sheet[`B${i + 2}`].z = '@'; if (row.cpi !== null) sheet[`E${i + 2}`].z = '0.0#'; });
  const workbook = xlsx.utils.book_new(); xlsx.utils.book_append_sheet(workbook, sheet, 'Shortlist'); xlsx.writeFileXLSX(workbook, filename.replace(/[^a-zA-Z0-9_-]/g, '_') + '.xlsx');
}

const studentColumnLabels = { name: 'Name', roll: 'Roll', programme: 'Programme', branch: 'Branch', cpi: 'CPI', email: 'Email' };
function StudentTable({ rows }: { rows: StudentRow[] }) {
  const [filters, setFilters] = useState<StudentFilters>({ ...EMPTY_STUDENT_FILTERS });
  const [sort, setSort] = useState<StudentSort>('source'), [direction, setDirection] = useState<SortDirection>('asc'), [page, setPage] = useState(0);
  const [showCpi, setShowCpi] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  useEffect(() => { setShowCpi(false); }, [rows]);
  const options = useMemo(() => ({
    programmes: [...new Set(rows.map(row => row.programme).filter(Boolean))].sort(),
    branches: [...new Set(rows.map(row => row.branch).filter(Boolean))].sort(),
    batches: [...new Set(rows.map(studentBatch).filter(Boolean))].sort(),
  }), [rows]);
  const filtered = useMemo(() => viewStudents(rows, filters, sort, direction), [rows, filters, sort, direction]);
  const rangeError = cpiRangeError(filters);
  const changed = sort !== 'source' || Object.keys(EMPTY_STUDENT_FILTERS).some(key => filters[key as keyof StudentFilters] !== EMPTY_STUDENT_FILTERS[key as keyof StudentFilters]);
  const pages = Math.max(1, Math.ceil(filtered.length / 50)), current = Math.min(page, pages - 1);
  function changeFilter<K extends keyof StudentFilters>(field: K, value: StudentFilters[K]) { setFilters(previous => ({ ...previous, [field]: value })); setPage(0); }
  function chooseSort(field: StudentSort, order: SortDirection) { setSort(field); setDirection(order); setPage(0); }
  function reset() { setFilters({ ...EMPTY_STUDENT_FILTERS }); chooseSort('source', 'asc'); }
  return <>
    <div className="toolbar student-tools"><label className="search"><Search size={15} /><input aria-label="Search students" placeholder="Search name, roll, branch or email…" value={filters.query} onChange={e => changeFilter('query', e.target.value)} /></label>
      <label className="filter-control">Sort by<select aria-label="Sort students" value={sort === 'source' ? 'source' : `${sort}:${direction}`} onChange={e => { const [field, order] = e.target.value.split(':'); chooseSort(field as StudentSort, (order || 'asc') as SortDirection); }}>
        <option value="source">Original shortlist order</option>
        {COLUMNS.flatMap(key => (['asc', 'desc'] as const).map(order => <option key={key + order} value={`${key}:${order}`}>{studentColumnLabels[key]}: {key === 'cpi' || key === 'roll' ? order === 'asc' ? 'low to high' : 'high to low' : order === 'asc' ? 'A to Z' : 'Z to A'}</option>))}
      </select></label>
      <button className="secondary" aria-label={`${showCpi ? 'Hide' : 'Show'} CPI for all students`} aria-pressed={showCpi} onClick={() => setShowCpi(previous => !previous)}>{showCpi ? <EyeOff size={14} /> : <Eye size={14} />}{showCpi ? 'Hide CPI' : 'Show CPI'}</button>
      <button className="secondary" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(previous => !previous)}><SlidersHorizontal size={13} />Filters{changed && <span className="filter-active" aria-label="View modified" />}</button>
    </div>
    {filtersOpen && <div className="student-filters">
      <label className="filter-control">Programme<select aria-label="Filter by programme" value={filters.programme} onChange={e => changeFilter('programme', e.target.value)}><option value="">All programmes</option>{options.programmes.map(value => <option key={value}>{value}</option>)}</select></label>
      <label className="filter-control branch-filter">Branch<select aria-label="Filter by branch" value={filters.branch} onChange={e => changeFilter('branch', e.target.value)}><option value="">All branches</option>{options.branches.map(value => <option key={value}>{value}</option>)}</select></label>
      <label className="filter-control">Batch<select aria-label="Filter by batch" value={filters.batch} onChange={e => changeFilter('batch', e.target.value)}><option value="">All batches</option>{options.batches.map(value => <option key={value}>{value}</option>)}</select></label>
      <label className="filter-control">CPI<select aria-label="Filter by CPI availability" value={filters.cpiStatus} onChange={e => changeFilter('cpiStatus', e.target.value as StudentFilters['cpiStatus'])}><option value="all">All records</option><option value="available">CPI available</option><option value="missing">CPI missing</option></select></label>
      <label className="filter-control cpi-limit">Min CPI<input aria-label="Minimum CPI" type="number" min="0" max="10" step="0.01" placeholder="0" value={filters.minimumCpi} aria-invalid={!!rangeError} onChange={e => changeFilter('minimumCpi', e.target.value)} /></label>
      <label className="filter-control cpi-limit">Max CPI<input aria-label="Maximum CPI" type="number" min="0" max="10" step="0.01" placeholder="10" value={filters.maximumCpi} aria-invalid={!!rangeError} onChange={e => changeFilter('maximumCpi', e.target.value)} /></label>
      <button className="secondary" disabled={!changed} onClick={reset}><RotateCcw size={12} />Reset view</button>
    </div>}
    {rangeError && <p role="status" className="filter-error">{rangeError}</p>}
    <div className="table-wrap"><table className="student-table"><thead><tr>{COLUMNS.map(key => <th key={key} aria-sort={sort === key ? direction === 'asc' ? 'ascending' : 'descending' : 'none'}><button className="column-sort" aria-label={'Sort by ' + studentColumnLabels[key]} onClick={() => chooseSort(key, sort === key && direction === 'asc' ? 'desc' : 'asc')}>{studentColumnLabels[key]}{sort === key ? direction === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} /> : <ArrowUpDown size={11} />}</button></th>)}</tr></thead><tbody>
      {filtered.slice(current * 50, current * 50 + 50).map(row => <tr key={row.roll}><td>{row.name || <span className="muted">Not supplied</span>}</td><td>{row.roll}</td><td><span className="pill">{row.programme || '—'}</span></td><td>{row.branch || '—'}</td><td><span className={showCpi ? row.cpi === null ? 'muted' : '' : 'cpi-hidden'}>{showCpi ? row.cpi === null ? '—' : String(row.cpi) : '...'}</span></td><td>{row.email || '—'}</td></tr>)}
      {!filtered.length && <tr><td colSpan={6} className="muted">{rangeError ? 'Correct the CPI range above.' : 'No students match these filters.'}</td></tr>}
    </tbody></table></div>
    <div className="panel-footer"><span aria-live="polite">{format(filtered.length)} of {format(rows.length)} students</span><div className="pagination"><span>{current + 1} / {pages}</span><button aria-label="Previous page" disabled={!current} onClick={() => setPage(current - 1)}><ChevronLeft size={13} /></button><button aria-label="Next page" disabled={current + 1 >= pages} onClick={() => setPage(current + 1)}><ChevronRight size={13} /></button></div></div>
  </>;
}

export default function Desk({ initialView }: { initialView: View }) {
  const [session, setSession] = useState<Session>({ role: 'public', label: null, owner_configured: true });
  const [lists, setLists] = useState<Listing[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [detail, setDetail] = useState<{ shortlist: Listing; rows: StudentRow[]; version: Version } | null>(null);
  const [query, setQuery] = useState(''), [round, setRound] = useState(''), [origin, setOrigin] = useState('');
  const refresh = useCallback(async () => {
    try { const [me, result] = await Promise.all([api<Session>('me'), api('shortlists')]); setSession(me); setLists(result.shortlists); setError(''); }
    catch (error) { setError((error as Error).message); } finally { setLoading(false); }
  }, []);
  useEffect(() => { setOrigin(location.origin); refresh(); const list = new URLSearchParams(location.search).get('list'); if (list && initialView === 'library') api('shortlists/' + encodeURIComponent(list)).then(setDetail).catch(error => setError(error.message)); }, [refresh, initialView]);
  const authorised = session.role !== 'public';
  const shown = lists.filter(list => (!round || list.round === round) && (!query || [list.company, list.role, list.season].some(value => value.toLowerCase().includes(query.toLowerCase()))));
  const heading = (title: string, eyebrow: string, subtitle: string, action?: ReactNode) => <div className="heading-row"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{subtitle && <p className="lede">{subtitle}</p>}</div>{action}</div>;
  const brand = <a className="brand" href="/"><span className="brandmark"><Layers size={22} strokeWidth={1.6} /></span><span><strong>shortlist desk</strong><small>IIT KANPUR</small></span></a>;
  return <div className={'shell' + (authorised ? '' : ' public-shell')}>
    {authorised && <aside className="sidebar">{brand}<div className="navgroup"><div className="navlabel">WORKSPACE</div><nav>
      <a className={'navitem ' + (initialView === 'library' ? 'active' : '')} href="/"><FolderOpen size={17} />Company shortlists<span className="navcount">{lists.length}</span></a>
      <a className={'navitem ' + (initialView === 'upload' ? 'active' : '')} href="/upload"><Upload size={17} />Upload workspace</a>
      <a className={'navitem ' + (initialView === 'mail' ? 'active' : '')} href="/mail"><Files size={17} />Mail workflow</a>
      <a className={'navitem ' + (initialView === 'guide' ? 'active' : '')} href="/guide"><Sparkles size={17} />Agent workflow</a>
      {session.role === 'admin' && <a className={'navitem ' + (initialView === 'admin' ? 'active' : '')} href="/admin"><SlidersHorizontal size={17} />Owner settings</a>}
    </nav></div></aside>}
    <div className="workspace"><header className="topbar">
      {authorised ? <div className="breadcrumbs"><span>Workspace</span><ChevronRight size={11} /><strong>{labels[initialView]}</strong></div> : brand}
      {authorised ? <button className="quiet" onClick={async () => { try { await api('session', { method: 'DELETE' }); await refresh(); } catch (error) { setError((error as Error).message); } }}><LogOut size={13} />Log out</button> : initialView !== 'admin' && <a className="secondary" href="/admin"><LockKeyhole size={13} />Owner login</a>}
    </header><main className="content">{error && <Alert message={error} />}
      {initialView === 'library' && !detail && <>
        {heading('Company shortlists', '', '', authorised ? <a href="/upload" className="primary"><Upload size={14} />Upload shortlist</a> : undefined)}
        <section className="stats" aria-label="Library statistics">
          <div className="stat"><span className="stat-icon"><FolderOpen size={19} /></span><div><div className="stat-number">{loading ? '—' : format(lists.length)}</div><span className="stat-label">Published shortlists</span></div></div>
          <div className="stat"><span className="stat-icon"><Files size={19} /></span><div><div className="stat-number">{loading ? '—' : format(lists.reduce((sum, list) => sum + (list.row_count || 0), 0))}</div><span className="stat-label">Shortlist entries</span></div></div>
          <div className="stat"><span className="stat-icon"><CheckCircle2 size={19} /></span><div><div className="stat-number small">{loading ? '—' : lists.length ? date(lists[0].added_at) : '—'}</div><span className="stat-label">Latest addition</span></div></div>
        </section>
        <section className="panel" aria-label="Company shortlists">
          <div className="toolbar"><label className="search"><Search size={15} /><input aria-label="Search companies" placeholder="Search company or position…" value={query} onChange={e => setQuery(e.target.value)} /></label><select aria-label="Filter by round" value={round} onChange={e => setRound(e.target.value)}><option value="">All rounds</option>{[...new Set(lists.map(list => list.round))].map(value => <option key={value}>{value}</option>)}</select></div>
          {loading ? <div className="loading"><Busy /> Loading shortlists…</div> : lists.length === 0 ? <div className="empty"><h3>No shortlists yet.</h3></div> : <div className="table-wrap"><table><thead><tr><th>Company</th><th>Position</th><th>Round</th><th>Students</th><th>Date added</th><th></th></tr></thead><tbody>
            {shown.map(list => <tr className="clickable" key={list.id} onClick={() => { location.href = '/?list=' + list.id; }}><td><a href={'/?list=' + list.id} className="company-cell"><span className="company-logo">{list.company[0]}</span><span><span className="company-name">{list.company}</span><div className="subtle">{list.season}</div></span></a></td><td>{list.role}</td><td><span className="pill">{list.round}</span></td><td>{format(list.row_count || 0)}</td><td className="muted">{date(list.added_at)}</td><td><ArrowRight size={15} color="#7d906f" /></td></tr>)}
            {!shown.length && <tr><td colSpan={6} className="muted">No shortlists match your search.</td></tr>}
          </tbody></table></div>}
        </section>
      </>}
      {initialView === 'library' && detail && <>
        <a href="/" className="back"><ArrowLeft size={13} />All company shortlists</a>
        {heading(detail.shortlist.company, `${detail.shortlist.season} / ${detail.shortlist.round}`, detail.shortlist.role, authorised ? <div className="top-actions">
          {session.role === 'admin' && <DeleteShortlist list={detail.shortlist} onError={setError} onDeleted={() => { location.href = '/'; }} />}
          <a className="secondary" href={`/api/v1/shortlists/${detail.shortlist.id}/export.csv`}><ArrowDownToLine size={13} />CSV</a><button className="primary" onClick={() => exportXlsx(detail.rows, detail.shortlist.company + '_shortlist').catch(error => setError(error.message))}><ArrowDownToLine size={13} />Excel</button>
        </div> : undefined)}
        <section className="stats" aria-label="Shortlist statistics">
          <div className="stat"><div><div className="stat-number">{format(detail.rows.length)}</div><span className="stat-label">Shortlisted students</span></div></div>
          <div className="stat"><div><div className="stat-number">{format(detail.rows.filter(row => row.cpi !== null).length)}</div><span className="stat-label">CPI available</span></div></div>
          <div className="stat"><div><div className="stat-number small">{date(detail.shortlist.added_at)}</div><span className="stat-label">Date added{authorised ? ` · Version ${detail.version.number}` : ''}</span></div></div>
        </section>
        {detail.shortlist.notes && <p className="shortlist-note">{detail.shortlist.notes}</p>}
        <section className="panel" aria-label="Shortlisted students"><StudentTable key={detail.shortlist.id} rows={detail.rows} /></section>
        {session.role === 'admin' && <VersionHistory list={detail.shortlist} onError={setError} />}
      </>}
      {initialView !== 'library' && (loading ? <div className="loading">Checking access…</div> : !authorised || (initialView === 'admin' && session.role !== 'admin') ? <Login adminOnly={initialView === 'admin'} onSuccess={refresh} /> : <>
        {initialView === 'guide' ? <Guide origin={origin} heading={heading} /> : <>
          {heading(initialView === 'upload' ? 'Upload workspace' : initialView === 'mail' ? 'Mail workflow' : 'Owner settings', initialView === 'admin' ? 'ACCESS & SOURCE DATA' : 'PRIVATE WORKSPACE', initialView === 'upload' ? 'Prepare with Gemini. Preview here. Publish when the shortlist is ready.' : initialView === 'mail' ? 'Collect shortlist emails privately. Let your agent interpret and publish them.' : 'Manage the student master and the keys your agents use.')}
          {initialView === 'upload' ? <UploadWorkspace /> : initialView === 'mail' ? <MailWorkspace admin={session.role === 'admin'} request={api} /> : <AdminWorkspace />}
        </>}
      </>)}
    </main></div>
  </div>;
}

function Login({ adminOnly, onSuccess }: { adminOnly: boolean; onSuccess: () => void }) {
  const [key, setKey] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function login(event: FormEvent) { event.preventDefault(); setBusy(true); setError(''); try { const result = await send('session', { key: key.trim() }); setKey(''); if (adminOnly && result.role !== 'admin') throw new Error('This is an uploader key. Owner settings require the owner key.'); onSuccess(); } catch (error) { setError((error as Error).message); } finally { setBusy(false); } }
  return <section className="panel login"><div className="cardbody">
    <h1>{adminOnly ? 'Owner login' : 'Workspace login'}</h1>
    <p id="key-help">{adminOnly ? 'Enter the owner access key created during site setup. This is the portal key, not your email password.' : 'Enter an uploader key issued by the owner, or the owner access key.'} Paste the key below, then press Enter or select Log in.</p>
    {error && <Alert message={error} />}
    <form onSubmit={login}><label className="field" style={{ marginTop: 18 }}>{adminOnly ? 'Owner access key' : 'Access key'}<input type="text" name="access_key" autoComplete="off" autoCapitalize="none" spellCheck={false} aria-describedby="key-help" placeholder="Enter key" required value={key} onChange={e => setKey(e.target.value)} /></label><button className="primary" style={{ width: '100%', marginTop: 16 }} disabled={busy || !key.trim()}>{busy ? <Busy /> : <KeyRound size={13} />}Log in</button></form>
    <a href="/" className="textlink login-back"><ArrowLeft size={13} />Back to shortlists</a>
  </div></section>;
}

function UploadWorkspace() {
  const [master, setMaster] = useState<Master | null>(null), [lists, setLists] = useState<Listing[]>([]), [files, setFiles] = useState<StoredFile[]>([]);
  const [existing, setExisting] = useState(''), [latest, setLatest] = useState<string | null>(null), [rows, setRows] = useState<StudentRow[]>([]), [filename, setFilename] = useState('');
  const [metadata, setMetadata] = useState({ company: '', role: '', round: 'Interview', season: '2026–27' });
  const [notes, setNotes] = useState(''), [busy, setBusy] = useState(''), [error, setError] = useState(''), [message, setMessage] = useState(''), [draft, setDraft] = useState<Draft | null>(null), [published, setPublished] = useState(false), [ack, setAck] = useState(false), [sourceIds, setSourceIds] = useState<string[]>([]);
  useEffect(() => { api<Master>('master/info').then(setMaster).catch(error => setError(error.message)); api('shortlists?include_drafts=1').then(data => setLists(data.shortlists)).catch(error => setError(error.message)); api('uploads').then(data => setFiles(data.uploads)).catch(error => setError(error.message)); }, []);
  async function chooseExisting(value: string) { setExisting(value); setDraft(null); setPublished(false); if (value) { const list = lists.find(list => list.id === value)!; setMetadata({ company: list.company, role: list.role, round: list.round, season: list.season }); try { const result = await api('shortlists/' + value + '/versions'); setLatest(result.versions[0]?.id || null); } catch (error) { setError((error as Error).message); } } else { setLatest(null); setMetadata({ company: '', role: '', round: 'Interview', season: '2026–27' }); } }
  async function pick(file?: File) { if (!file) return; if (draft) setExisting(draft.shortlist_id); setError(''); setMessage(''); setBusy('read'); setDraft(null); setPublished(false); try { setRows(await readRows(file)); setFilename(file.name); } catch (error) { setError((error as Error).message); setRows([]); } finally { setBusy(''); } }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!master || !rows.length) return; setBusy('draft'); setError(''); setMessage('');
    try { const result = await send(existing ? `shortlists/${existing}/versions` : 'shortlists', { ...metadata, rows, master_id: master.id, processing_notes: notes, source_upload_ids: sourceIds, ...(existing ? { expected_latest_version_id: latest } : {}) }); if (!existing) setLists(previous => [...previous, { ...metadata, id: result.shortlist_id, notes: '', published_version_id: null, row_count: rows.length, added_at: new Date().toISOString(), updated_at: new Date().toISOString(), version_number: null, version_count: 1 }]); setDraft(result); setLatest(result.version_id); setPublished(false); setAck(false); setMessage('Draft saved privately. Review the preview before publishing.'); }
    catch (error) { setError((error as Error).message); } finally { setBusy(''); }
  }
  async function publishDraft() { if (!draft) return; setBusy('publish'); setError(''); try { await send(`shortlists/${draft.shortlist_id}/publish`, { version_id: draft.version_id, expected_current_version_id: draft.expected_current_version_id, acknowledge_warnings: ack || !draft.warnings.length }); setPublished(true); setMessage('Published. Everyone can now view this version.'); } catch (error) { setError((error as Error).message); } finally { setBusy(''); } }
  async function uploadSource(file?: File) { if (!file) return; setBusy('source'); setError(''); try { const form = new FormData(); form.append('file', file); const result = await api('uploads', { method: 'POST', body: form }); setFiles(previous => [result, ...previous]); setSourceIds(previous => [...previous, result.id]); setMessage('Source file stored privately. Gemini can download it using the upload endpoint.'); } catch (error) { setError((error as Error).message); } finally { setBusy(''); } }
  return <>{error && <Alert message={error} />}{message && <Alert message={message} type="success" />}<div className="grid-two"><section className="panel"><div className="panel-top"><div><h2>Publish a prepared shortlist</h2><p className="panel-subtitle">Gemini completes the merge. The portal checks and stores the result.</p></div><span className="pill orange">Private until published</span></div><form className="cardbody" onSubmit={save}><div className="formgrid"><label className="field wide">Destination<select value={existing} onChange={e => chooseExisting(e.target.value)} disabled={!!busy || !!draft}><option value="">Create a new company shortlist</option>{lists.map(list => <option key={list.id} value={list.id}>{list.company} / {list.role} / {list.round} / {list.season}</option>)}</select></label>{(['company', 'role', 'round', 'season'] as const).map(field => <label className="field" key={field}>{field[0].toUpperCase() + field.slice(1)}<input required value={metadata[field]} placeholder={{ company: 'Company name', role: 'e.g. Software Engineer', round: 'Interview', season: '2026–27' }[field]} readOnly={!!existing} disabled={!!draft} onChange={e => setMetadata({ ...metadata, [field]: e.target.value })} /></label>)}<div className="field wide">Prepared six-column file<label className="dropzone"><Upload size={24} strokeWidth={1.3} /><strong>{filename || 'Choose the result prepared by Gemini'}</strong><small>Single-sheet XLSX, CSV or JSON · Up to 10 MB</small><input aria-label="Prepared shortlist file" type="file" accept=".xlsx,.xls,.csv,.json" onChange={e => pick(e.target.files?.[0])} disabled={!!busy} /></label>{rows.length > 0 && <small className="muted">{format(rows.length)} student records ready for preview</small>}</div><label className="field wide">Private processing notes<textarea value={notes} disabled={!!draft} onChange={e => setNotes(e.target.value)} placeholder="Matches checked, source sheets examined, unresolved records and any changes. These notes are never public." /></label></div><div className="hero-note"><ShieldCheck size={12} />{master ? `Using ${master.name} · ${format(master.row_count)} master records` : 'Waiting for the owner to import the student master.'}</div><div className="formactions">{draft && !published && <button type="button" className="quiet" onClick={() => { setExisting(draft.shortlist_id); setDraft(null); setMessage(''); }}>Prepare another version</button>}<button className="primary" disabled={!!busy || !rows.length || !master || !!draft}>{busy === 'draft' || busy === 'read' ? <Busy /> : <FileSpreadsheet size={14} />}Save private draft</button></div></form></section><div><section className="panel"><div className="panel-top"><h2>Working with Gemini</h2><Sparkles size={16} color="#8f9e7e" /></div><div className="cardbody"><div className="steps"><div className="step"><span className="step-num">1</span><div><strong>Share the workflow</strong>Give Gemini the agent guide and a separate uploader key.</div></div><div className="step"><span className="step-num">2</span><div><strong>Let it interpret the source</strong>It reads the company file and the private master, then prepares the six-column result.</div></div><div className="step"><span className="step-num">3</span><div><strong>Preview and publish</strong>Upload the result here, or let a capable agent use the endpoints directly.</div></div></div><a href="/guide" className="textlink" style={{ marginTop: 25 }}>Open agent workflow<ArrowRight size={13} /></a></div></section><section className="panel" style={{ marginTop: 22 }}><div className="panel-top"><div><h2>Private source files</h2><p className="panel-subtitle">Optional originals for your agent. Never publicly visible.</p></div><LockKeyhole size={14} color="#8f9e7e" /></div><div className="cardbody"><label className="dropzone"><Files size={22} strokeWidth={1.3} /><strong>{busy === 'source' ? 'Uploading…' : 'Store an original company file'}</strong><small>XLSX, XLS, CSV, TSV or JSON · Up to 10 MB</small><input aria-label="Private original shortlist file" type="file" accept=".xlsx,.xls,.csv,.tsv,.json" disabled={!!busy} onChange={e => uploadSource(e.target.files?.[0])} /></label><div className="filelist">{files.slice(0, 6).map(file => <div className="fileitem" key={file.id}><a href={'/api/v1/uploads/' + file.id}><FileSpreadsheet size={14} />{file.filename}</a><small>{Math.ceil(file.size / 1024)} KB</small></div>)}</div></div></section></div></div>{rows.length > 0 && <section className="panel" style={{ marginTop: 24 }}><div className="panel-top"><div><h2>Shortlist preview {draft && <span className="badge">Version {draft.number}</span>}</h2><p className="panel-subtitle">Exactly six columns. Student order is preserved.</p></div>{draft && !published && <button className="primary" onClick={publishDraft} disabled={!!busy || (!!draft.warnings.length && !ack)}>{busy === 'publish' ? <Busy /> : <CheckCircle2 size={14} />}Publish shortlist</button>}{published && draft && <a className="primary" href={draft.public_url}>View published shortlist<ArrowRight size={13} /></a>}</div>{draft?.warnings.length ? <div className="cardbody" style={{ paddingBottom: 8 }}><Alert type="info" message={`${draft.warnings.length} records have missing fields or invalid email values. Missing CPI is preserved without inventing a value.`} /><ul className="warning-list">{draft.warnings.slice(0, 10).map(warning => <li key={warning.roll}>{warning.roll}: {warning.issues.join(', ')}</li>)}</ul>{!published && <label style={{ display: 'flex', gap: 9, fontSize: 12, color: '#7b7056', marginBottom: 15 }}><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} />I reviewed these records and want to publish them as supplied.</label>}</div> : null}<StudentTable rows={rows} /></section>}</>;
}

function AdminWorkspace() {
  const [master, setMaster] = useState<Master | null>(null), [keys, setKeys] = useState<any[]>([]), [label, setLabel] = useState('Gemini uploader'), [days, setDays] = useState('30'), [newKey, setNewKey] = useState(''), [busy, setBusy] = useState(''), [error, setError] = useState(''), [message, setMessage] = useState('');
  const reload = useCallback(() => { api<Master>('master/info').then(setMaster).catch(error => setError(error.message)); api('keys').then(data => setKeys(data.keys)).catch(error => setError(error.message)); }, []);
  useEffect(reload, [reload]);
  async function createKey(event: FormEvent) { event.preventDefault(); setBusy('key'); setError(''); try { const result = await send('keys', { label, expires_in_days: Number(days) }); setNewKey(result.key); reload(); } catch (error) { setError((error as Error).message); } finally { setBusy(''); } }
  async function replaceMaster(file?: File) { if (!file) return; setBusy('master'); setError(''); try { const rows = await readRows(file, true); const result = await send('master', { name: file.name, rows }, 'PUT'); setMessage(`Imported ${format(result.row_count)} student records. Existing published shortlists are unchanged.`); reload(); } catch (error) { setError((error as Error).message); } finally { setBusy(''); } }
  return <>{error && <Alert message={error} />}{message && <Alert message={message} type="success" />}<ManageShortlists /><div className="grid-two"><section className="panel"><div className="panel-top"><h2>Student master</h2><span className="pill"><LockKeyhole size={9} style={{ display: 'inline', marginRight: 4 }} />Private</span></div><div className="cardbody"><h3 className="smallheading"><FileSpreadsheet size={16} />{master?.name || 'No master imported'}</h3><p className="lede" style={{ fontSize: 11 }}>The authoritative file your agent reads. Only the six required columns are stored in the portal.</p><div className="master-stat"><div><strong>{master ? format(master.row_count) : '—'}</strong><small>Student records</small></div><div><strong>{master ? format(master.cpi_count) : '—'}</strong><small>CPI available</small></div></div>{master && <a href="/api/v1/master.csv" className="secondary" style={{ marginBottom: 22 }}><ArrowDownToLine size={13} />Download private master</a>}<label className="dropzone"><Upload size={22} strokeWidth={1.4} /><strong>{busy === 'master' ? 'Importing master…' : 'Import a new master version'}</strong><small>XLSX, CSV or JSON · Prior master versions are retained</small><input aria-label="Import student master" type="file" accept=".xlsx,.csv,.json" disabled={!!busy} onChange={e => replaceMaster(e.target.files?.[0])} /></label><p className="hero-note">Imported {master ? date(master.created_at) : '—'} · Replacing the master does not rewrite published lists.</p></div></section><section className="panel"><div className="panel-top"><h2>Issue an uploader key</h2><KeyRound size={16} color="#819771" /></div><form className="cardbody" onSubmit={createKey}><p className="lede" style={{ fontSize: 12, marginBottom: 19 }}>An agent can read the private master, upload sources and publish shortlists. It cannot manage keys or replace the master.</p><label className="field">Label<input required maxLength={100} value={label} onChange={e => setLabel(e.target.value)} /></label><label className="field" style={{ marginTop: 15 }}>Expires after<select value={days} onChange={e => setDays(e.target.value)}><option value="1">1 day</option><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option></select></label><button className="primary" disabled={!!busy} style={{ marginTop: 19 }}>{busy === 'key' ? <Busy /> : <KeyRound size={13} />}Create access key</button>{newKey && <><div className="keybox">{newKey}</div><p className="hero-note">Shown once. Save it securely before closing this page.</p><div className="top-actions"><button className="secondary" type="button" onClick={() => copy(newKey)}>Copy key<Clipboard size={12} /></button><button className="quiet" type="button" onClick={() => setNewKey('')}>Hide key<X size={12} /></button></div></>}</form></section></div><section className="panel" style={{ marginTop: 24 }}><div className="panel-top"><h2>Uploader access</h2><span className="subtle">Revocation takes effect immediately</span></div><div className="table-wrap"><table><thead><tr><th>Label</th><th>Created</th><th>Expiry</th><th>Status</th><th></th></tr></thead><tbody>{keys.map(key => <tr key={key.id}><td>{key.label}</td><td>{date(key.created_at)}</td><td>{date(key.expires_at)}</td><td><span className={'pill ' + (key.revoked_at || Date.parse(key.expires_at) < Date.now() ? 'orange' : '')}>{key.revoked_at ? 'Revoked' : Date.parse(key.expires_at) < Date.now() ? 'Expired' : 'Active'}</span></td><td>{!key.revoked_at && <button className="danger" disabled={!!busy} onClick={async () => { if (!confirm('Revoke this uploader key? Anyone using it will immediately lose access.')) return; setBusy('revoke'); try { await api('keys/' + key.id, { method: 'DELETE' }); reload(); } catch (error) { setError((error as Error).message); } finally { setBusy(''); } }}>Revoke</button>}</td></tr>)}{!keys.length && <tr><td colSpan={5} className="muted">No uploader keys yet. Create one for your agent above.</td></tr>}</tbody></table></div></section></>;
}

function Guide({ origin, heading }: { origin: string; heading: (title: string, eyebrow: string, subtitle: string, action?: ReactNode) => ReactNode }) {
  const [copied, setCopied] = useState(false);
  const prompt = `Read ${origin}/agent and follow its workflow. Use the separate uploader key I provide. Interpret the attached company shortlist, merge it with the private student master, and publish the six-column result for [company / role / round / season]. Preserve candidate order, explain unresolved records, and return the public shortlist URL.`;
  return <>{heading('Your agent, connected.', 'AGENT WORKFLOW', 'Let Gemini interpret the spreadsheet. Give it a clear workflow and a place to publish.', <a className="secondary" href="/agent" target="_blank"><BookOpen size={14} />Read agent guide</a>)}<div className="grid-two"><section className="panel"><div className="panel-top"><h2>One prompt to get started</h2><Sparkles size={16} color="#879a76" /></div><div className="cardbody"><p className="lede" style={{ fontSize: 12 }}>Create an uploader key in Owner settings. Attach your company file in the AI chat, share the key separately, and use this prompt.</p><div className="codebox">{prompt}</div><button className="primary" onClick={async () => { await copy(prompt); setCopied(true); setTimeout(() => setCopied(false), 2500); }}>{copied ? <Check size={13} /> : <Clipboard size={13} />}{copied ? 'Copied' : 'Copy starter prompt'}</button><div className="info-strip" style={{ marginTop: 24 }}><ShieldCheck size={18} /><div><h3>Give it a key, not your account password.</h3><p>Uploader keys expire and can be revoked. They grant source access and publishing, without owner controls.</p></div></div></div></section><section className="panel"><div className="panel-top"><h2>What happens next</h2></div><div className="cardbody"><div className="steps">{[['Read the source', 'The agent examines the uploaded file and identifies the actual candidates across relevant worksheets.'], ['Match with care', 'It reads the private master and resolves the shortlist using explicit rolls. Ambiguous identities are brought back to you.'], ['Upload a draft', 'It submits exactly six columns. The site validates the format without making matches or filling in data.'], ['Publish and verify', 'A new version is saved, published, and read back. Earlier versions remain available to the owner.']].map(([title, description], index) => <div className="step" key={title}><span className="step-num">{index + 1}</span><div><strong>{title}</strong>{description}</div></div>)}</div></div></section></div><section className="panel" style={{ marginTop: 24 }}><div className="panel-top"><div><h2>HTTP endpoints</h2><p className="panel-subtitle">Use Authorization: Bearer &lt;uploader-key&gt; for protected endpoints.</p></div><a className="textlink" href="/api/v1/openapi.json" target="_blank">OpenAPI JSON<ArrowRight size={13} /></a></div><div className="cardbody"><div className="endpoints">{[['GET', '/api/v1/shortlists', 'Public company index'], ['GET', '/api/v1/shortlists/{id}', 'Published shortlist'], ['GET', '/api/v1/master', 'Private master and its version ID'], ['POST', '/api/v1/uploads', 'Private original file'], ['POST', '/api/v1/shortlists', 'New shortlist and draft'], ['POST', '/api/v1/shortlists/{id}/versions', 'Another immutable draft'], ['POST', '/api/v1/shortlists/{id}/publish', 'Publish a checked version']].map(([method, path, description]) => <div className="endpoint" key={path + method}><span className={'method ' + method.toLowerCase()}>{method}</span><span style={{ flex: 1, overflowWrap: 'anywhere' }}>{path}</span><span className="muted" style={{ maxWidth: '35%', fontFamily: 'Arial' }}>{description}</span></div>)}</div></div></section><div className="info-strip"><CircleHelp size={20} /><div><h3>Works with capable agents; no embedded AI subscription.</h3><p>The agent must be able to read files and make authenticated HTTP requests or operate the upload page. If your AI chat cannot upload to a website, ask it for the prepared Excel file and upload it here yourself. A public page is view-only; its contents can still be copied.</p></div></div><details style={{ marginTop: 22, color: '#718465', fontSize: 12 }}><summary>View the full reusable instructions</summary><pre className="codebox light">{agentGuide(origin)}</pre></details></>;
}

function VersionHistory({ list, onError }: { list: Listing; onError: (error: string) => void }) {
  const [versions, setVersions] = useState<Version[]>([]), [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  async function load() { try { const result = await api(`shortlists/${list.id}/versions`); setVersions(result.versions); setOpen(true); } catch (error) { onError((error as Error).message); } }
  return <section className="panel" style={{ marginTop: 24 }}><div className="panel-top"><h2>Version history <span className="badge">Owner only</span></h2><button className="secondary" onClick={load}>View versions<Layers size={13} /></button></div>{open && <div className="cardbody">{versions.map(version => <div className="versionrow" key={version.id}><div>Version {version.number} · {format(version.row_count)} students{version.id === list.published_version_id && <span className="badge">Current</span>}<small>{version.published_at ? 'Published ' + date(version.published_at) : 'Private draft'} · {version.processing_notes || 'No processing notes'}</small></div>{version.published_at && version.id !== list.published_version_id && <button disabled={busy} className="secondary" onClick={async () => { if (!confirm(`Restore version ${version.number} as the public shortlist?`)) return; setBusy(true); try { await send(`shortlists/${list.id}/restore`, { version_id: version.id, expected_current_version_id: list.published_version_id, acknowledge_warnings: true }); location.reload(); } catch (error) { onError((error as Error).message); } finally { setBusy(false); } }}>Restore</button>}</div>)}</div>}</section>;
}

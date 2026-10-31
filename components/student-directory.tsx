import { useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import { ArrowRight, Eye, EyeOff, LoaderCircle, Search, RotateCcw, UserRound } from 'lucide-react';
import type { StudentEvent, StudentProfile, StudentSearchResponse } from '../lib/student-directory';
import { groupShortlists } from '../lib/shortlist-groups';

type Reader = <T = any>(path: string, options?: RequestInit) => Promise<T>;
function follow(event: MouseEvent<HTMLAnchorElement>, action: () => void) {
  if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault(); action();
}
export function studentProfileRoll(path: string) {
  try { return path.match(/^\/students\/([^/]+)\/?$/)?.[1] ? decodeURIComponent(path.match(/^\/students\/([^/]+)\/?$/)![1]) : null; }
  catch { return null; }
}

export function StudentSearch({ request, onOpen }: { request: Reader; onOpen: (roll: string) => void }) {
  const [query, setQuery] = useState(''), [result, setResult] = useState<StudentSearchResponse | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  async function search(event?: FormEvent, offset = 0) {
    event?.preventDefault();
    const value = offset ? result?.query || '' : query.trim();
    if (value.length < 2) { setError('Enter at least two characters of your name or roll number.'); return; }
    active.current?.abort(); const controller = new AbortController(); active.current = controller;
    setBusy(true); setError(''); if (!offset) setResult(null);
    try {
      const data = await request<StudentSearchResponse>('students?q=' + encodeURIComponent(value) + '&offset=' + offset, { signal: controller.signal });
      if (!controller.signal.aborted) setResult(previous => offset && previous ? { ...data, students: [...previous.students, ...data.students] } : data);
    } catch (error) { if (!controller.signal.aborted) setError((error as Error).message); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  return <section className="panel student-search-panel" aria-label="Find your shortlists">
    <div className="student-search-intro"><span className="student-search-icon"><UserRound size={20} /></span><div><h2>Find your shortlists</h2><p>You can search for your name directly, too. See your companies, roles and rounds in one place.</p></div></div>
    <form className="student-search-form" onSubmit={event => void search(event)}><label className="search"><Search size={16} /><input aria-label="Search student name or roll" placeholder="Your name or roll number…" maxLength={160} value={query} onChange={event => setQuery(event.target.value)} /></label><button className="primary" disabled={busy || query.trim().length < 2}>{busy ? <LoaderCircle size={14} className="spinner" /> : <Search size={14} />}Search students</button></form>
    {error && <p className="notice error" role="alert">{error}</p>}
    {busy && !result && <p className="student-search-status" role="status"><LoaderCircle size={14} className="spinner" />Searching published shortlists…</p>}
    {result && <div className="student-search-results" aria-live="polite"><p className="student-search-status">{result.students.length ? `${result.students.length}${result.has_more ? '+' : ''} ${result.students.length === 1 ? 'student' : 'students'} found for “${result.query}”. Select your roll number.` : `No published shortlist entries found for “${result.query}”.`}</p>
      {result.students.map(({ student, confirmed_count, possible_count }) => <a className="student-search-result" key={student.roll} href={'/students/' + encodeURIComponent(student.roll)} onClick={event => follow(event, () => onOpen(student.roll))}><span><strong>{student.name || student.roll}</strong><small>{student.roll} · {student.programme || '—'} · {student.branch || '—'}</small><span className="student-result-count">{confirmed_count} confirmed {confirmed_count === 1 ? 'shortlist' : 'shortlists'}{possible_count ? ` · ${possible_count} possible ${possible_count === 1 ? 'match' : 'matches'}` : ''}</span></span><ArrowRight size={17} /></a>)}
      {result.has_more && <button className="secondary" disabled={busy} onClick={() => void search(undefined, result.next_offset!)}>{busy && <LoaderCircle size={13} className="spinner" />}Show more students</button>}
    </div>}
  </section>;
}

function StudentCompanies({ events, onOpen, possible = false }: { events: StudentEvent[]; onOpen: (id: string) => void; possible?: boolean }) {
  const groups = useMemo(() => groupShortlists(events).company_groups, [events]);
  return <div className="student-companies">{groups.map(group => <section className="panel student-company" key={group.key}><div className="panel-top"><h2><span className="company-logo">{group.company[0]}</span>{group.company}</h2><span className="subtle">{group.shortlists.length} {group.shortlists.length === 1 ? 'shortlist' : 'shortlists'}</span></div><div className="table-wrap"><table><thead><tr><th>Round</th><th>Role</th><th>Season</th><th>Date added</th><th></th></tr></thead><tbody>{group.shortlists.map(list => <tr key={list.id}><td><a className="textlink" href={'/?list=' + encodeURIComponent(list.id)} onClick={event => follow(event, () => onOpen(list.id))}>{list.round}</a>{possible && <div className="student-possible-label">Possible match</div>}</td><td>{list.role || 'Unknown'}</td><td>{list.season}</td><td className="muted">{new Date(list.added_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })}</td><td><a className="student-event-open" aria-label={`Open ${group.company} ${list.round} shortlist`} href={'/?list=' + encodeURIComponent(list.id)} onClick={event => follow(event, () => onOpen(list.id))}><ArrowRight size={16} /></a></td></tr>)}</tbody></table></div></section>)}</div>;
}

export function StudentProfilePage({ roll, request, onOpen }: { roll: string; request: Reader; onOpen: (id: string) => void }) {
  const [result, setResult] = useState<{ roll: string; data?: StudentProfile; error?: string } | null>(null), [attempt, setAttempt] = useState(0), [showCpi, setShowCpi] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); setShowCpi(false);
    request<StudentProfile>('students/' + encodeURIComponent(roll), { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setResult({ roll, data }); })
      .catch(error => { if (!controller.signal.aborted) setResult({ roll, error: error.message }); });
    return () => controller.abort();
  }, [roll, request, attempt]);
  const data = result?.roll === roll ? result.data : undefined, error = result?.roll === roll ? result.error : undefined;
  if (!data) return error ? <section className="panel cardbody"><p className="notice error" role="alert">{error}</p><button className="secondary" onClick={() => { setResult(null); setAttempt(value => value + 1); }}><RotateCcw size={14} />Try again</button></section> : <section className="panel shortlist-loading" role="status" aria-busy="true"><LoaderCircle size={25} className="spinner" />Loading student shortlists…</section>;
  return <>
    <div className="heading-row"><div><div className="eyebrow">STUDENT SHORTLISTS</div><h1>{data.student.name || roll}</h1><p className="lede">{data.student.roll} · {data.student.programme || '—'}</p></div><button className="secondary" aria-pressed={showCpi} aria-label={`${showCpi ? 'Hide' : 'Show'} student CPI`} onClick={() => setShowCpi(value => !value)}>{showCpi ? <EyeOff size={14} /> : <Eye size={14} />}{showCpi ? 'Hide CPI' : 'Show CPI'}</button></div>
    <section className="panel student-profile-info" aria-label="Student information"><dl><div><dt>Programme</dt><dd>{data.student.programme || '—'}</dd></div><div><dt>Branch</dt><dd>{data.student.branch || '—'}</dd></div><div><dt>CPI</dt><dd className={showCpi ? '' : 'cpi-hidden'}>{showCpi ? data.student.cpi === null ? '—' : data.student.cpi : '...'}</dd></div><div><dt>Email</dt><dd>{data.student.email || '—'}</dd></div></dl></section>
    <section className="stats" aria-label="Student shortlist statistics"><div className="stat"><div><div className="stat-number">{data.company_count}</div><span className="stat-label">Companies</span></div></div><div className="stat"><div><div className="stat-number">{data.confirmed.length}</div><span className="stat-label">Confirmed shortlists</span></div></div><div className="stat"><div><div className="stat-number">{data.possible.length}</div><span className="stat-label">Possible matches</span></div></div></section>
    <div className="student-profile-section"><h2>Confirmed shortlists</h2>{data.confirmed.length ? <StudentCompanies events={data.confirmed} onOpen={onOpen} /> : <p className="muted student-profile-empty">No confirmed shortlist entries.</p>}</div>
    {!!data.possible.length && <div className="student-profile-section student-profile-possible"><h2>Possible matches</h2><p className="student-profile-caption">You could be one of the possible candidates in these shortlists.</p><StudentCompanies events={data.possible} onOpen={onOpen} possible /></div>}
  </>;
}

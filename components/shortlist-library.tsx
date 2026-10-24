import { useEffect, useState, type ReactNode } from 'react';
import { ArrowRight, ChevronRight } from 'lucide-react';
import type { CompanyGroup } from '@/lib/shortlist-groups';
import Collapsible from './collapsible';

type Listing = { id: string; company: string; role: string; round: string; season: string; added_at: string; row_count: number | null; unresolved_count?: number };
const date = (value: string) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value));
const count = (value: number) => `${value} ${value === 1 ? 'shortlist' : 'shortlists'}`;

function Fold({ label, children, filterKey, className, control }: { label: ReactNode; children: ReactNode; filterKey: string; className: string; control: string }) {
  const [open, setOpen] = useState(Boolean(filterKey));
  useEffect(() => { setOpen(Boolean(filterKey)); }, [filterKey]);
  return <section className={className}>
    <button type="button" className="group-toggle" aria-expanded={open} aria-controls={control} onClick={() => setOpen(value => !value)}>
      <ChevronRight className={'group-chevron' + (open ? ' expanded' : '')} size={16} />{label}
    </button>
    <Collapsible open={open} id={control}>{children}</Collapsible>
  </section>;
}

export default function ShortlistLibrary({ groups, filterKey }: { groups: CompanyGroup<Listing>[]; filterKey: string }) {
  return <div className="company-groups">
    {groups.map((company, companyIndex) => <Fold key={company.key} className="company-group" filterKey={filterKey} control={`company-${companyIndex}`} label={<>
      <span className="company-logo">{company.company[0]}</span><span className="group-label company-label">{company.company}</span><span className="company-group-count">{count(company.shortlists.length)}</span>
    </>}>
      {company.rounds.map((round, roundIndex) => <Fold key={round.key} className="round-group" filterKey={filterKey} control={`round-${companyIndex}-${roundIndex}`} label={<>
        <span className="group-label">{round.round}</span><span className="company-group-count">{count(round.roles.reduce((sum, role) => sum + role.shortlists.length, 0))}</span>
      </>}>
        {round.roles.map((role, roleIndex) => <Fold key={role.key} className="role-group" filterKey={filterKey} control={`role-${companyIndex}-${roundIndex}-${roleIndex}`} label={<>
          <span className="group-label">{role.role}</span><span className="company-group-count">{count(role.shortlists.length)}</span>
        </>}>
          <div className="table-wrap"><table className="company-group-table"><thead><tr><th>Shortlist / event</th><th>Students</th><th>Date added</th><th></th></tr></thead><tbody>
            {role.shortlists.map(list => <tr className="clickable" key={list.id} onClick={() => { location.href = '/?list=' + list.id; }}>
              <td><a className="shortlist-position" href={'/?list=' + list.id} aria-label={`${company.company}: ${role.role} — ${list.round}`}>{list.round}</a><div className="subtle">{list.season}</div></td>
              <td>{(list.row_count || 0) + (list.unresolved_count || 0)}{!!list.unresolved_count && <div className="review-count">{list.unresolved_count} ambiguous</div>}</td>
              <td className="muted">{date(list.added_at)}</td><td><ArrowRight size={15} color="var(--muted)" /></td>
            </tr>)}
          </tbody></table></div>
        </Fold>)}
      </Fold>)}
    </Fold>)}
    {!groups.length && <p className="company-groups-empty muted">No shortlists match your search.</p>}
  </div>;
}

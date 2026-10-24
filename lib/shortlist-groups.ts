type GroupableShortlist = { id: string; company: string; role?: string; round: string; added_at: string };
type GroupedRow<T> = T & { round_categories: string[] };
export type RoleGroup<T> = { key: string; role: string; added_at: string; shortlists: GroupedRow<T>[] };
export type RoundGroup<T> = { key: string; round: string; added_at: string; roles: RoleGroup<T>[] };
export type CompanyGroup<T extends GroupableShortlist> = {
  key: string;
  company: string;
  added_at: string;
  shortlists: (T & { round_categories: string[] })[];
  rounds: RoundGroup<T>[];
};

const categoryOrder = ['Test', 'Group Discussion', 'Interview', 'Buddy Round', 'Case Study', 'Presentation', 'Screening'];
const tidy = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ');
const words = (value: string) => tidy(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Conservative display identity: spelling/case/legal suffix variants, never fuzzy names. */
export function companyKey(value: string) {
  const key = words(value.replace(/&/g, ' and ').replace(/\+/g, ' plus ').replace(/#/g, ' sharp '));
  const base = key.replace(/(?:\s+(?:private|pvt|limited|ltd|incorporated|inc|corporation|corp|llc|llp|plc))+$/, '');
  return base || key;
}

/** Classify round labels for browsing without changing the original event identity. */
export function roundCategories(value: string): string[] {
  const text = words(value), found = new Set<string>();
  if (/\b(?:tests?|assessments?|oa)\b|\bo a\b|\b(?:aptitude|coding|written|psychometric)\s+(?:rounds?|screening)\b/.test(text)) found.add('Test');
  if (/\bgroup discussions?\b|\bgd\b|\bg d\b/.test(text)) found.add('Group Discussion');
  const buddy = /\bbuddy\b/.test(text);
  if (/\binterviews?\b|\bpi\b|\bp i\b|^(?:hr|h r)(?: round)?(?: \d+)?$/.test(buddy ? text.replace(/\bbuddy\s+interviews?\b/g, '') : text)) found.add('Interview');
  if (buddy) found.add('Buddy Round');
  if (/\bcase (?:stud(?:y|ies)|discussion)s?\b/.test(text)) found.add('Case Study');
  if (/\bpresentations?\b/.test(text)) found.add('Presentation');
  if (/\b(?:resume|cv) (?:screening|shortlists?)\b|^screening(?: round)?$/.test(text)) found.add('Screening');
  return found.size ? categoryOrder.filter(category => found.has(category)) : [tidy(value) || 'Other'];
}

export function groupShortlists<T extends GroupableShortlist>(rows: readonly T[]) {
  const groups = new Map<string, CompanyGroup<T>>();
  // Sorting a copy preserves the API's source records and the caller's ordering.
  const sorted = [...rows].sort((a, b) => Date.parse(b.added_at) - Date.parse(a.added_at));
  for (const row of sorted) {
    const key = companyKey(row.company) || `unnamed:${row.id}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, company: tidy(row.company), added_at: row.added_at, shortlists: [], rounds: [] };
      groups.set(key, group);
    }
    const categories = roundCategories(row.round), grouped = { ...row, round_categories: categories };
    group.shortlists.push(grouped);
    // A combined GD / Interview source appears once, under a combined stage.
    const round = categories.join(' + '), roundKey = round.toLowerCase();
    let roundGroup = group.rounds.find(value => value.key === roundKey);
    if (!roundGroup) { roundGroup = { key: roundKey, round, added_at: row.added_at, roles: [] }; group.rounds.push(roundGroup); }
    const role = tidy(row.role || '') || 'Unspecified role', roleKey = role.toLowerCase();
    let roleGroup = roundGroup.roles.find(value => value.key === roleKey);
    if (!roleGroup) { roleGroup = { key: roleKey, role, added_at: row.added_at, shortlists: [] }; roundGroup.roles.push(roleGroup); }
    roleGroup.shortlists.push(grouped);
  }
  const company_groups = [...groups.values()].sort((a, b) => Date.parse(b.added_at) - Date.parse(a.added_at) || a.key.localeCompare(b.key));
  const categories = new Set(company_groups.flatMap(group => group.shortlists.flatMap(row => row.round_categories)));
  const rank = (value: string) => categoryOrder.includes(value) ? categoryOrder.indexOf(value) : categoryOrder.length;
  const round_categories = [...categories].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, 'en', { sensitivity: 'base' }));
  return { company_groups, round_categories };
}

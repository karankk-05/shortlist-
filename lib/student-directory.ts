import { COLUMNS, type StudentRow } from './records.ts';
import type { PublicShortlistData } from './identity-review';
import { companyKey, roundCategories } from './shortlist-groups.ts';

export type StudentSearchResult = { student: Omit<StudentRow, 'cpi'>; confirmed_count: number; possible_count: number };
export type StudentSearchResponse = { students: StudentSearchResult[]; query: string; has_more: boolean; next_offset: number | null };
export type StudentEvent = { id: string; company: string; role: string; round: string; season: string; added_at: string; match: 'confirmed' | 'possible'; round_categories: string[] };
export type StudentProfile = { student: StudentRow; confirmed: StudentEvent[]; possible: StudentEvent[]; company_count: number };
export type DirectoryEntry = { roll: string; kind: 'confirmed' | 'possible'; position: number; source_name: string; row: StudentRow };

/** The index contains only data already visible in a published shortlist. Keep
 * private master records and reconciliation metadata out of this projection. */
export function directoryEntries(data: PublicShortlistData): DirectoryEntry[] {
  const clean = (row: StudentRow) => Object.fromEntries(COLUMNS.map(key => [key, row[key]])) as StudentRow;
  return [
    ...data.rows.map((row, position) => ({ roll: row.roll, kind: 'confirmed' as const, position, source_name: '', row: clean(row) })),
    ...data.unresolved_candidates.flatMap((entry, position) => entry.possible_matches.map(row => ({ roll: row.roll, kind: 'possible' as const, position, source_name: entry.source_name, row: clean(row) }))),
  ];
}

export async function indexStudentVersion(db: D1Database, versionId: string, data: PublicShortlistData) {
  const entries = directoryEntries(data);
  // Bounded JSON parameters avoid per-student round trips and D1 value limits.
  const insertions = [];
  for (let start = 0; start < entries.length; start += 750) insertions.push(db.prepare(`INSERT INTO student_search_entries (version_id, roll, kind, position, name, source_name, email, row_data)
      SELECT ?, json_extract(value, '$.roll'), json_extract(value, '$.kind'), json_extract(value, '$.position'),
        json_extract(value, '$.row.name'), json_extract(value, '$.source_name'), json_extract(value, '$.row.email'), json_extract(value, '$.row')
      FROM json_each(?)`).bind(versionId, JSON.stringify(entries.slice(start, start + 750))));
  await db.batch([
    db.prepare('INSERT OR IGNORE INTO student_search_versions (version_id) VALUES (?)').bind(versionId),
    db.prepare('DELETE FROM student_search_entries WHERE version_id = ?').bind(versionId),
    ...insertions,
  ]);
  return entries.length;
}

export function directoryQuery(query: string) {
  return query.normalize('NFKC').trim().replace(/\s+/g, ' ');
}
export function searchTokens(query: string) {
  return directoryQuery(query).toLowerCase().split(' ').filter(Boolean).map(value => '%' + value.replace(/[\\%_]/g, '\\$&') + '%');
}
export function searchExpression(query: string) {
  return directoryQuery(query).split(' ').filter(Boolean).map(value => '"' + value.replaceAll('"', '""') + '"*').join(' AND ');
}

/** Each visible version represents one shortlist, even if an ambiguity contains
 * several source entries for the same roll. Confirmed membership takes priority. */
export function buildStudentProfile(rows: { row_data: string; kind: 'confirmed' | 'possible'; id: string; company: string; role: string; round: string; season: string; added_at: string }[]): StudentProfile | null {
  if (!rows.length) return null;
  const ordered = [...rows].sort((a, b) => Number(a.kind !== 'confirmed') - Number(b.kind !== 'confirmed') || b.added_at.localeCompare(a.added_at) || a.id.localeCompare(b.id));
  const events = new Map<string, StudentEvent>();
  for (const row of ordered) if (!events.has(row.id)) events.set(row.id, { id: row.id, company: row.company, role: row.role, round: row.round, season: row.season, added_at: row.added_at, match: row.kind, round_categories: roundCategories(row.round) });
  const values = [...events.values()].sort((a, b) => b.added_at.localeCompare(a.added_at) || a.id.localeCompare(b.id));
  return { student: JSON.parse(ordered[0].row_data), confirmed: values.filter(row => row.match === 'confirmed'), possible: values.filter(row => row.match === 'possible'), company_count: new Set(values.map(row => companyKey(row.company))).size };
}

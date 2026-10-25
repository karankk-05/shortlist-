import type { StudentRow } from './records';
import type { PublicIdentityReview } from './identity-review';

export type StudentFilters = {
  query: string; programme: string; branch: string; batch: string;
  cpiStatus: 'all' | 'available' | 'missing'; minimumCpi: string; maximumCpi: string;
};
export type StudentSort = keyof StudentRow | 'source';
export type SortDirection = 'asc' | 'desc';
export const EMPTY_STUDENT_FILTERS: StudentFilters = {
  query: '', programme: '', branch: '', batch: '', cpiStatus: 'all', minimumCpi: '', maximumCpi: '',
};
const collator = new Intl.Collator('en-IN', { numeric: true, sensitivity: 'base' });
const searchQuery = (value: string) => value.trim().toLocaleLowerCase('en-IN');
const matchesStudentQuery = (row: StudentRow, query: string) => [row.name, row.roll, row.programme, row.branch, row.email].some(value => value.toLocaleLowerCase('en-IN').includes(query));

/** Search individual source candidates while preserving all alternatives for a matched entry. */
export function searchPossibleCandidates(entries: readonly PublicIdentityReview[], search: string): PublicIdentityReview[] {
  const query = searchQuery(search);
  return entries.filter(entry => !query || entry.source_name.toLocaleLowerCase('en-IN').includes(query) || entry.possible_matches.some(row => matchesStudentQuery(row, query)));
}

export function studentBatch(row: StudentRow): string {
  const match = row.roll.match(/^(\d{2})\d{4,7}$/);
  return match ? 'Y' + match[1] : '';
}

export function cpiRangeError(filters: StudentFilters): string {
  for (const value of [filters.minimumCpi, filters.maximumCpi]) {
    if (value !== '' && (!Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 10)) return 'CPI limits must be between 0 and 10.';
  }
  if (filters.minimumCpi !== '' && filters.maximumCpi !== '' && Number(filters.minimumCpi) > Number(filters.maximumCpi)) return 'Minimum CPI must be less than or equal to maximum CPI.';
  return '';
}

export function viewStudents(rows: readonly StudentRow[], filters: StudentFilters, sort: StudentSort = 'source', direction: SortDirection = 'asc'): StudentRow[] {
  if (cpiRangeError(filters)) return [];
  const query = searchQuery(filters.query);
  const minimum = filters.minimumCpi === '' ? null : Number(filters.minimumCpi);
  const maximum = filters.maximumCpi === '' ? null : Number(filters.maximumCpi);
  const filtered = rows.filter(row =>
    (!filters.programme || row.programme === filters.programme) &&
    (!filters.branch || row.branch === filters.branch) &&
    (!filters.batch || studentBatch(row) === filters.batch) &&
    (!query || matchesStudentQuery(row, query)) &&
    (filters.cpiStatus !== 'available' || row.cpi !== null) &&
    (filters.cpiStatus !== 'missing' || row.cpi === null) &&
    (minimum === null || (row.cpi !== null && row.cpi >= minimum)) &&
    (maximum === null || (row.cpi !== null && row.cpi <= maximum))
  );
  if (sort === 'source') return filtered;
  return filtered.map((row, index) => ({ row, index })).sort((a, b) => {
    const left = a.row[sort], right = b.row[sort];
    const leftMissing = left === null || left === '', rightMissing = right === null || right === '';
    // Missing values stay last in either direction. A CPI of zero is a value.
    if (leftMissing !== rightMissing) return leftMissing ? 1 : -1;
    const difference = leftMissing ? 0 : typeof left === 'number' && typeof right === 'number' ? left - right : collator.compare(String(left), String(right));
    return (direction === 'asc' ? difference : -difference) || a.index - b.index;
  }).map(item => item.row);
}

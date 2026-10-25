import { COLUMNS, InputError, type StudentRow } from './records.ts';

export type IdentityReview = {
  source_name: string;
  source_index: number;
  reason: string;
  possible_matches: StudentRow[];
};
export type ShortlistData = { rows: StudentRow[]; unresolved_candidates: IdentityReview[] };
export type PublicIdentityReview = Pick<IdentityReview, 'source_name' | 'possible_matches'>;
export type PublicShortlistData = { rows: StudentRow[]; unresolved_candidates: PublicIdentityReview[] };

function text(value: unknown, label: string, maximum: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new InputError(`Invalid ${label}.`);
  return value.trim();
}

/** An agent proposes identifiers; only the pinned master supplies alternative details. */
export function validateIdentityReviews(input: unknown, master: readonly StudentRow[]): IdentityReview[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 1000) throw new InputError('unresolved_candidates must be an array of at most 1,000 source entries.');
  const byRoll = new Map(master.map(row => [row.roll.toUpperCase(), row]));
  const positions = new Set<number>();
  return input.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new InputError(`Invalid unresolved candidate ${index + 1}.`);
    const keys = ['source_name', 'source_index', 'reason', 'possible_rolls'];
    if (Object.keys(entry).length !== keys.length || keys.some(key => !(key in entry))) throw new InputError('Unresolved candidates require exactly source_name, source_index, reason and possible_rolls.');
    const source_name = text(entry.source_name, 'source_name', 240), reason = text(entry.reason, 'identity review reason', 500);
    if (!Number.isSafeInteger(entry.source_index) || entry.source_index < 1 || entry.source_index > 100000 || positions.has(entry.source_index)) throw new InputError('Each unresolved candidate needs a distinct positive source_index (original candidate position).');
    positions.add(entry.source_index);
    if (!Array.isArray(entry.possible_rolls) || entry.possible_rolls.length > 20) throw new InputError('Supply up to 20 possible_rolls per unresolved candidate; use [] when no supported match exists.');
    const seen = new Set<string>();
    const possible_matches = entry.possible_rolls.map((value: unknown) => {
      const roll = text(value, 'possible roll', 40).toUpperCase(), row = byRoll.get(roll);
      if (!row) throw new InputError(`Possible roll ${roll} is absent from the selected master.`);
      if (seen.has(roll)) throw new InputError('Duplicate possible roll within an unresolved candidate.');
      seen.add(roll);
      return { ...row };
    });
    return { source_name, source_index: entry.source_index, reason, possible_matches };
  }).sort((a, b) => a.source_index - b.source_index);
}

export function readShortlistData(value: StudentRow[] | ShortlistData): ShortlistData {
  return Array.isArray(value) ? { rows: value, unresolved_candidates: [] } : value;
}

/** Source positions and reconciliation reasons are private, including for old snapshots. */
export function publicShortlistData(data: ShortlistData): PublicShortlistData {
  return { rows: data.rows, unresolved_candidates: data.unresolved_candidates.map(({ source_name, possible_matches }) => ({ source_name, possible_matches })) };
}

/** Flat six-column exports preserve one source candidate, without asserting an alternative. */
export function exportCandidateRows(data: PublicShortlistData): StudentRow[] {
  return [...data.rows, ...data.unresolved_candidates.map(entry => ({ name: entry.source_name, roll: '', programme: '', branch: '', cpi: null, email: '' }))];
}

/** Alternatives are a set, not several confirmed candidates or a confidence ranking. */
export function sameIdentityReviews(first: IdentityReview[], second: IdentityReview[]) {
  const canonical = (entries: IdentityReview[]) => JSON.stringify([...entries].sort((a, b) => a.source_index - b.source_index).map(entry => ({
    source_name: entry.source_name, source_index: entry.source_index, reason: entry.reason,
    matches: [...entry.possible_matches].sort((a, b) => a.roll.localeCompare(b.roll)).map(row => COLUMNS.map(column => row[column])),
  })));
  return canonical(first) === canonical(second);
}

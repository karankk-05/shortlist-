import test from 'node:test';
import assert from 'node:assert/strict';
import { exportCandidateRows, readShortlistData, sameIdentityReviews, validateIdentityReviews } from '../lib/identity-review.ts';
import { validateRows } from '../lib/records.ts';
const master = [
  { name: 'Synthetic Name', roll: '0230001', programme: 'BTech', branch: 'Synthetic A', cpi: 0, email: 'a@example.invalid' },
  { name: 'Synthetic Name', roll: '240002', programme: 'BS', branch: 'Synthetic B', cpi: null, email: 'b@example.invalid' },
];
const pending = { source_name: 'Synthetic Name', source_index: 3, reason: 'Source has no roll and two master names match.', possible_rolls: master.map(row => row.roll) };
test('one ambiguous source entry snapshots all alternatives from the pinned master', () => {
  const result = validateIdentityReviews([pending], master);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].possible_matches, master);
  assert.notEqual(result[0].possible_matches[0], master[0]);
  assert.equal(result[0].possible_matches[0].cpi, 0);
  assert.equal(result[0].possible_matches[1].cpi, null);
});
test('unmatched candidates and single uncertain alternatives remain represented', () => {
  assert.deepEqual(validateIdentityReviews([{ ...pending, possible_rolls: [] }], master)[0].possible_matches, []);
  assert.equal(validateIdentityReviews([{ ...pending, possible_rolls: [master[0].roll] }], master)[0].possible_matches.length, 1);
  assert.deepEqual(validateRows([], true).rows, []);
  assert.throws(() => validateRows([]));
});
test('rejects fabricated option details, absent rolls, duplicate positions and invalid metadata', () => {
  for (const entry of [
    { ...pending, possible_matches: master }, { ...pending, possible_rolls: ['unknown'] },
    { ...pending, possible_rolls: [master[0].roll, master[0].roll] },
    { ...pending, source_index: 0 }, { ...pending, reason: '' }, { ...pending, source_name: '' },
  ]) assert.throws(() => validateIdentityReviews([entry], master));
  assert.throws(() => validateIdentityReviews([pending, pending], master));
});
test('legacy snapshots stay readable; flat exports retain one blank-identity row per ambiguity', () => {
  assert.deepEqual(readShortlistData(master), { rows: master, unresolved_candidates: [] });
  const data = { rows: [master[0]], unresolved_candidates: validateIdentityReviews([pending], master) };
  const exported = exportCandidateRows(data);
  assert.equal(exported.length, 2);
  assert.deepEqual(exported[1], { name: pending.source_name, roll: '', programme: '', branch: '', cpi: null, email: '' });
  assert.deepEqual(data.unresolved_candidates[0].possible_matches, master);
});
test('duplicate detection ignores alternative order but retains uncertainty and source facts', () => {
  const original = validateIdentityReviews([pending], master);
  assert.equal(sameIdentityReviews(original, validateIdentityReviews([{ ...pending, possible_rolls: [...pending.possible_rolls].reverse() }], master)), true);
  assert.equal(sameIdentityReviews(original, []), false);
  assert.equal(sameIdentityReviews(original, validateIdentityReviews([{ ...pending, possible_rolls: [] }], master)), false);
});

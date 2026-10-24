import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRows, csvRows, sameShortlistRows, toCSV } from '../lib/records.ts';
const student = { name: 'Synthetic Student', roll: '0230001', programme: 'BTech', branch: 'Synthetic department', cpi: null, email: 'qa@example.invalid' };
test('preserves text identities, source order, blank and zero CPI', () => {
  const result = validateRows([student, { ...student, roll: '230002', cpi: 0 }]);
  assert.equal(result.rows[0].roll, '0230001'); assert.equal(result.rows[0].cpi, null); assert.equal(result.rows[1].cpi, 0);
});
test('duplicate results ignore row order but preserve candidate identities, fields and missing CPI', () => {
  const second = { ...student, roll: '230002', cpi: 0 };
  assert.equal(sameShortlistRows([student, second], [second, { ...student }]), true);
  assert.equal(sameShortlistRows([student], [second]), false);
  assert.equal(sameShortlistRows([student], [{ ...student, cpi: 0 }]), false);
  assert.equal(sameShortlistRows([student], [{ ...student, email: 'changed@example.invalid' }]), false);
  assert.equal(sameShortlistRows([student], [student, second]), false);
});
test('does not infer missing values and reports observed missing fields', () => {
  const result = validateRows([{ ...student, name: '', branch: '' }]);
  assert.equal(result.rows[0].name, ''); assert.deepEqual(result.warnings[0].issues, ['missing_name', 'missing_branch']);
});
test('rejects extra personal fields and duplicate rolls', () => {
  assert.throws(() => validateRows([{ ...student, photo: 'not-allowed' }]), /exactly/);
  assert.throws(() => validateRows([student, student]), /Duplicate roll/);
});
test('rejects invalid CPI without hiding the problem as zero', () => {
  for (const cpi of ['unknown', -1, 11, true, Infinity, ' ']) assert.throws(() => validateRows([{ ...student, cpi }]));
});
test('CSV parser preserves quotes, commas and newlines', () => {
  const result = csvRows('name,roll,programme,branch,cpi,email\r\n"Name, \"\"Q\"\"\nTwo",230001,BTech,Test,,qa@example.invalid\r\n');
  assert.equal(result[0].name, 'Name, "Q"\nTwo'); assert.equal(result[0].cpi, '');
});
test('CSV rejects broken records and neutralizes formula cells on download', () => {
  assert.throws(() => csvRows('a,b\n1,2,3'), /column count/);
  assert.throws(() => csvRows('a,b\n"open,2'), /Unclosed/);
  assert.match(toCSV([{ ...student, name: '=2+2' }]), /'\=2\+2/);
  assert.equal(student.name, 'Synthetic Student');
});

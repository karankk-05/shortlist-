export const COLUMNS = ['name', 'roll', 'programme', 'branch', 'cpi', 'email'] as const;
export type StudentRow = { name: string; roll: string; programme: string; branch: string; cpi: number | null; email: string };
export type RowWarning = { row: number; roll: string; issues: string[] };
export class InputError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

export function validateRows(input: unknown): { rows: StudentRow[]; warnings: RowWarning[] } {
  if (!Array.isArray(input) || !input.length || input.length > 15000) throw new InputError('Provide between 1 and 15,000 student rows.');
  const seen = new Set<string>();
  const warnings: RowWarning[] = [];
  const rows = input.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError(`Row ${index + 1} must be an object.`);
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== COLUMNS.length || COLUMNS.some(key => !(key in record))) {
      throw new InputError(`Row ${index + 1}: use exactly these columns: ${COLUMNS.join(', ')}. The site does not merge or infer columns.`);
    }
    const result: Record<string, unknown> = {};
    for (const key of COLUMNS) {
      if (key === 'cpi') continue;
      if (typeof record[key] !== 'string') throw new InputError(`Row ${index + 1}: ${key} must be text; keep roll numbers as strings.`);
      const text = (record[key] as string).trim();
      if (text.length > (key === 'roll' ? 40 : 240) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new InputError(`Row ${index + 1}: invalid ${key}.`);
      result[key] = text;
    }
    const roll = result.roll as string;
    if (!/^[A-Za-z0-9][A-Za-z0-9/_-]{1,39}$/.test(roll)) throw new InputError(`Row ${index + 1}: provide an explicit roll identifier; do not guess it.`);
    if (seen.has(roll.toUpperCase())) throw new InputError(`Duplicate roll ${roll}. Resolve duplicate candidates before upload.`);
    seen.add(roll.toUpperCase());
    const raw = record.cpi;
    if (raw === '' || raw === null) result.cpi = null;
    else {
      if (typeof raw !== 'number' && (typeof raw !== 'string' || !/^\d+(?:\.\d+)?$/.test(raw.trim()))) throw new InputError(`Row ${index + 1}: CPI must be numeric or blank.`);
      const number = Number(raw);
      if (!Number.isFinite(number) || number < 0 || number > 10) throw new InputError(`Row ${index + 1}: CPI must be between 0 and 10.`);
      result.cpi = number;
    }
    const issues = ['name', 'programme', 'branch', 'email'].filter(key => !result[key]).map(key => `missing_${key}`);
    if (result.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(result.email as string)) issues.push('invalid_email');
    if (issues.length) warnings.push({ row: index + 1, roll, issues });
    return result as StudentRow;
  });
  return { rows, warnings };
}

export function csvRows(input: string): Record<string, string>[] {
  const rows: string[][] = []; let row: string[] = [], field = '', quoted = false;
  const text = input.replace(/^\uFEFF/, '');
  for (let index = 0; index < text.length; index++) {
    const c = text[index];
    if (c === '"') {
      if (quoted && text[index + 1] === '"') { field += '"'; index++; }
      else if (quoted || !field.length) quoted = !quoted;
      else throw new InputError('Malformed CSV quote.');
    } else if (c === ',' && !quoted) { row.push(field); field = ''; }
    else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && text[index + 1] === '\n') index++;
      row.push(field); if (row.some(value => value.trim())) rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (quoted) throw new InputError('Unclosed CSV quote.');
  if (field.length || row.length) { row.push(field); if (row.some(value => value.trim())) rows.push(row); }
  if (rows.length < 2) throw new InputError('The CSV needs a header and student records.');
  const headers = rows.shift()!.map(value => value.trim().toLowerCase());
  if (new Set(headers).size !== headers.length) throw new InputError('Duplicate CSV headers.');
  return rows.map((values, index) => {
    if (values.length !== headers.length) throw new InputError(`CSV record ${index + 1} has a different column count.`);
    return Object.fromEntries(headers.map((header, i) => [header, values[i]]));
  });
}

export function toCSV(rows: StudentRow[]): string {
  const cell = (value: unknown) => {
    let text = value === null || value === undefined ? '' : String(value);
    // Neutralize spreadsheet formulas in downloaded CSV without changing stored data.
    if (/^[=+@-]/.test(text) || /^[\t\r]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  };
  return '\uFEFF' + [COLUMNS.map(cell).join(','), ...rows.map(row => COLUMNS.map(key => cell(row[key])).join(','))].join('\r\n') + '\r\n';
}

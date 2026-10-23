/** CSV in and out (RFC 4180: quotes, commas and line breaks inside quoted cells). */

export function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] as string;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell === '') quoted = true;
    else if (char === delimiter) {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += char;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((value) => value.trim() !== ''));
}

/** First row = column names. Semicolon- and tab-separated files are recognised. */
export function csvToObjects(text: string): Record<string, string>[] {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = [',', ';', '\t'].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0] ?? ',';
  const [header, ...rows] = parseCsv(text, delimiter);
  if (!header) return [];
  const keys = header.map((name, index) => name.trim() || `column${index + 1}`);
  return rows.map((cells) => Object.fromEntries(keys.map((key, index) => [key, (cells[index] ?? '').trim()])));
}

function csvCell(value: unknown): string {
  const text = value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Objects to CSV; columns are every key seen, in first-seen order. */
export function toCsv(rows: unknown[]): string {
  const objects = rows.map((row) => (row && typeof row === 'object' && !Array.isArray(row) ? (row as Record<string, unknown>) : { value: row }));
  const columns: string[] = [];
  for (const row of objects) for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
  return [columns.map(csvCell).join(','), ...objects.map((row) => columns.map((column) => csvCell(row[column])).join(','))].join('\n') + '\n';
}

import { describe, expect, it } from 'vitest';
import { csvToObjects, parseCsv, toCsv } from '../../src/core/csv';

describe('csv', () => {
  it('parses quotes, commas and newlines in cells', () => {
    expect(parseCsv('a,b\n"x, y","say ""hi""\nthere"\r\n\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"\nthere'],
    ]);
  });

  it('uses the header row as keys, and detects ; and tab', () => {
    expect(csvToObjects('email,password\na@b.co,pw1\nc@d.co,pw2')).toEqual([
      { email: 'a@b.co', password: 'pw1' },
      { email: 'c@d.co', password: 'pw2' },
    ]);
    expect(csvToObjects('name;qty\nA;1')).toEqual([{ name: 'A', qty: '1' }]);
    expect(csvToObjects('name\tqty\nA\t1')).toEqual([{ name: 'A', qty: '1' }]);
  });

  it('round-trips objects', () => {
    const rows = [{ title: 'A, B', price: 1 }, { title: 'C', extra: { x: 1 } }];
    const csv = toCsv(rows);
    expect(csv).toBe('title,price,extra\n"A, B",1,\nC,,"{""x"":1}"\n');
    expect(csvToObjects(csv)[0]).toEqual({ title: 'A, B', price: '1', extra: '' });
  });
});

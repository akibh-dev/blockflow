import { describe, expect, it } from 'vitest';
import { evaluate } from '../../src/core/expression';
import { render, templateErrors } from '../../src/core/template';
import { validateConfig, withDefaults } from '../../src/core/config';
import { logBlock } from '../../src/core/blocks';

const data = {
  price: '1,250',
  qty: 3,
  name: '  akib hasan ',
  items: [
    { title: 'A', price: '$2.50' },
    { title: 'B', price: '$1.00' },
    { title: 'A', price: '$4.00' },
  ],
  'my-key': 'dash',
};

describe('expressions', () => {
  it('math, comparison, logic, ternary', () => {
    expect(evaluate('price * 2', data)).toBe(2500);
    expect(evaluate('price + 10', data)).toBe(1260);
    expect(evaluate("'Total: ' + qty", data)).toBe('Total: 3');
    expect(evaluate('qty > 2 && qty < 5', data)).toBe(true);
    expect(evaluate("qty >= 3 ? 'many' : 'few'", data)).toBe('many');
    expect(evaluate('(1 + 2) * 3 - 4 / 2 % 3', data)).toBe(7);
    expect(evaluate('missing ?? "fallback"', data)).toBe('fallback');
    expect(evaluate('!items', data)).toBe(false);
    expect(evaluate('-qty', data)).toBe(-3);
  });

  it('paths and indexes', () => {
    expect(evaluate('items[2].price', data)).toBe('$4.00');
    expect(evaluate('items[qty - 1].title', data)).toBe('A');
    expect(evaluate('items.length', data)).toBe(3);
    expect(evaluate('$json.qty', data)).toBe(3);
    expect(evaluate('constructor', data)).toBeUndefined();
    expect(evaluate('items.constructor', data)).toBeUndefined();
  });

  it('functions', () => {
    expect(evaluate('upper(trim(name))', data)).toBe('AKIB HASAN');
    expect(evaluate('sum(pluck(items, "price"))', data)).toBe(7.5);
    expect(evaluate('round(avg(pluck(items, "price")), 2)', data)).toBe(2.5);
    expect(evaluate('join(unique(pluck(items, "title")), "/")', data)).toBe('A/B');
    expect(evaluate('first(sort(items, "price")).price', data)).toBe('$1.00');
    expect(evaluate("split('a, b,c', ',')[1]", data)).toBe('b');
    expect(evaluate("replace('a-b-c', '-', '+')", data)).toBe('a+b+c');
    expect(evaluate("replace('Order 42', '/\\\\d+/', '#')", data)).toBe('Order #');
    expect(evaluate("extract('Order #123 placed', '/#(\\\\d+)/')", data)).toBe('123');
    // As typed in the editor: a single backslash.
    expect(evaluate(String.raw`extract('Order #123', '/#(\d+)/')`, data)).toBe('123');
    expect(evaluate(String.raw`'it\'s' + ' ' + 'a\\b'`, data)).toBe("it's a\\b");
    expect(evaluate("contains(name, 'HASAN')", data)).toBe(true);
    expect(evaluate('len(items)', data)).toBe(3);
    expect(evaluate("default('', 'none')", data)).toBe('none');
    expect(evaluate('[1, 2, qty]', data)).toEqual([1, 2, 3]);
  });

  it('readable errors', () => {
    expect(() => evaluate('price *', data)).toThrow('Unexpected end in: price *');
    expect(() => evaluate('hack()', data)).toThrow('Unknown function hack()');
    expect(() => evaluate("'open", data)).toThrow('Unclosed text');
    expect(() => evaluate('a # b', data)).toThrow('Unexpected "#"');
  });
});

describe('templates with expressions', () => {
  it('renders paths and expressions', () => {
    expect(render('{{my-key}} {{ qty * 2 }} {{ upper(items[1].title) }}', data)).toBe('dash 6 B');
    expect(render('{{ price * }}', data)).toBe('');
  });

  it('reports broken expressions while designing', () => {
    expect(templateErrors('ok {{a.b}} {{ 1 + }}')).toEqual(['Unexpected end in: 1 +']);
    expect(validateConfig(logBlock, withDefaults(logBlock, { message: 'x {{ upper( }}' }), 'design')).toEqual([
      'Message: Unexpected end in: upper(',
    ]);
  });
});

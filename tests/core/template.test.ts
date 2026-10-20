import { describe, expect, it } from 'vitest';
import { getPath, hasTemplate, render } from '../../src/core/template';

describe('render', () => {
  it('fills simple values', () => {
    expect(render('Go to {{url}}', { url: 'https://a.com' })).toBe('Go to https://a.com');
  });

  it('tolerates whitespace inside braces', () => {
    expect(render('{{  value  }}', { value: 'x' })).toBe('x');
  });

  it('supports the n8n-style $json prefix', () => {
    expect(render('{{$json.url}}', { url: 'u' })).toBe('u');
  });

  it('reads nested values and array indexes', () => {
    const data = { item: { name: 'Ann' }, rows: [{ title: 'first' }, { title: 'second' }] };
    expect(render('{{item.name}} / {{rows[1].title}}', data)).toBe('Ann / second');
  });

  it('renders missing values as empty text', () => {
    expect(render('[{{nope}}]', {})).toBe('[]');
    expect(render('[{{a.b.c}}]', { a: 1 })).toBe('[]');
  });

  it('renders numbers and booleans as text, objects as JSON, null as empty', () => {
    expect(render('{{n}} {{b}}', { n: 3, b: false })).toBe('3 false');
    expect(render('{{o}}', { o: { a: 1 } })).toBe('{"a":1}');
    expect(render('[{{z}}]', { z: null })).toBe('[]');
  });

  it('does not read inherited properties', () => {
    expect(render('[{{constructor}}]', {})).toBe('[]');
    expect(render('[{{__proto__}}]', {})).toBe('[]');
    expect(render('[{{toString}}]', {})).toBe('[]');
  });

  it('leaves text without placeholders alone', () => {
    expect(render('plain', { a: 1 })).toBe('plain');
    expect(render('single { brace }', {})).toBe('single { brace }');
  });
});

describe('hasTemplate', () => {
  it('detects placeholders', () => {
    expect(hasTemplate('{{url}}')).toBe(true);
    expect(hasTemplate('https://x.com/{{id}}')).toBe(true);
    expect(hasTemplate('https://x.com')).toBe(false);
  });

  it('gives the same answer when called repeatedly', () => {
    expect(hasTemplate('{{a}}')).toBe(true);
    expect(hasTemplate('{{a}}')).toBe(true);
  });
});

describe('getPath', () => {
  it('returns the whole payload for $json', () => {
    const data = { a: 1 };
    expect(getPath(data, '$json')).toBe(data);
  });

  it('returns undefined for empty paths', () => {
    expect(getPath({ a: 1 }, '')).toBeUndefined();
  });
});

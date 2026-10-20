import { describe, expect, it } from 'vitest';
import { normalizeHttpUrl } from '../../src/core/url';

describe('normalizeHttpUrl', () => {
  it('keeps valid http and https URLs', () => {
    expect(normalizeHttpUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(normalizeHttpUrl('http://example.com')).toBe('http://example.com/');
  });

  it('adds https:// when the scheme is missing', () => {
    expect(normalizeHttpUrl('example.com/path')).toBe('https://example.com/path');
    expect(normalizeHttpUrl('localhost:3000')).toBe('https://localhost:3000/');
  });

  it('trims whitespace', () => {
    expect(normalizeHttpUrl('  https://example.com  ')).toBe('https://example.com/');
  });

  it('rejects empty input', () => {
    expect(normalizeHttpUrl('')).toBeNull();
    expect(normalizeHttpUrl('   ')).toBeNull();
  });

  it('rejects dangerous or non-web schemes', () => {
    expect(normalizeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeHttpUrl('JAVASCRIPT:alert(1)')).toBeNull();
    expect(normalizeHttpUrl('data:text/html,hi')).toBeNull();
    expect(normalizeHttpUrl('file:///etc/passwd')).toBeNull();
    expect(normalizeHttpUrl('chrome://settings')).toBeNull();
    expect(normalizeHttpUrl('about:blank')).toBeNull();
    expect(normalizeHttpUrl('ftp://example.com')).toBeNull();
  });

  it('rejects text that is not a URL', () => {
    expect(normalizeHttpUrl('not a url')).toBeNull();
  });
});

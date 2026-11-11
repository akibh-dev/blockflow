import { describe, expect, it, vi } from 'vitest';

vi.mock('wxt/browser', () => ({ browser: { tabs: { get: vi.fn() }, scripting: {} } }));

import { restrictedError } from '../../src/browser/pageDriver';
import { errorDetails } from '../../src/core/errors';

describe('restrictedError (store build: no site access until granted)', () => {
  it('Chrome: names the site and says how to grant it, with code permission.missing', () => {
    const error = restrictedError('Cannot access contents of the page. Extension manifest must request permission to access the respective host.', 'https://shop.example.com/cart?x=1', '#buy');
    expect(error.code).toBe('permission.missing');
    expect(error.message).toContain('https://shop.example.com');
    expect(error.message).toMatch(/Run the workflow from the editor/);
    expect(errorDetails(error)).toMatchObject({ code: 'permission.missing', locator: '#buy' });
  });

  it('Firefox: "Missing host permission for the tab" also maps to permission.missing', () => {
    const error = restrictedError('Missing host permission for the tab', 'http://127.0.0.1:8080/a');
    expect(error.code).toBe('permission.missing');
    expect(error.message).toContain('http://127.0.0.1:8080');
  });

  it('works without a tab URL', () => {
    expect(restrictedError('Missing host permission for the tab', undefined).message).toContain('this site');
    expect(restrictedError('Missing host permission for the tab', 'not a url').message).toContain('this site');
  });

  it('pages no extension may script stay page.restricted', () => {
    const error = restrictedError('Cannot access a chrome:// URL', 'chrome://extensions');
    expect(error.code).toBe('page.restricted');
    expect(error.message).toContain('does not let extensions');
  });
});

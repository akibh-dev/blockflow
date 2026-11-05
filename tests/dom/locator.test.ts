// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { accessibleName, getRole } from '../../src/dom/aria';
import { LocatorError, parseLocator, resolveLocator } from '../../src/dom/locator';

const page = (html: string) => {
  document.body.innerHTML = html;
};
const ids = (locator: string) => resolveLocator(locator).map((element) => element.id || element.localName);

beforeEach(() => page(''));

describe('parseLocator', () => {
  it('reads engines, plain CSS, XPath and quoted text', () => {
    expect(parseLocator('css=#a >> text=Go')).toEqual([
      { engine: 'css', body: '#a' },
      { engine: 'text', body: 'Go' },
    ]);
    expect(parseLocator('input[name=email]')).toEqual([{ engine: 'css', body: 'input[name=email]' }]);
    expect(parseLocator('//form//button')).toEqual([{ engine: 'xpath', body: '//form//button' }]);
    expect(parseLocator('"Sign in"')).toEqual([{ engine: 'text', body: '"Sign in"' }]);
  });

  it('does not split inside quotes, brackets or on >>>', () => {
    expect(parseLocator('text="a >> b"')).toHaveLength(1);
    expect(parseLocator('role=button[name="x >> y"]')).toHaveLength(1);
    expect(parseLocator('my-app >>> button')).toEqual([{ engine: 'css', body: 'my-app >>> button' }]);
  });

  it('rejects empty locators', () => {
    expect(() => parseLocator('  ')).toThrow(LocatorError);
  });
});

describe('resolveLocator', () => {
  beforeEach(() =>
    page(`
      <form id="login">
        <label for="email">Email address</label><input id="email" type="email" placeholder="you@example.com">
        <label>Password <input id="pw" type="password"></label>
        <input id="remember" type="checkbox" aria-label="Remember me" checked>
        <button id="go" data-testid="submit-btn">Sign <b>in</b></button>
        <button id="cancel" type="button">Cancel</button>
      </form>
      <h1 id="title">Welcome</h1><h2 id="sub">Welcome back</h2>
      <a id="help" href="/help">Need help?</a>
      <div hidden><button id="ghost">Sign in</button></div>
      <ul><li id="l1">One</li><li id="l2">Two</li><li id="l3">Three</li></ul>
    `),
  );

  it('css, testid, placeholder', () => {
    expect(ids('#login button')).toEqual(['go', 'cancel']);
    expect(ids('testid=submit-btn')).toEqual(['go']);
    expect(ids('placeholder=you@example')).toEqual(['email']);
  });

  it('text: substring, exact, regex, smallest element', () => {
    expect(ids('text=sign in')).toEqual(['go', 'ghost']);
    expect(ids('text="Welcome"')).toEqual(['title']);
    expect(ids('text=welcome')).toEqual(['title', 'sub']);
    expect(ids('text=/^welcome back$/i')).toEqual(['sub']);
  });

  it('role with name, checked, level; hidden elements are skipped', () => {
    expect(ids('role=button[name="sign in"]')).toEqual(['go']);
    expect(ids('role=button[name="Sign"][exact]')).toEqual([]);
    expect(ids('role=button[name="Sign in"][exact]')).toEqual(['go']);
    expect(ids('role=checkbox[checked]')).toEqual(['remember']);
    expect(ids('role=heading[level=2]')).toEqual(['sub']);
    expect(ids('role=link')).toEqual(['help']);
    expect(ids('role=textbox')).toEqual(['email']);
  });

  it('label: for=, wrapping label, aria-label', () => {
    expect(ids('label=Email')).toEqual(['email']);
    expect(ids('label=password')).toEqual(['pw']);
    expect(ids('label="Remember me"')).toEqual(['remember']);
  });

  it('chaining and nth', () => {
    expect(ids('#login >> role=button >> nth=1')).toEqual(['cancel']);
    expect(ids('li >> nth=-1')).toEqual(['l3']);
    expect(ids('li >> nth=5')).toEqual([]);
    expect(ids('ul >> text=Two')).toEqual(['l2']);
  });

  it('xpath', () => {
    expect(ids('xpath=//li[2]')).toEqual(['l2']);
    expect(ids('//h1')).toEqual(['title']);
  });

  it('pierces open shadow roots with >>>', () => {
    const host = document.createElement('my-widget');
    document.body.append(host);
    host.attachShadow({ mode: 'open' }).innerHTML = '<button id="inner">Deep</button>';
    expect(ids('my-widget >>> button')).toEqual(['inner']);
    expect(ids('text=Deep')).toEqual(['inner']);
  });

  it('explains invalid locators', () => {
    expect(() => resolveLocator('css=##')).toThrow('Invalid CSS selector');
    expect(() => resolveLocator('text=/(/')).toThrow('Invalid regular expression');
    expect(() => resolveLocator('role=button[bogus]')).toThrow('Unknown role option [bogus]. Use name, exact, checked, level, include-hidden.');
  });
});

describe('aria', () => {
  it('maps roles and names', () => {
    page(`<input id="a" type="submit"><img id="b" alt="Logo"><select id="c"><option>x</option></select>
      <div id="d" role="switch" aria-labelledby="lbl"></div><span id="lbl">Dark mode</span>`);
    const el = (id: string) => document.getElementById(id) as Element;
    expect([getRole(el('a')), accessibleName(el('a'))]).toEqual(['button', 'Submit']);
    expect([getRole(el('b')), accessibleName(el('b'))]).toEqual(['img', 'Logo']);
    expect(getRole(el('c'))).toBe('combobox');
    expect([getRole(el('d')), accessibleName(el('d'))]).toEqual(['switch', 'Dark mode']);
  });

  it('a <section> is a region only with a name, and an unlabelled one does not recurse forever', () => {
    page('<section id="s"><button>Save</button></section><section id="r" aria-label="Billing"><p>x</p></section>');
    expect(getRole(document.getElementById('s') as Element)).toBeNull();
    expect(getRole(document.getElementById('r') as Element)).toBe('region');
    expect(resolveLocator('role=button[name="Save"]')).toHaveLength(1);
    expect(resolveLocator('role=region[name="Billing"]')).toHaveLength(1);
  });
});

describe('locatorCandidates', () => {
  it('ranks readable, unique locators first and always ends with CSS', async () => {
    const { locatorCandidates, bestLocator } = await import('../../src/dom/bestLocator');
    page(`
      <form><label for="e">Email</label><input id="e" name="email" placeholder="you@x.co"></form>
      <button data-testid="save">Save</button>
      <button>Delete</button><a href="/x">Delete</a>
      <p>Hello</p>`);
    const input = document.getElementById('e') as Element;
    expect(locatorCandidates(input)).toEqual(['label="Email"', 'placeholder="you@x.co"', 'role=textbox[name="Email"]', 'input[name="email"]', '#e']);
    expect(bestLocator(document.querySelector('[data-testid]') as Element)).toBe('testid=save');
    const del = document.querySelector('button:not([data-testid])') as Element;
    // "text=Delete" matches the link too, so it is left out.
    expect(locatorCandidates(del)[0]).toBe('role=button[name="Delete"]');
    expect(locatorCandidates(del)).not.toContain('text="Delete"');
  });
});

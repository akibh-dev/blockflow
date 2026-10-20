// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ElementNavigator,
  cssEscape,
  generateSelector,
  isStableClass,
  isStableId,
  sampleText,
} from '../../src/dom/selector';
import { readSelectorInPage } from '../../src/dom/readElement';

function page(html: string): void {
  document.body.innerHTML = html;
}

function pick(selector: string): Element {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`fixture is missing ${selector}`);
  return element;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('cssEscape', () => {
  it('escapes characters that are special in selectors', () => {
    expect(cssEscape('a b')).toBe('a\\ b');
    expect(cssEscape('a.b')).toBe('a\\.b');
    expect(cssEscape('1a')).toBe('\\31 a');
    expect(cssEscape('-')).toBe('\\-');
  });

  it('leaves normal names alone', () => {
    expect(cssEscape('price_box-2')).toBe('price_box-2');
  });
});

describe('isStableId / isStableClass', () => {
  it('accepts readable names', () => {
    expect(isStableId('price')).toBe(true);
    expect(isStableId('main-content')).toBe(true);
    expect(isStableClass('product-title')).toBe(true);
    expect(isStableClass('col-md-6')).toBe(true);
  });

  it('rejects generated and state names', () => {
    expect(isStableId(':r1:')).toBe(false);
    expect(isStableId('ember12345')).toBe(false);
    expect(isStableId('a8f3c2d9e1b7')).toBe(false);
    expect(isStableClass('active')).toBe(false);
    expect(isStableClass('css-1x2y3z')).toBe(false);
    expect(isStableClass('sc-aBcDeF')).toBe(false);
    expect(isStableClass('aB3dE9fGh2')).toBe(false);
  });
});

describe('generateSelector', () => {
  it('uses a stable id on its own', () => {
    page('<div><span id="price">$5</span></div>');
    expect(generateSelector(pick('#price'))).toBe('#price');
  });

  it('skips generated ids and falls back to tag and class', () => {
    page('<div id=":r1:"><span class="price">$5</span></div>');
    expect(generateSelector(pick('.price'))).toBe('span.price');
  });

  it('prefers test attributes over classes', () => {
    page('<div><span class="x" data-testid="cart-total">$5</span></div>');
    expect(generateSelector(pick('span'))).toBe('span[data-testid="cart-total"]');
  });

  it('ignores state classes and hashed classes', () => {
    page('<div class="active css-1abc2de"><p class="label active sc-aBcDeF">hi</p></div>');
    expect(generateSelector(pick('p'))).toBe('p.label');
  });

  it('adds :nth-of-type only when siblings are ambiguous', () => {
    page('<ul class="list"><li class="item">a</li><li class="item">b</li><li class="item">c</li></ul>');
    const third = document.querySelectorAll('li')[2] as Element;
    expect(generateSelector(third)).toBe('li.item:nth-of-type(3)');
  });

  it('climbs to an ancestor when the element alone is not unique', () => {
    page(
      '<ul class="a"><li class="x">1</li><li class="x">2</li></ul><ul class="b"><li class="x">3</li></ul>',
    );
    const lone = pick('ul.b li');
    expect(generateSelector(lone)).toBe('ul.b > li.x');
  });

  it('skips class names that would need escaping', () => {
    page('<div><span class="w-1/2">x</span></div>');
    // "w-1/2" fails the stable-class test, so it must not appear in the selector at all.
    expect(generateSelector(pick('span'))).toBe('span');
  });

  it('returns html for the root element', () => {
    expect(generateSelector(document.documentElement)).toBe('html');
  });

  it('always produces a selector that matches exactly the picked element', () => {
    page(`
      <header id="top"><nav class="menu"><a href="#">One</a><a href="#">Two</a><a class="active" href="#">Three</a></nav></header>
      <main>
        <section class="card"><h2 class="title">A</h2><p>text</p><p>more</p><span class="price">1</span></section>
        <section class="card"><h2 class="title">B</h2><p>text</p><span class="price">2</span></section>
        <section class="card"><div><div><div><span class="price">3</span></div></div></div></section>
        <table><tbody><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></tbody></table>
        <div data-testid="x"><i></i><i></i></div>
      </main>
      <footer><p>fin</p></footer>
    `);
    const all = Array.from(document.body.querySelectorAll('*'));
    expect(all.length).toBeGreaterThan(25);
    for (const element of all) {
      const selector = generateSelector(element);
      const found = document.querySelectorAll(selector);
      expect(found.length).toBe(1);
      expect(found[0] === element).toBe(true);
    }
  });
});

describe('ElementNavigator', () => {
  it('broadens to parents and narrows back, stopping before <body>', () => {
    page('<section id="outer"><div id="mid"><span id="inner">x</span></div></section>');
    const nav = new ElementNavigator(pick('#inner'));
    expect(nav.current.id).toBe('inner');
    expect(nav.canNarrow()).toBe(false);

    expect(nav.broaden().id).toBe('mid');
    expect(nav.broaden().id).toBe('outer');
    expect(nav.canBroaden()).toBe(false);
    expect(nav.broaden().id).toBe('outer'); // cannot go past the top-level element

    expect(nav.narrow().id).toBe('mid');
    expect(nav.narrow().id).toBe('inner');
    expect(nav.narrow().id).toBe('inner');
  });
});

describe('sampleText', () => {
  it('collapses whitespace and shortens long text', () => {
    page('<p id="p">  Hello \n   world  </p>');
    expect(sampleText(pick('#p'))).toBe('Hello world');
    page(`<p id="p">${'x'.repeat(300)}</p>`);
    expect(sampleText(pick('#p'), 10)).toBe('xxxxxxxxx…');
  });
});

describe('readSelectorInPage', () => {
  it('reads the text of the first match', () => {
    page('<span class="price">$9.99</span>');
    expect(readSelectorInPage('.price')).toEqual({ found: true, text: '$9.99' });
  });

  it('reports a missing element', () => {
    page('<span></span>');
    expect(readSelectorInPage('.nope')).toEqual({ found: false, text: '' });
  });

  it('reports an invalid selector instead of throwing', () => {
    const result = readSelectorInPage('!!!');
    expect(result.found).toBe(false);
    expect(result.error).toBe('Invalid selector: !!!');
  });
});

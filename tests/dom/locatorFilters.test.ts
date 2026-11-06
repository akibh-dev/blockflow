// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { accessibleDescription, disabledState, expandedState, pressedState, selectedState } from '../../src/dom/aria';
import { FrameBoundaryError, LocatorError, isVisibleElement, resolveLocator } from '../../src/dom/locator';

// M2.1 filters (has-text, has-not-text, has, has-not, visible), `||`, and M2.2 role options.

const page = (html: string) => {
  document.body.innerHTML = html;
};
const ids = (locator: string) => resolveLocator(locator).map((element) => element.id || element.localName);

describe('locator filters', () => {
  beforeEach(() =>
    page(`
      <ul id="cart">
        <li id="apple"><span>Apple</span> <button id="del-apple">Delete</button></li>
        <li id="banana"><span>Banana</span> <button id="del-banana">Delete</button> <em>sale</em></li>
        <li id="cherry"><span>Cherry pie</span></li>
        <li id="ghost" style="display:none"><span>Apple (old)</span> <button id="del-ghost">Delete</button></li>
      </ul>
      <p id="note" hidden>Apple</p>
      <button id="save">Save</button><a id="store" href="/store">Store</a>
    `),
  );

  it('has-text keeps matches whose text contains it (substring, exact when quoted, regex)', () => {
    expect(ids('li >> has-text=apple')).toEqual(['apple', 'ghost']);
    expect(ids('li >> has-text="Cherry pie"')).toEqual(['cherry']);
    expect(ids('li >> has-text="Cherry"')).toEqual([]);
    expect(ids('li >> has-text=/^banana/i')).toEqual(['banana']);
    expect(ids('li >> has-text=Apple >> role=button[name="Delete"]')).toEqual(['del-apple']);
  });

  it('has-not-text drops them', () => {
    expect(ids('li >> has-not-text=apple')).toEqual(['banana', 'cherry']);
  });

  it('has / has-not test for an element inside (a quoted inner locator may have steps)', () => {
    expect(ids('li >> has=role=button')).toEqual(['apple', 'banana']);
    expect(ids('li >> has=em')).toEqual(['banana']);
    expect(ids('li >> has-not=button')).toEqual(['cherry']);
    expect(ids('li >> has="text=Cherry >> visible"')).toEqual(['cherry']);
    expect(ids("li >> has='button || em' >> has-text=Banana")).toEqual(['banana']);
    // Only strictly inside: an li does not "have" itself.
    expect(ids('li >> has=li')).toEqual([]);
  });

  it('visible / visible=true / visible=false', () => {
    expect(ids('li >> visible')).toEqual(['apple', 'banana', 'cherry']);
    expect(ids('li >> visible=true')).toEqual(['apple', 'banana', 'cherry']);
    expect(ids('li >> visible=false')).toEqual(['ghost']);
    expect(ids('text=Apple >> visible')).toEqual(['apple'].map(() => 'span'));
    expect(isVisibleElement(document.getElementById('note') as Element)).toBe(false);
  });

  it('filters chain with nth and other steps', () => {
    expect(ids('li >> has=button >> nth=-1')).toEqual(['ghost']);
    expect(ids('li >> visible >> has=button >> nth=-1')).toEqual(['banana']);
    expect(ids('role=button >> visible >> has-text=Delete >> nth=1')).toEqual(['del-banana']);
  });

  it('A || B: either, in document order, once each', () => {
    expect(ids('#store || #save')).toEqual(['save', 'store']);
    expect(ids('role=button[name="Save"] || role=link[name="Store"] || #save')).toEqual(['save', 'store']);
    expect(ids('#missing || text=Cherry')).toEqual(['span']);
    // `||` binds loosest.
    expect(ids('li >> has-text=Banana >> button || #save')).toEqual(['del-banana', 'save']);
    // Not split inside quotes or brackets.
    expect(ids('li >> has-text="a || b" || #save')).toEqual(['save']);
  });

  it('explains mistakes', () => {
    expect(() => resolveLocator('has-text=Apple')).toThrow(LocatorError);
    expect(() => resolveLocator('has-text=Apple')).toThrow('filters the matches of the step before it');
    expect(() => resolveLocator('li >> visible=maybe')).toThrow('visible= takes true or false');
    expect(() => resolveLocator('li >> has=')).toThrow(LocatorError);
    expect(() => resolveLocator('li >> has="css=##"')).toThrow('Invalid CSS selector');
    expect(() => resolveLocator('#save ||')).toThrow('"||" needs a locator on both sides');
  });

  it('a cross-origin frame in one alternative is handed over only when nothing else matches', () => {
    page('<iframe id="pay" src="https://other.example/pay"></iframe><button id="here">Here</button>');
    const frame = document.getElementById('pay') as HTMLIFrameElement;
    Object.defineProperty(frame, 'contentDocument', { get: () => null });
    expect(ids('frame=#pay >> text=Pay || #here')).toEqual(['here']);
    expect(() => resolveLocator('frame=#pay >> text=Pay || #nothing')).toThrow(FrameBoundaryError);
  });
});

describe('role options: pressed, expanded, selected, disabled', () => {
  beforeEach(() =>
    page(`
      <button id="bold" aria-pressed="true">Bold</button>
      <button id="italic" aria-pressed="false">Italic</button>
      <button id="plain">Plain</button>
      <button id="menu" aria-expanded="false" aria-haspopup="menu">Menu</button>
      <button id="more" aria-expanded="true">More</button>
      <div role="tablist"><div role="tab" id="t1" aria-selected="true">One</div><div role="tab" id="t2" aria-selected="false">Two</div></div>
      <select id="size" size="3"><option id="s" selected>S</option><option id="m">M</option><option id="l" disabled>L</option></select>
      <button id="off" disabled>Off</button>
      <div aria-disabled="true"><button id="inside">Inside</button></div>
      <fieldset disabled><legend><button id="legend-btn">In legend</button></legend><button id="fs-btn">In fieldset</button></fieldset>
    `),
  );

  it('pressed', () => {
    expect(ids('role=button[pressed]')).toEqual(['bold']);
    expect(ids('role=button[pressed=false]')).toEqual(['italic']);
    expect(ids('role=button[pressed=true][name="Bold"]')).toEqual(['bold']);
    expect(pressedState(document.getElementById('plain') as Element)).toBeNull();
  });

  it('expanded', () => {
    expect(ids('role=button[expanded]')).toEqual(['more']);
    expect(ids('role=button[expanded=false]')).toEqual(['menu']);
    expect(expandedState(document.getElementById('plain') as Element)).toBeNull();
  });

  it('selected (aria-selected and native options)', () => {
    expect(ids('role=tab[selected]')).toEqual(['t1']);
    expect(ids('role=tab[selected=false]')).toEqual(['t2']);
    expect(ids('role=option[selected]')).toEqual(['s']);
    expect(selectedState(document.getElementById('m') as Element)).toBe(false);
  });

  it('disabled (native, fieldset outside its legend, aria-disabled ancestor)', () => {
    expect(ids('role=button[disabled]')).toEqual(['off', 'inside', 'fs-btn']);
    expect(ids('role=button[disabled=false][name="In legend"]')).toEqual(['legend-btn']);
    expect(ids('role=option[disabled]')).toEqual(['l']);
    expect(disabledState(document.getElementById('bold') as Element)).toBe(false);
  });

  it('rejects bad values', () => {
    expect(() => resolveLocator('role=button[pressed=maybe]')).toThrow('[pressed=…] takes true or false');
    expect(() => resolveLocator('role=heading[level=x]')).toThrow('takes a number');
  });
});

describe('accessibleDescription', () => {
  it('aria-describedby, aria-description, then a title that is not the name', () => {
    page(`
      <p id="hint">We never share it</p>
      <input id="a" aria-label="Email" aria-describedby="hint">
      <button id="b" aria-description="Deletes forever">Delete</button>
      <button id="c" title="Saves a draft">Save</button>
      <button id="d" title="Close"></button>
    `);
    const get = (id: string) => accessibleDescription(document.getElementById(id) as Element);
    expect(get('a')).toBe('We never share it');
    expect(get('b')).toBe('Deletes forever');
    expect(get('c')).toBe('Saves a draft');
    expect(get('d')).toBe('');
  });
});

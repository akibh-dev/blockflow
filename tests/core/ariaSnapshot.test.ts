import { describe, expect, it } from 'vitest';
import { AriaTemplateError, ariaTemplateProblem, matchAriaSnapshot, parseAriaOutline, parseAriaTemplate, renderAriaTree } from '../../src/core/ariaSnapshot';

// An outline as the `snapshot` page op writes it (src/dom/snapshot.ts), refs and locator hints included.
const OUTLINE = [
  '- banner',
  '  - heading "Shop" [level=1] [ref=e1] locator=role=heading[name="Shop"]',
  '  - navigation "Main" [ref=e2] locator=role=navigation[name="Main"]',
  '    - link "Cart" [url="/cart"] [ref=e3] locator=role=link[name="Cart"]',
  '    - link "Sign up" [url="/join"] [ref=e4] locator=role=link[name="Sign up"]',
  '- main',
  '  - form "Login" [ref=e5] locator=role=form[name="Login"]',
  '    - textbox "Email" [required] [value="a@b.c"] [type=email] [ref=e6] locator=label="Email"',
  '    - textbox "Password" [password] [ref=e7] locator=label="Password"',
  '    - checkbox "Remember me" [checked] [ref=e8] locator=label="Remember me"',
  '    - button "Sign in" [disabled] [ref=e9] locator=role=button[name="Sign in"]',
  '    - button "Menu" [expanded=false] [ref=e10] locator=role=button[name="Menu"]',
  '  - list',
  '    - listitem: Apples',
  '    - listitem: Pears',
  '    - listitem',
  '      - link "Plums" [url="/plums"] [ref=e11] locator=role=link[name="Plums"]',
  '  - paragraph: "Total: 3" items',
  '  - text: Footer note locator=not-a-hint',
  '  - button [ref=e12]: Go locator=text="Go"',
].join('\n');
const elements = [{ ref: 'e12', locator: 'text="Go"' }];
const outline = parseAriaOutline(OUTLINE, elements);
const match = (template: string) => matchAriaSnapshot(outline, parseAriaTemplate(template));
const passes = (template: string) => match(template).pass;

function errorOf(template: string): AriaTemplateError {
  try {
    parseAriaTemplate(template);
  } catch (error) {
    if (error instanceof AriaTemplateError) return error;
    throw error;
  }
  throw new Error(`parsed: ${template}`);
}

describe('parseAriaOutline', () => {
  it('drops refs and locator hints, keeps states, values and inline text', () => {
    const text = renderAriaTree(outline.root).text;
    expect(text).not.toContain('ref=');
    expect(text).not.toContain('locator=role');
    expect(text).toContain('- heading "Shop" [level=1]');
    expect(text).toContain('- textbox "Email" [required] [type=email]: a@b.c');
    expect(text).toContain('- link "Cart":\n      - /url: /cart');
    expect(text).toContain('- listitem: Apples');
    expect(text).toContain('- button: Go');
    // Plain text lines are text as written (no hint cutting without a ref).
    expect(text).toContain('- text: Footer note locator=not-a-hint');
    expect(text).toContain('- paragraph: "\\"Total: 3\\" items"');
    expect(outline.truncated).toBe(false);
  });

  it('marks a cut outline', () => {
    expect(parseAriaOutline('- button "A" [ref=e1] locator=x\n- … truncated at 10 lines: snapshot one part').truncated).toBe(true);
  });
});

describe('parseAriaTemplate errors', () => {
  it.each([
    ['- heading "Welcome', 1, 11, 'not closed'],
    ['- button [bogus]', 1, 11, 'unknown state [bogus]'],
    ['- heading [level=x]', 1, 18, 'must be a number'],
    ['- checkbox [checked=maybe]', 1, 21, 'true, false or mixed'],
    ['- heading "a"\n  heading "b"', 2, 3, 'list item'],
    ['- list:\n    - listitem\n  - listitem', 3, 1, 'line up'],
    ['- listitem: Apples\n  - link "x"', 2, 3, 'line 1 has a value'],
    ['- button /Sign (in/', 1, 10, 'invalid regular expression'],
    ['- button /sign in/i', 1, 19, 'flags are not supported'],
    ['- text "hi"', 1, 3, '`- text: the text`'],
    ['- button "Go" extra', 1, 15, 'unexpected "extra"'],
    ['- link "x":\n  - /href: y', 2, 5, 'unknown property /href'],
    ['- list:\n  - /children: some', 2, 16, 'contain, equal or deep-equal'],
    ['- button [active]', 1, 11, 'does not record'],
    ['', 1, 1, 'empty'],
    ['-heading', 1, 2, 'space after'],
  ])('%j → line %i, column %i', (template, line, column, reason) => {
    const error = errorOf(template);
    expect(error.message).toContain(reason);
    expect([error.line, error.column]).toEqual([line, column]);
  });

  it('reports columns in the text as written when it is indented', () => {
    const error = errorOf('\n    - heading "x"\n    - button [nope]');
    expect([error.line, error.column]).toEqual([3, 15]);
    expect(ariaTemplateProblem('    - button [nope]')).toBe('line 1, column 15: unknown state [nope] (use checked, disabled, expanded, level, pressed or selected)');
    expect(ariaTemplateProblem('- heading "ok"')).toBeNull();
  });

  it('takes comments, YAML quoting and pasted outline lines', () => {
    expect(ariaTemplateProblem('# the header\n- heading "Shop" # top\n- text: "a: b"')).toBeNull();
    expect(ariaTemplateProblem(`- 'button "a: b"'`)).toBeNull();
    expect(ariaTemplateProblem('- heading "Shop" [level=1] [ref=e1] locator=role=heading[name="Shop"]')).toBeNull();
  });
});

describe('matchAriaSnapshot', () => {
  it('exact names and regex names', () => {
    expect(passes('- heading "Shop"')).toBe(true);
    expect(passes('- heading "  Shop "')).toBe(true);
    expect(passes('- heading "Sho"')).toBe(false);
    expect(passes('- link /Sign (in|up)/')).toBe(true);
    expect(passes('- button /^Sign/')).toBe(true);
    expect(passes('- button /Log ?in/')).toBe(false);
    expect(passes('- button')).toBe(true);
  });

  it('states: listed ones must match, unlisted ones are ignored', () => {
    expect(passes('- heading "Shop" [level=1]')).toBe(true);
    expect(passes('- heading "Shop" [level=2]')).toBe(false);
    expect(passes('- checkbox "Remember me" [checked]')).toBe(true);
    expect(passes('- checkbox "Remember me" [checked=false]')).toBe(false);
    expect(passes('- button "Sign in" [disabled]')).toBe(true);
    expect(passes('- button "Menu" [disabled=false]')).toBe(true);
    expect(passes('- button "Menu" [expanded=false]')).toBe(true);
    expect(passes('- button "Menu" [expanded]')).toBe(false);
    expect(passes('- button "Sign in" [pressed]')).toBe(false);
    expect(passes('- textbox "Email" [required]')).toBe(true);
    expect(passes('- textbox "Password" [required]')).toBe(false);
    expect(passes('- textbox "Email" [type=email]')).toBe(true);
  });

  it('values, texts and URLs', () => {
    expect(passes('- textbox "Email": a@b.c')).toBe(true);
    expect(passes('- textbox "Email" [value="a@b.c"]')).toBe(true);
    expect(passes('- textbox "Email": /@b\\.c$/')).toBe(true);
    expect(passes('- textbox "Email": x@y.z')).toBe(false);
    expect(passes('- listitem: Apples')).toBe(true);
    expect(passes('- listitem: /^Pe/')).toBe(true);
    expect(passes('- paragraph: \'"Total: 3" items\'')).toBe(true);
    expect(passes('- text: Footer note locator=not-a-hint')).toBe(true);
    expect(passes('- link "Cart":\n  - /url: /cart')).toBe(true);
    expect(passes('- link "Cart":\n  - /url: /shop')).toBe(false);
  });

  it('keeps order, allows extra nodes, matches children as a subsequence', () => {
    expect(passes('- textbox "Email"\n- button "Sign in"')).toBe(true);
    expect(passes('- button "Sign in"\n- textbox "Email"')).toBe(false);
    expect(passes('- form "Login":\n  - textbox "Email"\n  - button "Menu"')).toBe(true);
    // Children are direct children: the link is inside a listitem, not the list.
    expect(passes('- list:\n  - link "Plums"')).toBe(false);
    expect(passes('- list:\n  - listitem: Apples\n  - listitem:\n    - link "Plums"')).toBe(true);
    expect(passes('- main:\n  - form:\n    - checkbox [checked]\n  - list')).toBe(true);
    // Top-level lines must be siblings.
    expect(passes('- heading "Shop"\n- navigation "Main"')).toBe(true);
    expect(passes('- heading "Shop"\n- form "Login"')).toBe(false);
  });

  it('/children: equal and deep-equal', () => {
    expect(passes('- list:\n  - /children: equal\n  - listitem: Apples\n  - listitem: Pears\n  - listitem')).toBe(true);
    expect(passes('- list:\n  - /children: equal\n  - listitem: Apples\n  - listitem: Pears')).toBe(false);
    expect(passes('- navigation:\n  - /children: deep-equal\n  - link "Cart"\n  - link "Sign up"')).toBe(true);
  });

  it('explains a mismatch: the missing line, the closest node and where it looked', () => {
    const result = match('- main:\n  - form "Login":\n    - textbox "Email"\n    - button "Sign up"');
    expect(result.pass).toBe(false);
    expect(result.message).toContain('template line 4 found nothing on the page:\n  - button "Sign up"');
    expect(result.message).toContain('Closest on the page: - button "Sign in" [disabled] (its name is "Sign in", expected "Sign up")');
    expect(result.message).toContain('Looked for it in:\n  - form "Login":');
    expect(result.message).not.toContain('ref=');

    const level = match('- heading "Shop" [level=2]');
    expect(level.message).toContain('Closest on the page: - heading "Shop" [level=1] (it does not have [level=2])');

    const order = match('- button "Menu"\n- textbox "Email"');
    expect(order.message).toContain('template line 2');
    expect(order.message).toContain('the order differs');

    const text = match('- list:\n  - listitem: Plums');
    expect(text.message).toContain('template line 2 found nothing on the page:\n  - listitem: Plums');
    expect(text.message).toContain('Closest on the page: - listitem: Apples (its text is "Apples")');
    expect(text.message).toContain('Looked for it in:\n  - list:\n    - listitem: Apples');

    const deeper = match('- main:\n  - button "Sign in"');
    expect(deeper.message).toContain('Closest on the page: - button "Sign in" [disabled] (not a direct child here, it is under - form "Login" (nested lines match direct children only, add that line))');

    const nothing = match('- slider "Volume"');
    expect(nothing.message).toContain('nothing like it is on the page');
    expect(nothing.message).toContain('The page:\n  - banner:');
  });

  it('cuts long page excerpts', () => {
    const big = parseAriaOutline(Array.from({ length: 60 }, (_, index) => `- button "B${index}" [ref=e${index}] locator=x`).join('\n'));
    const result = matchAriaSnapshot(big, parseAriaTemplate('- button "Missing"'));
    expect(result.message).toContain('… 40 more lines');
    expect(result.message.split('\n').length).toBeLessThan(30);
  });

  it('names the outline cut at its line limit', () => {
    const cut = parseAriaOutline('- button "A"\n- … truncated at 2 lines: snapshot one part');
    expect(matchAriaSnapshot(cut, parseAriaTemplate('- button "B"')).message).toContain('cut at its line limit');
  });

  it('a name the outline cut at 100 characters still matches the full text', () => {
    const long = 'x'.repeat(150);
    const cut = parseAriaOutline(`- heading "${'x'.repeat(99)}…" [level=1] [ref=e1] locator=h1`);
    expect(matchAriaSnapshot(cut, parseAriaTemplate(`- heading "${long}"`)).pass).toBe(true);
  });
});

describe('renderAriaTree for Playwright', () => {
  it('writes a template Playwright parses, dropping BlockFlow-only states', () => {
    const template = parseAriaTemplate('- form "Login":\n  - textbox "Email" [required]: a@b.c\n  - button /Sign (in|up)/ [disabled]\n  - text: "Total: 3"\n- link "Cart":\n  - /url: /cart\n- \'button "a: b"\'');
    const { text, dropped } = renderAriaTree(template, { playwright: true });
    expect(text).toBe(['- form "Login":', '  - textbox "Email": a@b.c', '  - button /Sign (in|up)/ [disabled]', '  - text: "Total: 3"', '- link "Cart":', '  - /url: /cart', `- 'button "a: b"'`].join('\n'));
    expect(dropped).toEqual(['[required]']);
    // And reads back the same.
    expect(renderAriaTree(parseAriaTemplate(text)).text).toBe(text);
  });
});

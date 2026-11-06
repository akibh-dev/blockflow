# Locators

A locator is the string a page block uses to name an element: Playwright-like syntax (`role=button[name="Save"]`,
`label=Email >> nth=0`), resolved inside the page. Read this page to write or debug a locator, to change how
one resolves, or to understand which locator the picker and recorder suggest and why.

**Source:** [locatorSyntax.ts](../../src/core/locatorSyntax.ts) (parsing, shared with the exporter),
[locator.ts](../../src/dom/locator.ts) (resolution), [aria.ts](../../src/dom/aria.ts) (roles and names),
[bestLocator.ts](../../src/dom/bestLocator.ts) (generated readable locators),
[selector.ts](../../src/dom/selector.ts) (generated CSS).

## Pipeline

```text
"form#login >> role=button[name=\"Sign in\"]"
   │ parseLocatorSteps (core, string only)      → [{engine:'css', body:'form#login'}, {engine:'role', body:'button[name="Sign in"]'}]
   │ resolveLocator(source, root) (dom)         → step by step, each step searching inside the previous matches
   ▼
 Element[] in document order                    → the agent's one() (strict) or all()
```

## Syntax (`locatorSyntax.ts`)

```ts
export class LocatorSyntaxError extends Error {}
export interface LocatorStep { engine: string; body: string }
export const ENGINES: Set<string>;   // css text role label placeholder testid alt title xpath nth frame
export function parseLocatorSteps(source: string): LocatorStep[];
```

- **Steps** are split on `>>` outside quotes (`"` / `'`, with `\` escapes) and outside `[...]` / `(...)`.
  The shadow-piercing `>>>` is never a split point.
- Each step is trimmed, then classified:

| Step looks like | Engine |
|---|---|
| `<engine>=<body>` with a known engine name (lowercase, optional spaces before `=`) | that engine; body trimmed |
| starts with `//` or `(//` | `xpath` |
| fully wrapped in `"..."` | `text` (exact, body keeps the quotes) |
| anything else | `css` |

- Empty locator → `"The locator is empty"`; an empty step (`a >> >> b`) → `"Invalid locator: …"`.
- An unknown `foo=bar` is treated as CSS, which then fails as invalid CSS.

Who parses: [locator.ts](../../src/dom/locator.ts) `parseLocator` (rethrows as `LocatorError`) and the
Playwright exporter [playwright.ts](../../src/core/playwright.ts), which maps steps to `getByRole`,
`getByLabel`, `frameLocator`… (see [Core Modules](Core-Modules.md)).

## Engines (`locator.ts`)

| Engine | Example | Matches | Shadow DOM | Hidden elements |
|---|---|---|---|---|
| `css` (default) | `#login button`, `css=form input[name=email]` | `querySelectorAll`. `a >>> b` runs `b` inside the open shadow roots of `a`'s matches. | only via `>>>` | included |
| `text` | `text=Sign in`, `text="Sign in"`, `text=/sign\s?in/i`, `"Sign in"` | Smallest elements whose text matches: an element is dropped when one of its children matches too. Text is `textContent`, or `value` for `input[type=button\|submit\|reset]`. Skips `script`, `style`, `noscript`, `template`, `head`, `title`, `meta`, `link`. | yes | **included** (`text=` does not check visibility) |
| `role` | `role=button[name="Submit"]`, `role=heading[level=2]`, `role=checkbox[checked]` | `getRole(el) === role`, plus options below | yes | excluded unless `[include-hidden]` |
| `label` | `label=Email` | Controls of matching `<label>`s (`label.control`, else first `input, select, textarea, [contenteditable]` inside), and any element whose `aria-label` or `aria-labelledby` text matches | yes | included |
| `placeholder` | `placeholder=you@example.com` | `placeholder` attribute through `textMatcher` | yes | included |
| `alt` / `title` | `alt=Logo`, `title=Close` | that attribute through `textMatcher` | yes | included |
| `testid` | `testid=login` | **exact** value of `data-testid`, `data-test-id`, `data-test`, `data-cy` or `data-qa` (quotes allowed, no regex) | yes | included |
| `xpath` | `xpath=//form//button`, `//form//button` | `document.evaluate` with the scope as context node, element nodes only | no | included |
| `nth` | `>> nth=0`, `>> nth=-1` | One element of the matches so far by index; negative counts from the end; out of range → no match | — | — |
| `frame` | `frame=iframe#pay >> label=Card` | See [Frames](#frames) | — | — |

### Text matching (`textMatcher(body, exact = false)`)

Shared by `text`, `label`, `placeholder`, `alt`, `title`, role names, and the agent's Wait For text.
Whitespace is collapsed and trimmed on both sides before comparing.

| Body | Match |
|---|---|
| `/pattern/flags` | `RegExp.test` (bad pattern → `Invalid regular expression: …`) |
| `"quoted"` or `'quoted'` (or `exact = true`) | equal, case-sensitive |
| anything else | case-insensitive substring |

### Role options

`role=<role>` followed by any of these brackets, in any order:

| Option | Meaning |
|---|---|
| `[name="…"]` / `[name=/re/i]` / `[name=…]` | accessible name. **Unlike `text=`, a quoted name is still a case-insensitive substring**; add `[exact]` for equality. |
| `[exact]` | exact (case-sensitive) name match |
| `[checked]`, `[checked=false]` | `checkedState` (native checked, else `aria-checked` / `aria-pressed`) |
| `[level=N]` | `aria-level`, else the `hN` number |
| `[include-hidden]` | also match elements hidden from ARIA |

Anything else is `Unknown role option [x]. Use name, exact, checked, level.` Leftover text after the
role is `Invalid role locator`.

### Roles and names (`aria.ts`)

A simplified HTML-AAM mapping and accessible name computation, enough to say "the Submit button".

```ts
export function getRole(element: Element): string | null;
export function accessibleName(element: Element): string;
export function isHiddenForAria(element: Element): boolean;
export function checkedState(element: Element): boolean | null;
```

| Element | Role |
|---|---|
| explicit `role="a b"` | `a` (first token) |
| `input` | button (button/submit/reset/image), checkbox, radio, slider (range), spinbutton (number), textbox (text/email/tel/url, default), searchbox (search); text-like with `list` → combobox; **password, date, file… → null** |
| `a` / `area` | link only with `href` |
| `select` | listbox if `multiple` or `size > 1`, else combobox |
| `img` | presentation if `alt=""`, else img |
| `section` | region only when it has a name |
| others | `TAG_ROLES`: button, textarea→textbox, h1–h6→heading, ul/ol/menu→list, li→listitem, nav, main, header→banner, footer→contentinfo, aside→complementary, form, dialog, table, tr→row, td→cell, th→columnheader, article, fieldset→group, hr→separator, progress→progressbar, output→status, p→paragraph |

`accessibleName` order: `aria-labelledby` text (looked up in the element's root first, so it works in
shadow trees) → `aria-label` → for form fields: button value (`Submit`/`Reset` defaults), image `alt`,
`<label>`s, then `title` / `placeholder` → img/area `alt`/`title` → fieldset `legend`, table `caption` →
content text for name-from-content roles (button, link, heading, cell, option, tab, menuitem*, checkbox,
radio, switch, treeitem, tooltip, listitem, row…) → `title`.

`isHiddenForAria`: `aria-hidden="true"` or `[hidden]` ancestor, `display:none` on it or an ancestor, or
`visibility:hidden` on itself.

### Chaining

`A >> B` searches B inside each match of A, **strictly** inside (A's own match is skipped), then dedupes
and sorts into document order. `nth` picks from the matches so far and scopes the following steps to that
one element. `nth` as the first step yields nothing.

### Frames

`frame=<css>` finds `iframe`/`frame` elements with CSS in the current scopes; following steps search their
`contentDocument`s.

- Same-origin: entered directly, the result is element(s) from the inner document.
- Cross-origin (`contentDocument` is null or throws): skipped, but remembered as
  `FrameBoundaryError(src, rest, frame)` where `rest` is the remaining steps re-serialised as
  `engine=body >> …`.
- Every matched same-origin frame is searched. Only when the whole locator finds **nothing** and a
  cross-origin frame was skipped is that error thrown (for the first such frame): the agent answers
  `{status: 'frame', src, rest}` and the driver re-runs `rest` in that frame (see
  [Page Agent](Page-Agent.md#injection-and-addressing)). So `frame=iframe >> text=Pay` finds the button
  in whichever same-origin frame has it, and falls back to a cross-origin frame. An element that has not
  appeared yet in a same-origin frame can therefore be looked for in a cross-origin one meanwhile; point
  `frame=` at one iframe when that matters.
- Frames can nest: the agent inside the frame may hand over again.

```ts
export class LocatorError extends Error {}
export class FrameBoundaryError extends LocatorError { readonly src: string; readonly rest: string; readonly frame?: Element }
export function parseLocator(source: string): LocatorStep[];
export function resolveLocator(source: string, root: ParentNode = document): Element[];
export function textMatcher(body: string, exact?: boolean): (text: string) => boolean;
export function describeElement(element: Element): string;   // button#save.primary "Save changes"
```

## Examples

Given

```html
<form id="login">
  <label for="email">Email address</label><input id="email" type="email" placeholder="you@example.com">
  <label>Password <input id="pw" type="password"></label>
  <button id="go" data-testid="submit-btn">Sign <b>in</b></button>
  <button id="cancel" type="button">Cancel</button>
</form>
<div hidden><button id="ghost">Sign in</button></div>
<ul><li id="l1">One</li><li id="l2">Two</li><li id="l3">Three</li></ul>
```

| Locator | Result |
|---|---|
| `#login button` | go, cancel (strict actions fail: 2 matches) |
| `text=sign in` | go, ghost (hidden ones count for `text=`) |
| `role=button[name="sign in"]` | go (ghost is hidden; quoted name still case-insensitive) |
| `role=button[name="Sign"][exact]` | nothing |
| `label=Email` / `label=password` | email / pw |
| `placeholder=you@example` | email |
| `testid=submit-btn` | go |
| `#login >> role=button >> nth=1` | cancel |
| `li >> nth=-1` | l3 |
| `xpath=//li[2]` or `//li[2]` | l2 |
| `my-widget >>> button` | button inside the open shadow root |

More cases live in [tests/dom/locator.test.ts](../../tests/dom/locator.test.ts).

## Generated locators

### Readable: `locatorCandidates(element, max = 5)` / `bestLocator(element)`

Used by the picker (all candidates), the recorder and Detect fields (`bestLocator`). Ideas are generated in
this order, deduplicated, and **kept only if `resolveLocator(idea, ownerDocument)` returns exactly this
element**:

| # | Idea | When |
|---|---|---|
| 1 | `testid=<value>` | any test-id attribute |
| 2 | `label="<text>"` | form field (input/select/textarea) with a first `<label>` (or `aria-label`) ≤ 60 chars |
| 3 | `placeholder="<text>"` | form field with a placeholder |
| 4 | `role=<role>[name="<name>"]` | has role and name (not paragraph/presentation) |
| 5 | `role=<role>[name="<name>"][exact]` | same, not a form field (useful when the substring form matches several) |
| 6 | `text="<text>"` | not a form field; whole text ≤ 40 chars |
| 7 | `alt="…"`, `title="…"` | attribute ≤ 60 chars |
| 8 | `<tag>[name="…"]` (+ `[value="…"]` for radios) | form field with `name` |
| last | `generateSelector(element)` CSS | always, unless already listed |

At most `max − 1` readable ideas are kept, then the CSS selector. `bestLocator` returns the first.

`firstLocator(element, cache?)` gives the same answer as `bestLocator` but stops at the first idea that
works; with a `cache` (locator → matches, one `Map` per document, only while the page does not change)
each idea is resolved once for all elements. Page snapshots use it for every element they list.

`role=` checks the name before the hidden state: `isHiddenForAria` reads computed styles up the tree,
the most expensive test, so it only runs for elements that otherwise match.

### Structural CSS: `generateSelector(element)` (`selector.ts`)

```ts
export function generateSelector(element: Element): string;
export function isStableId(id: string): boolean;
export function isStableClass(name: string): boolean;
export function cssEscape(value: string): string;
export function countMatches(doc: Document, selector: string): number;
```

Walks up from the element, prepending one segment per ancestor (`a > b > c`), and stops as soon as the
selector matches exactly the element. Per element:

1. Stable id → `#id` (and an id segment never gets `:nth-of-type`).
2. Else first of `data-testid`, `data-test`, `data-qa`, `data-cy`, `name`, `aria-label` with a value ≤ 60
   chars → `tag[attr="value"]`.
3. Else `tag` + up to two stable classes.
4. `:nth-of-type(n)` only when another sibling matches the same segment.

Inside an open shadow root the walk stops at the root (uniqueness is checked with the root's
`querySelectorAll`) and the host's own selector is put in front: `sign-up >>> #join`. `countMatches`
resolves such selectors through `resolveLocator`. Elements in iframes get their `frame=<iframe css> >> `
prefix from the picker/recorder content scripts ([Picker and Recorder: Frames](Picker-and-Recorder.md#frames)).

Stable id: starts with a letter, ≤ 41 chars of `[\w-]`, no run of 3+ digits, not an 8+ char hex string, no
CSS-in-JS prefix (`css-`, `sc-`, `jsx-`, `emotion-`, `mui-`…). Stable class: same idea, plus not a state
class (`active`, `open`, `selected`, `is-active`, `ng-star-inserted`…) and not a random mixed-case+digit
hash. Rationale: [ARCHITECTURE.md: Element picker](../ARCHITECTURE.md#element-picker).

The picker's `selector` field is this CSS selector (stable when text changes, which Watch Element and Read
Element want: their field has `pickPrefers: 'stable'`); other locator fields default to the first readable
candidate.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `X matches N elements … add ">> nth=0"` | strict action, several matches | narrow (`form#a >> …`, `[exact]`) or `>> nth=0` |
| Times out `waiting for X: no element matches` | wrong page/frame, element not rendered, closed shadow root, XPath into shadow DOM | check the frame; CSS needs `>>>` for shadow DOM |
| `text=` matches a hidden duplicate | `text=` does not filter hidden elements | use `role=…[name=…]` (skips hidden) |
| `role=` finds nothing for a password field | no implicit role for `type=password` in this model | `label=` or `placeholder=` |
| `role=button[name="Save"]` also matches "Save draft" | quoted role names are substrings | add `[exact]` |
| `Invalid CSS selector: …` from what looked like an engine | engine name misspelled or uppercase (`Text=`) → parsed as CSS | lowercase engine name |
| `The element is inside a frame from another site` | cross-origin frame and the driver could not find it | wait for the frame to load; check `frame=` points at one iframe |
| Generated CSS selector breaks after a deploy | ancestors only had generated classes/ids, so it fell back to `:nth-of-type` chains | prefer the readable candidate |

## See also

- [Page Agent](Page-Agent.md): strictness and waits around resolution
- [Picker and Recorder](Picker-and-Recorder.md): where generated locators come from
- [Page Protocol](Page-Protocol.md): requests that carry locators
- [Core Modules](Core-Modules.md): `locatorSyntax.ts`, `playwright.ts`
- [ARCHITECTURE.md: Page blocks and the page agent](../ARCHITECTURE.md#page-blocks-and-the-page-agent)

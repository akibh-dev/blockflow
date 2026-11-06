/**
 * Requests the engine sends to the page agent (src/dom/agent.ts), and its answers.
 * Plain data: they travel through `scripting.executeScript`.
 *
 * Locators use Playwright-like syntax, see src/dom/locator.ts:
 *   css=#login button · text=Sign in · role=button[name="Submit"] · label=Email
 *   placeholder=you@example.com · testid=submit · xpath=//form · A >> B · A >> nth=1
 */

import type { ErrorCode } from './errors';

/** What a `read` request reads from the element. */
export type ReadKind = 'text' | 'value' | 'attribute' | 'has-class' | 'exists' | 'count' | 'visible' | 'checked' | 'enabled';

/** A mouse button, as Playwright names them. */
export type MouseButton = 'left' | 'middle' | 'right';

/** A key held during a mouse action, as Playwright names them. */
export type Modifier = 'Alt' | 'Control' | 'Meta' | 'Shift';

/** CSS pixels. */
export interface Point {
  x: number;
  y: number;
}

/** Condition a `wait` request waits for. */
export type WaitState = 'visible' | 'hidden' | 'attached' | 'detached' | 'enabled' | 'text' | 'no-text';

/** One thing the page agent can do in a page. Each op is handled by `attempt()` in src/dom/agent.ts. */
export type AgentRequest =
  | {
      op: 'click';
      locator: string;
      action: 'click' | 'double' | 'right' | 'hover';
      /** Skip the "is it visible, enabled, not covered" checks. */
      force?: boolean;
      /** Mouse button (default left; `action: 'right'` means right). */
      button?: MouseButton;
      /** Keys held during the click: Alt, Control, Meta, Shift. */
      modifiers?: Modifier[];
      /** Where to click, in CSS pixels from the element's top-left corner (default: its center). */
      position?: Point;
      /** Presses in a row (default 1, `action: 'double'` = 2); `detail` counts up, `dblclick` after the second. */
      clickCount?: number;
    }
  /** Element Action: move focus to the element (it waits until it is visible). */
  | { op: 'focus'; locator: string }
  /** Element Action: take focus away from the element (if it has it). */
  | { op: 'blur'; locator: string }
  /** Element Action: empty a text field or contenteditable (input + change events), like Playwright's `clear()`. */
  | { op: 'clear'; locator: string }
  /**
   * Element Action: dispatch one event (bubbles, cancelable, composed). Known types get their own class
   * (MouseEvent for click, KeyboardEvent for keydown…) with `detail` (an object) as the event init;
   * any other type is a CustomEvent with `detail` as its `event.detail`.
   */
  | { op: 'dispatch'; locator: string; eventType: string; detail?: unknown }
  /**
   * Drag the element `locator` onto `to`. Synthetic: pointer and mouse down on the source, then HTML5
   * drag events (dragstart … drop, dragend) with one shared DataTransfer when the source is draggable and
   * the page lets the drag start, otherwise pointer/mouse moves to the target and pointer/mouse up there
   * (sliders, sortables built on pointer events). Positions are from each element's top-left corner.
   */
  | { op: 'drag'; locator: string; to: string; fromPosition?: Point; toPosition?: Point; modifiers?: Modifier[] }
  | { op: 'fill'; locator: string; value: string; mode: 'fill' | 'type' }
  /** Set any form field from text: fills inputs, picks select options, ticks checkboxes ("true"/"false"). */
  | { op: 'set-field'; locator: string; value: string }
  | { op: 'select'; locator: string; values: string[] }
  | { op: 'check'; locator: string; checked: boolean }
  | { op: 'press'; key: string; locator?: string }
  | { op: 'read'; locator: string; kind: ReadKind; name?: string }
  | { op: 'wait'; state: WaitState; locator?: string; text?: string }
  | { op: 'detect-form'; locator: string }
  /** URL and title of the page (currently not sent by any block). */
  | { op: 'info' }
  /**
   * Scraping: one row per element matching `locator`, one cell per field. A field's locator is
   * searched inside the item (empty = the item itself); `attribute` reads that attribute instead of
   * the text (href/src come back as absolute URLs). The answer is `{ columns, values, count }`
   * (arrays keep key order across executeScript); `tableToObjects` in blocks/extractList.ts makes objects.
   */
  | { op: 'extract'; locator: string; fields: ExtractField[]; limit?: number }
  /** An HTML table as `{ columns, values, count }`: header cells as columns, one row of cells per body row. */
  | { op: 'table'; locator: string }
  /** URL, title, description, canonical, language, meta tags, JSON-LD. */
  | { op: 'page-info' }
  | { op: 'storage'; area: 'local' | 'session' | 'cookies'; key?: string }
  | { op: 'scroll'; to: 'bottom' | 'top' | 'element'; locator?: string }
  /**
   * Put files on an <input type=file> (also a hidden one, as custom upload buttons use). With `dropzone`,
   * drop them on the element instead: dragenter, dragover and drop with a DataTransfer carrying the files.
   */
  | { op: 'upload'; locator: string; files: UploadFile[]; dropzone?: boolean }
  /**
   * For real (debugger) input: wait until the element is ready, scroll it into view, and return
   * its center in viewport pixels plus what kind of field it is.
   */
  | {
      op: 'locate';
      locator: string;
      /** `drop`: a drag's target, only waited for to be visible and still. */
      purpose: 'click' | 'fill' | 'set-field' | 'check' | 'press' | 'drop';
      /** Answer this point (from the element's top-left corner) instead of the center. */
      position?: Point;
    }
  /**
   * What is on the page, for authoring: an outline of the accessibility tree with a ready-made locator per
   * element (see {@link SnapshotResult}). `locator` limits it to one part of the page (first match);
   * `maxLines` caps the outline (default {@link SNAPSHOT_MAX_LINES}).
   */
  | { op: 'snapshot'; locator?: string; maxLines?: number };

/** Default cap of a snapshot outline. */
export const SNAPSHOT_MAX_LINES = 1_500;

/**
 * One element of a snapshot (an outline line with a `[ref=…]`). `locator` finds exactly this element
 * from the top page (frames included, as `frame=… >> …`); missing for structural roles (lists, rows...).
 */
export interface SnapshotElement {
  ref: string;
  role: string;
  name: string;
  tag: string;
  locator?: string;
  /** Current value of a text field or select. Never set for password fields. */
  value?: string;
  checked?: boolean | 'mixed';
  disabled?: boolean;
  /** Heading level. */
  level?: number;
  /** Absolute URL of a link. */
  url?: string;
  /** Inside a same-origin frame. */
  inFrame?: boolean;
  /** Inside an open shadow root. */
  inShadow?: boolean;
}

/** The `result` of a `snapshot` request. */
export interface SnapshotResult {
  /**
   * The outline, one element per line, indented by nesting:
   * `- button "Sign in" [disabled] [ref=e12] locator=role=button[name="Sign in"]`.
   * Frames are `- iframe … [frame]` with their content nested below (or `[cross-origin]` when it cannot be
   * read), open shadow roots are marked `[shadow]` on their host.
   */
  snapshot: string;
  elements: SnapshotElement[];
  url: string;
  title: string;
  /** Lines in `snapshot` (the truncation note included). */
  lines: number;
  /** True when the cap was reached and the rest of the page is missing. */
  truncated: boolean;
}

/** A file to put on a file input. */
export interface UploadFile {
  name: string;
  type: string;
  /** File content, base64. */
  base64: string;
}

/** One column of an `extract` request. */
export interface ExtractField {
  name: string;
  locator?: string;
  attribute?: string;
}

/** Sent with every request: how long the agent may keep retrying inside the page before answering. */
export interface AgentCall {
  request: AgentRequest;
  budgetMs: number;
}

/**
 * The machine-readable part of a `pending` or `error` answer (see src/core/errors.ts): the code, the
 * page's URL, and for strict-mode errors up to 5 descriptions of the matching elements.
 */
export interface AgentErrorInfo {
  code?: ErrorCode;
  url?: string;
  matches?: string[];
}

/** The agent's answer to one `AgentCall`. */
export type AgentResponse =
  | { status: 'done'; result: Record<string, unknown> }
  /** Not possible yet (element missing, hidden, disabled...). The driver asks again until its timeout. */
  | ({ status: 'pending'; reason: string } & AgentErrorInfo)
  /** Will never work (bad locator, wrong element type...). */
  | ({ status: 'error'; message: string } & AgentErrorInfo)
  /**
   * The locator enters an iframe from another site: run `rest` inside the frame showing `src`.
   * `offset` (for `locate` only) is where the frame's content starts in this frame's viewport, so
   * the driver can turn the inner frame's coordinates into the tab's.
   */
  | { status: 'frame'; src: string; rest: string; offset?: { x: number; y: number } };

/**
 * A snapshot as text to paste into a chat with a model: page title and URL, then the outline. Used by
 * the editor's "📸 Snapshot page" button.
 */
export function snapshotDocument(result: Pick<SnapshotResult, 'snapshot' | 'url' | 'title' | 'truncated'>): string {
  return [
    `# Page snapshot: ${result.title || '(no title)'}`,
    `URL: ${result.url}`,
    'Each line: role "name" [state] [ref] locator=<a BlockFlow locator that finds exactly that element>.',
    ...(result.truncated ? ['The outline was cut at its line limit; snapshot one part of the page to see the rest.'] : []),
    '',
    result.snapshot,
    '',
  ].join('\n');
}

/** One row of a Fill Form block, also what "Detect fields" produces. */
export interface FormFieldRow {
  locator: string;
  value: string;
  /** What the field is, for the editor: "Email · email", "Country · select: BD, US". */
  hint?: string;
}

/** How long tab operations wait after navigating. */
export type WaitUntil = 'load' | 'networkidle' | 'none';

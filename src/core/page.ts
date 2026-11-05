/**
 * Requests the engine sends to the page agent (src/dom/agent.ts), and its answers.
 * Plain data: they travel through `scripting.executeScript`.
 *
 * Locators use Playwright-like syntax, see src/dom/locator.ts:
 *   css=#login button · text=Sign in · role=button[name="Submit"] · label=Email
 *   placeholder=you@example.com · testid=submit · xpath=//form · A >> B · A >> nth=1
 */

/** What a `read` request reads from the element. */
export type ReadKind = 'text' | 'value' | 'attribute' | 'has-class' | 'exists' | 'count' | 'visible' | 'checked' | 'enabled';

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
    }
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
  /** Put files on an <input type=file> (also a hidden one, as custom upload buttons use). */
  | { op: 'upload'; locator: string; files: UploadFile[] }
  /**
   * For real (debugger) input: wait until the element is ready, scroll it into view, and return
   * its center in viewport pixels plus what kind of field it is.
   */
  | { op: 'locate'; locator: string; purpose: 'click' | 'fill' | 'set-field' | 'check' | 'press' };

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

/** The agent's answer to one `AgentCall`. */
export type AgentResponse =
  | { status: 'done'; result: Record<string, unknown> }
  /** Not possible yet (element missing, hidden, disabled...). The driver asks again until its timeout. */
  | { status: 'pending'; reason: string }
  /** Will never work (bad locator, wrong element type...). */
  | { status: 'error'; message: string }
  /** The locator enters an iframe from another site: run `rest` inside the frame showing `src`. */
  | { status: 'frame'; src: string; rest: string };

/** One row of a Fill Form block, also what "Detect fields" produces. */
export interface FormFieldRow {
  locator: string;
  value: string;
  /** What the field is, for the editor: "Email · email", "Country · select: BD, US". */
  hint?: string;
}

/** How long tab operations wait after navigating. */
export type WaitUntil = 'load' | 'networkidle' | 'none';

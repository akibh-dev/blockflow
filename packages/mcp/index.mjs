// BlockFlow MCP server: tools that validate, import and run workflows in the user's real browser
// through the BlockFlow bridge, the guide as resources, and a write-and-repair prompt.
// `createBlockflowServer({ connect })` builds the server around an injected bridge connector, so tests
// drive it with a fake bridge over the SDK's in-memory transport; server.mjs wires stdio and the real client.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import { createBridgeSession, defaultConnector, describeError } from './bridgeSession.mjs';
import { formatIssues, formatRunText, formatSuiteText, summarizeRun } from './format.mjs';
import { PACKAGE_DIR, RESOURCES, readResource } from './resources.mjs';
import { RPC_ERRORS } from 'blockflow-bridge/protocol';

const VERSION = JSON.parse(readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf8')).version;

/** Bridge-call limits. A run's own `timeoutSeconds` is enforced by the extension; this is a backstop. */
const RUN_DEFAULT_MS = 30 * 60_000;
const SUITE_MS = 4 * 60 * 60_000;
const SNAPSHOT_MS = 120_000;
/** How much of the step outputs the run summary text carries (structuredContent has all of them). */
const OUTPUT_TEXT_CHARS = 4_000;

export const INSTRUCTIONS = `BlockFlow runs browser automations and end-to-end tests inside the user's own browser (with their logins).
Workflows are JSON scripts ({"format":"blockflow-script","version":1,"name":…,"steps":[…]}); read the resource blockflow://guide ("Rules for AI tools" and "Script format") and blockflow://blocks before writing one.
Loop: snapshot_page (copy locators from it) → write the script → validate_workflow (fix every issue by its path and hint) → run_workflow → on failure read the failing step's code, message, locator and screenshot, fix that step, validate and run again.
The browser must be open with BlockFlow's "Allow outside control" switched on (Settings) and the bridge installed (npx blockflow-bridge install).`;

// ---------- input schemas ----------

const source = z
  .union([z.string(), z.record(z.string(), z.unknown())])
  .describe(
    'The workflow: a BlockFlow script ({"format":"blockflow-script","version":1,"name":"…","steps":[…]}), a graph file ({"format":"blockflow-workflows",…}) or one workflow, either as a JSON object or as JSON text. Prefer the script format. Pass JSON text when you want issue paths to match the text exactly.',
  );
const secrets = z
  .record(z.string(), z.string())
  .describe('Values for {{secret.<name>}} in the workflow, for this run only (never stored). Keys are secret names, e.g. {"loginPassword": "…"}.');

// ---------- helpers ----------

const text = (value) => ({ type: /** @type {const} */ ('text'), text: value });

function isBlobRef(value) {
  return Boolean(value) && typeof value === 'object' && typeof value.blobId === 'string' && typeof value.size === 'number' && Object.keys(value).length <= 3;
}

/** Reads every chunk of a blob (`blob.get`, base64 data) and returns the bytes and their type. */
export async function fetchBlob(session, blobId) {
  const chunks = [];
  let offset = 0;
  let mime;
  for (;;) {
    const chunk = await session.call('blob.get', { blobId, offset });
    const bytes = Buffer.from(chunk.data ?? '', 'base64');
    chunks.push(bytes);
    mime ??= chunk.mime;
    offset = (typeof chunk.offset === 'number' ? chunk.offset : offset) + bytes.length;
    if (chunk.done || (typeof chunk.size === 'number' && offset >= chunk.size)) break;
    if (bytes.length === 0) throw new Error(`blob ${blobId} returned an empty chunk at ${offset} before it was done`);
  }
  return { bytes: Buffer.concat(chunks), mime };
}

/** A result that may have come back as a BlobRef: fetch and parse it. */
async function resolve(session, result) {
  if (!isBlobRef(result)) return result;
  const { bytes } = await fetchBlob(session, result.blobId);
  return JSON.parse(bytes.toString('utf8'));
}

/** Turns any error into a tool result the model can act on (the server never throws out of a tool). */
function errorResult(error) {
  const e = /** @type {any} */ (error);
  const issues = e?.data?.issues;
  if (e?.code === RPC_ERRORS.invalidWorkflow && Array.isArray(issues)) {
    return {
      isError: true,
      content: [text(`The workflow did not validate, so nothing ran. Fix every issue at its path (see the Repair table in blockflow://guide), then call again.\n${formatIssues(issues)}`)],
      structuredContent: { ok: false, issues },
    };
  }
  return { isError: true, content: [text(`BlockFlow error: ${describeError(error)}`)] };
}

/** `notifications/progress` for this request, when the client asked for progress. */
function progressReporter(extra) {
  const token = extra?._meta?.progressToken;
  let progress = 0;
  return (message, total) => {
    if (token === undefined) return;
    progress += 1;
    /** @type {any} */
    const params = { progressToken: token, progress, message };
    if (typeof total === 'number') params.total = total;
    void extra.sendNotification({ method: 'notifications/progress', params }).catch(() => {});
  };
}

/** The client's notification callback may be (method, params) or ({method, params}); accept both. */
function readNotification(a, b) {
  return typeof a === 'string' ? { method: a, params: b ?? {} } : { method: a?.method, params: a?.params ?? {} };
}

function outputsText(run) {
  const outputs = (run.steps ?? []).filter((step) => step.output !== undefined).map((step) => `${step.sourceId ?? step.nodeId}: ${JSON.stringify(step.output)}`);
  if (!outputs.length) return '';
  const joined = outputs.join('\n');
  return `Step outputs:\n${joined.length > OUTPUT_TEXT_CHARS ? `${joined.slice(0, OUTPUT_TEXT_CHARS)}… (cut; full outputs in structuredContent.steps)` : joined}`;
}

// ---------- server ----------

/**
 * @param {{ connect?: () => Promise<any>, resourceDirs?: { packageDir: string, repoDir: string } }} [options]
 */
export function createBlockflowServer(options = {}) {
  const session = createBridgeSession(options.connect ?? defaultConnector());
  const server = new McpServer({ name: 'blockflow', title: 'BlockFlow', version: VERSION }, { instructions: INSTRUCTIONS });

  /** Wraps a handler so every failure becomes an isError result. */
  const safe = (handler) => async (args, extra) => {
    try {
      return await handler(args ?? {}, extra);
    } catch (error) {
      return errorResult(error);
    }
  };

  server.registerTool(
    'list_workflows',
    {
      title: 'List workflows',
      description: 'Lists the workflows saved in BlockFlow (id, name, whether it is switched on, whether it was imported over the bridge). Use an id with run_workflow or get_report.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async () => {
      const { workflows } = await resolve(session, await session.call('list', {}));
      const lines = workflows.map((wf) => `- ${wf.id} "${wf.name}" ${wf.enabled ? 'on' : 'off'}${wf.viaBridge ? ' (via bridge)' : ''}`);
      return { content: [text(workflows.length ? `${workflows.length} workflow(s):\n${lines.join('\n')}` : 'No workflows saved yet.')], structuredContent: { workflows } };
    }),
  );

  server.registerTool(
    'validate_workflow',
    {
      title: 'Validate a workflow',
      description:
        'Checks a workflow script or graph strictly, exactly as Import would, without saving or running it. Returns ok and a list of issues, each "<level> <code> at <JSON path>: <message> <hint>". Errors (unknown block type or config key, wrong value type, bad locator…) block import and running; warnings do not. To repair: change the key or value at each path as the hint says (the Repair table in blockflow://guide explains every code), then validate again until ok is true. Always validate before run_workflow.',
      inputSchema: { source },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async ({ source: src }) => {
      const result = await resolve(session, await session.call('validate', { source: src }));
      const workflows = (result.workflows ?? []).map((wf) => `"${wf.name}" (${wf.nodes} blocks)`).join(', ');
      const head = result.ok
        ? `Valid${workflows ? `: ${workflows}` : ''}. Next: run_workflow with this source (or import_workflow to save it).`
        : 'INVALID: nothing can be imported or run until every error is fixed. Fix each path below, then validate again.';
      const body = result.issues?.length ? `\n${formatIssues(result.issues)}` : '';
      return { content: [text(head + body)], structuredContent: { ok: result.ok, issues: result.issues ?? [], workflows: result.workflows ?? [] } };
    }),
  );

  server.registerTool(
    'import_workflow',
    {
      title: 'Import a workflow',
      description:
        "Saves a workflow script or graph into the user's BlockFlow editor (tagged \"via bridge\", switched off), after the same strict check as validate_workflow. Returns the new workflow ids. replace: true replaces an earlier bridge-imported workflow with the same name instead of adding a copy. Only import when the user wants to keep the workflow; run_workflow can run a source without saving it.",
      inputSchema: {
        source,
        replace: z.boolean().optional().describe('Replace a workflow previously imported over the bridge with the same name (default false: add a new one).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    safe(async ({ source: src, replace }) => {
      const params = /** @type {any} */ ({ source: src });
      if (replace !== undefined) params.replace = replace;
      const result = await resolve(session, await session.call('import', params));
      const workflows = result.workflows ?? [];
      const issues = result.issues ?? [];
      const failed = workflows.length === 0 && issues.some((issue) => issue.level === 'error');
      const lines = workflows.map((wf) => `- ${wf.id} "${wf.name}"`);
      const head = failed ? 'Nothing was imported. Fix the issues and call again.' : `Imported ${workflows.length} workflow(s):\n${lines.join('\n')}`;
      return {
        isError: failed || undefined,
        content: [text(`${head}${issues.length ? `\n${formatIssues(issues)}` : ''}`)],
        structuredContent: { workflows, issues },
      };
    }),
  );

  server.registerTool(
    'run_workflow',
    {
      title: 'Run a workflow',
      description:
        "Runs a workflow once in the user's browser and waits until it finishes. Pass either workflowId (a saved workflow, from list_workflows) or source (a script or graph, run without saving; it is validated first and invalid sources come back with issues, nothing runs). Returns a summary first: status (passed/failed/cancelled), run id, duration, and for a failure the failing step's id (the step `id` in your script, else s<N> for the Nth step) and block type, error code, message, locator, page URL and matching elements, then every step's status and the step outputs, plus a screenshot of the page at the failure when one was taken. To repair: look up the error code in the guide's error-code table, use snapshot_page on the URL for correct locators, change that step, validate_workflow, run again.",
      inputSchema: {
        workflowId: z.string().optional().describe('Id of a saved workflow (from list_workflows or import_workflow).'),
        source: source.optional(),
        secrets: secrets.optional(),
        timeoutSeconds: z.number().int().positive().max(3600).optional().describe('Stop the run after this many seconds (default: no overall limit; each step has its own timeout).'),
        screenshot: z.boolean().optional().describe('Attach the failing step\'s screenshot as an image (default true).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    safe(async (args, extra) => {
      if ((args.workflowId === undefined) === (args.source === undefined)) {
        return { isError: true, content: [text('Pass exactly one of workflowId (a saved workflow) or source (a script to run without saving).')] };
      }
      const params = /** @type {any} */ ({});
      for (const key of ['workflowId', 'source', 'secrets', 'timeoutSeconds']) if (args[key] !== undefined) params[key] = args[key];
      const report = progressReporter(extra);
      let runId;
      const onAbort = () => {
        if (runId) void session.call('stop', { runId }).catch(() => {});
      };
      extra?.signal?.addEventListener('abort', onAbort, { once: true });
      let result;
      try {
        result = await session.call('run', params, {
          timeoutMs: args.timeoutSeconds ? (args.timeoutSeconds + 60) * 1000 : RUN_DEFAULT_MS,
          onNotification: (a, b) => {
            const { method, params: note } = readNotification(a, b);
            if (method === 'run.started') {
              runId = note.runId;
              report(`started "${note.workflowName}" (run ${note.runId})`);
            } else if (method === 'run.step' && note.step) {
              const step = note.step;
              report(`${step.sourceId ?? step.nodeId} ${step.blockType} ${step.status}${step.code ? ` ${step.code}` : ''}`);
            }
          },
        });
      } finally {
        extra?.signal?.removeEventListener('abort', onAbort);
      }
      const { run } = await resolve(session, result);
      const summary = summarizeRun(run);
      /** @type {any[]} */
      const content = [text(formatRunText(run))];
      const outputs = outputsText(run);
      if (outputs) content.push(text(outputs));
      const shot = summary.failingStep?.screenshot;
      if (shot && args.screenshot !== false) {
        try {
          const { bytes, mime } = await fetchBlob(session, `screenshot:${shot}`);
          content.push(text(`Screenshot of the page when step "${summary.failingStep?.id}" failed:`));
          content.push({ type: 'image', data: bytes.toString('base64'), mimeType: mime ?? 'image/png' });
        } catch (error) {
          content.push(text(`(The failure screenshot could not be fetched: ${describeError(error)})`));
        }
      }
      return { content, structuredContent: summary };
    }),
  );

  server.registerTool(
    'get_report',
    {
      title: 'Get a run report',
      description:
        'Exports finished runs as a report: json (machine-readable, schema in docs/guide/report.schema.json: every step with input, output, error code, locator, URL), junit (XML for CI) or html (self-contained). Choose runs by runIds, or by workflowId (its latest runs, up to limit); with neither, the latest runs of all workflows.',
      inputSchema: {
        format: z.enum(['json', 'junit', 'html']).optional().describe('Report format (default json).'),
        runIds: z.array(z.string()).optional().describe('Run ids (from run_workflow or run_suite).'),
        workflowId: z.string().optional().describe('Report the latest runs of this workflow.'),
        limit: z.number().int().positive().max(40).optional().describe('How many runs at most (default: the extension\'s default).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async (args) => {
      const params = /** @type {any} */ ({ format: args.format ?? 'json' });
      for (const key of ['runIds', 'workflowId', 'limit']) if (args[key] !== undefined) params[key] = args[key];
      const result = await resolve(session, await session.call('report', params));
      return { content: [text(result.content)], structuredContent: { format: result.format } };
    }),
  );

  server.registerTool(
    'snapshot_page',
    {
      title: 'Snapshot a page',
      description:
        'Returns an outline of a page as the browser sees it (with the user\'s logins): one line per element, `role "name" [state…] [ref] locator=…`. Copy the locator= part unchanged into click/fill/assert steps; never use the [ref=…] ids. Pass url (opened in a background tab, then closed) or tabId (an open tab). Take a snapshot before writing locators and again after a locator.not-found failure, on the failing step\'s page URL.',
      inputSchema: {
        url: z.string().optional().describe('An http(s) URL to open and outline.'),
        tabId: z.number().int().optional().describe('Id of an already open browser tab to outline instead.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (args) => {
      if (args.url === undefined && args.tabId === undefined) return { isError: true, content: [text('Pass url (a page to open) or tabId.')] };
      const params = /** @type {any} */ ({});
      if (args.url !== undefined) params.url = args.url;
      if (args.tabId !== undefined) params.tabId = args.tabId;
      const result = await resolve(session, await session.call('snapshot', params, { timeoutMs: SNAPSHOT_MS }));
      return { content: [text(result.outline)], structuredContent: { url: result.url, title: result.title } };
    }),
  );

  server.registerTool(
    'stop_run',
    {
      title: 'Stop a run',
      description: 'Stops a running workflow before its next block (the run ends as cancelled). runId comes from run_workflow progress messages or list results.',
      inputSchema: { runId: z.string().describe('Id of the run to stop.') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async ({ runId }) => {
      const result = await session.call('stop', { runId });
      return { content: [text(result.stopped ? `Stopping run ${runId}.` : `Run ${runId} was not running.`)], structuredContent: { stopped: Boolean(result.stopped) } };
    }),
  );

  server.registerTool(
    'list_suites',
    {
      title: 'List suites',
      description: 'Lists the saved suites (named, ordered lists of workflows run together, like a test suite): id, name, workflow ids, stopOnFailure. Run one with run_suite.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async () => {
      const { suites } = await resolve(session, await session.call('suite.list', {}));
      const lines = suites.map((suite) => `- ${suite.id} "${suite.name}": ${suite.workflowIds.length} workflow(s)${suite.stopOnFailure ? ', stops on the first failure' : ''}`);
      return { content: [text(suites.length ? `${suites.length} suite(s):\n${lines.join('\n')}` : 'No suites saved yet.')], structuredContent: { suites } };
    }),
  );

  server.registerTool(
    'run_suite',
    {
      title: 'Run a suite',
      description:
        'Runs several workflows one after another and waits for all of them. Pass one of: suiteId or name (a saved suite, see list_suites), or suite (an inline suite: {name, workflowIds?, sources?, stopOnFailure?}, where sources are scripts run without saving; an invalid source fails the suite before anything runs). Returns the overall status, one line per workflow with its failing step, and the reports asked for in formats (json, junit, html).',
      inputSchema: {
        suiteId: z.string().optional().describe('Id of a saved suite.'),
        name: z.string().optional().describe('Name of a saved suite.'),
        suite: z
          .object({
            name: z.string(),
            workflowIds: z.array(z.string()).optional(),
            sources: z.array(source).optional(),
            stopOnFailure: z.boolean().optional(),
          })
          .optional()
          .describe('An inline suite (not saved).'),
        secrets: secrets.optional(),
        formats: z.array(z.enum(['json', 'junit', 'html'])).optional().describe('Reports to return with the result.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    safe(async (args, extra) => {
      const chosen = ['suiteId', 'name', 'suite'].filter((key) => args[key] !== undefined);
      if (chosen.length !== 1) return { isError: true, content: [text('Pass exactly one of suiteId, name (a saved suite) or suite (an inline one).')] };
      const params = /** @type {any} */ ({});
      for (const key of ['suiteId', 'name', 'suite', 'secrets', 'formats']) if (args[key] !== undefined) params[key] = args[key];
      const report = progressReporter(extra);
      const result = await resolve(
        session,
        await session.call('suite.run', params, {
          timeoutMs: SUITE_MS,
          onNotification: (a, b) => {
            const { method, params: note } = readNotification(a, b);
            if (method === 'suite.progress') report(`${note.index + 1}/${note.total} "${note.workflowName}" ${note.status}`, note.total);
            else if (method === 'run.step' && note.step) report(`${note.step.sourceId ?? note.step.nodeId} ${note.step.blockType} ${note.step.status}`);
          },
        }),
      );
      const content = [text(formatSuiteText(result.result))];
      for (const [format, body] of Object.entries(result.reports ?? {})) content.push(text(`${format} report:\n${body}`));
      const { runs, ...rest } = result.result;
      return { content, structuredContent: { ...rest, runs: runs.map(summarizeRun), reports: result.reports } };
    }),
  );

  for (const resource of RESOURCES) {
    server.registerResource(
      resource.name,
      resource.uri,
      { title: resource.title, description: resource.description, mimeType: resource.mimeType },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: resource.mimeType, text: readResource(resource, options.resourceDirs) }] }),
    );
  }

  server.registerPrompt(
    'write-and-repair-test',
    {
      title: 'Write and repair a BlockFlow test',
      description: 'Write a BlockFlow test for a page, then run it in the browser and repair it until it passes.',
      argsSchema: {
        url: z.string().describe('The page the test starts on.'),
        goal: z.string().describe('What the test should do and check, in plain words.'),
      },
    },
    ({ url, goal }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: repairPrompt(url, goal) } }],
    }),
  );

  return {
    server,
    session,
    async close() {
      await server.close();
      await session.close().catch(() => {});
    },
  };
}

export function repairPrompt(url, goal) {
  return `Write a BlockFlow end-to-end test for ${url} that does this: ${goal}

Work in this loop, using the BlockFlow tools:

1. Read the resources blockflow://guide (sections "Rules for AI tools" and "Script format") and blockflow://blocks (block types and their config keys). Use only block types and keys from there.
2. Call snapshot_page with url ${url}. Copy locators from its locator= parts unchanged (role=…, label=…, text=…). Never invent locators and never use [ref=…] ids.
3. Write the test as a script: {"format":"blockflow-script","version":1,"name":"…","steps":[{"open":"${url}"}, …]}. Give each important step an "id" so failures name it. Check results with "assert" steps. Put passwords and tokens in {{secret.name}} and pass their values in run_workflow's secrets. Do not add waits "just in case": actions wait for their element.
4. Call validate_workflow with the script. If ok is false, fix every issue at the JSON path it names, following its hint (the Repair table in the guide explains each code), and validate again. Repeat until ok is true.
5. Call run_workflow with the script as source. If it passed, you are done: show the final script.
6. If it failed, read the summary: the failing step id and block type, error code, message, locator, page URL and the screenshot. Fix by the code (the guide's "Error codes" table): locator.not-found or locator.strict → snapshot_page on the failing page URL and use a locator from it (for strict, a more specific one); element.covered → close the overlay first; timeout or assert.failed → check what the page really shows in the screenshot and snapshot. Change only what the failure points at.
7. Validate and run again. Stop after 5 failed runs and explain what is still failing and why.

Answer with the final script as a JSON code block, and say which secrets (if any) the user must create.`;
}

export { VERSION, defaultConnector };

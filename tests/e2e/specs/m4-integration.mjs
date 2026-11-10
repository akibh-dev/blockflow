import { existsSync } from 'node:fs';

/**
 * M4 across the pieces: an agent's loop through the real MCP server (stdio) → native host → extension
 * against the fixture site (validate → run fails → read report → repair → run passes), suite.run over the
 * bridge with a combined JUnit report, and the editor's Suites page running a saved suite.
 * @param {import('../harness.mjs').Harness} h
 */
export default async function (h) {
  const { base, check, worker, bridge, path, here, seedWorkflows } = h;
  console.log('M4: MCP → bridge → extension, suites');
  const { installHost } = await import(path.resolve(here, '../../packages/bridge/install.mjs'));
  const { connectBridge } = await import(path.resolve(here, '../../packages/bridge/client.mjs'));
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  installHost({ dirs: bridge.hostsDirs, extensionIds: [h.extensionId] });
  await worker.evaluate(() => chrome.storage.local.set({ 'bf:settings': { outsideControl: true } }));

  let client;
  for (const deadline = Date.now() + 20_000; Date.now() < deadline && !client; ) {
    if (existsSync(bridge.socket) && existsSync(bridge.tokenFile)) {
      client = await connectBridge({ socketPath: bridge.socket, tokenFile: bridge.tokenFile, client: 'e2e', timeoutMs: 60_000 }).catch(() => undefined);
    }
    if (!client) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  check('the bridge is up for the integration checks', Boolean(client));
  if (!client) return;

  // --- MCP: the agent's repair loop ---
  const mcp = new Client({ name: 'blockflow-e2e', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve(here, '../../packages/mcp/server.mjs')],
    env: { ...process.env, BLOCKFLOW_SOCKET: bridge.socket, BLOCKFLOW_TOKEN_FILE: bridge.tokenFile },
    stderr: 'pipe',
  });
  await mcp.connect(transport);
  const text = (result) => (result.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
  const call = (name, args) => mcp.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
  try {
    const tools = (await mcp.listTools()).tools.map((tool) => tool.name);
    check('MCP lists the BlockFlow tools', ['validate_workflow', 'run_workflow', 'get_report', 'snapshot_page'].every((name) => tools.includes(name)), tools.join(','));

    const snapshot = await call('snapshot_page', { url: `${base}/welcome.html` });
    check('MCP snapshot_page outlines the fixture page through the bridge', !snapshot.isError && /Welcome/.test(text(snapshot)), text(snapshot).slice(0, 300));

    const broken = { format: 'blockflow-script', version: 1, name: 'MCP repair', steps: [
      { id: 'open', open: { url: `${base}/welcome.html`, active: false } },
      { id: 'see', assert: { locator: '#greeting', expected: 'Goodbye' }, step: { timeoutSeconds: 3 } },
      { id: 'close', 'close-tab': {} },
    ] };
    const invalid = await call('validate_workflow', { source: { ...broken, steps: [{ id: 'x', assert: { locater: '#a' } }] } });
    check('MCP validate_workflow returns issues with code and path', /\/steps\/0/.test(text(invalid)), text(invalid).slice(0, 300));

    const failed = await call('run_workflow', { source: broken });
    const failedText = text(failed);
    check('MCP run_workflow reports the failing step, code and locator', /failed/i.test(failedText) && /see/.test(failedText) && /assert\.failed/.test(failedText) && /#greeting/.test(failedText), failedText.slice(0, 500));
    check('MCP run_workflow attaches the failure screenshot', (failed.content ?? []).some((part) => part.type === 'image' && part.data?.length > 1000), JSON.stringify((failed.content ?? []).map((part) => part.type)));
    const runId = failed.structuredContent?.run?.id ?? failed.structuredContent?.runId ?? /run (?:id )?[:`]?\s*`?([\w-]+)/i.exec(failedText)?.[1];
    const report = await call('get_report', { format: 'junit', runIds: runId ? [runId] : undefined, limit: 1 });
    check('MCP get_report returns JUnit with the failure', /<failure/.test(text(report)), text(report).slice(0, 300));

    const repaired = await call('run_workflow', { source: { ...broken, steps: broken.steps.map((step) => (step.id === 'see' ? { id: 'see', assert: { locator: '#greeting', expected: 'Welcome' } } : step)) } });
    check('MCP run_workflow passes after the repair', !repaired.isError && /passed/i.test(text(repaired)), text(repaired).slice(0, 300));
  } finally {
    await mcp.close().catch(() => {});
  }

  // --- suite.run over the bridge ---
  const ok = { format: 'blockflow-script', version: 1, name: 'Suite ok', steps: [{ open: { url: `${base}/welcome.html`, active: false } }, { assert: { locator: '#greeting', expected: 'Welcome' } }, { 'close-tab': {} }] };
  const bad = { format: 'blockflow-script', version: 1, name: 'Suite bad', steps: [{ open: { url: `${base}/welcome.html`, active: false } }, { assert: { locator: '#greeting', expected: 'Nope' }, step: { timeoutSeconds: 2 } }, { 'close-tab': {} }] };
  const progress = [];
  const suite = await client.call('suite.run', { suite: { name: 'Bridge suite', sources: [ok, bad, ok] , stopOnFailure: true }, formats: ['junit', 'html'] }, { timeoutMs: 0, onNotification: (note) => note.method === 'suite.progress' && progress.push(note.params) });
  const junit = suite.reports?.junit ?? '';
  check('suite.run runs in order and stops at the first failure', suite.result?.status === 'failed' && suite.result.runs.length === 2 && suite.result.skipped.length === 1, JSON.stringify({ status: suite.result?.status, runs: suite.result?.runs.length, skipped: suite.result?.skipped }));
  check('suite.run streams suite.progress per workflow', progress.length === 3 && progress[2]?.status === 'skipped', JSON.stringify(progress));
  check('suite.run returns a combined JUnit report (one testcase per workflow)', (junit.match(/<testcase/g) ?? []).length === 3 && /<failure/.test(junit) && /<skipped/.test(junit), junit.slice(0, 400));
  check('suite.run returns the HTML report', /<html/i.test(suite.reports?.html ?? ''));
  await client.close();

  // --- editor Suites page ---
  const pass = { schemaVersion: 2, id: 'suite-page-ok', name: 'Page suite ok', enabled: false, nodes: [
    { id: 'open', type: 'open-url', position: { x: 0, y: 0 }, config: { url: `${base}/welcome.html`, active: false } },
    { id: 'see', type: 'assert', position: { x: 240, y: 0 }, config: { subject: 'text', locator: '#greeting', operator: 'contains', expected: 'Welcome' } },
    { id: 'close', type: 'close-tab', position: { x: 480, y: 0 }, config: {} },
  ], edges: [{ id: 'a', source: 'open', target: 'see' }, { id: 'b', source: 'see', target: 'close' }] };
  await seedWorkflows([pass]);
  await worker.evaluate((suites) => chrome.storage.local.set({ 'bf:suites': suites }), [{ id: 'page-suite', name: 'Smoke', workflowIds: ['suite-page-ok'] }]);
  const page = h.editor;
  await page.getByRole('button', { name: 'Suites', exact: true }).click();
  await page.getByRole('button', { name: 'Smoke' }).click();
  await page.getByRole('button', { name: '▶ Run suite' }).click();
  const shown = await page.locator('.bf-suite-result .bf-run-status').first().textContent({ timeout: 60_000 }).catch(() => null);
  check('the Suites page runs a saved suite and shows the result', shown === 'passed', String(shown));
  const download = page.waitForEvent('download', { timeout: 10_000 }).catch(() => null);
  await page.locator('.bf-suite-downloads button', { hasText: /junit/i }).first().click().catch(() => {});
  const file = await download;
  check('the Suites page downloads the JUnit report', Boolean(file) && /\.xml$/.test(file?.suggestedFilename() ?? ''), file?.suggestedFilename() ?? 'no download');

  // --- editor Settings page: the real switch, status, install command and the request log ---
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const toggle = page.getByLabel('Allow outside control');
  // The page shows the default (off) until storage has loaded.
  const shownOn = await page.waitForFunction(() => document.querySelector('[aria-label="Allow outside control"]')?.checked === true, null, { timeout: 10_000 }).then(() => true, () => false);
  check('the Settings page shows outside control on', shownOn);
  await page.getByText('Connected: local programs can use BlockFlow now').waitFor({ timeout: 10_000 }).then(() => true, () => false)
    .then((ok) => check('the Settings page shows the bridge connected', ok));
  check('the Settings page shows the install command with this extension id', (await page.locator('.bf-settings-command').textContent())?.includes(`--extension-id ${h.extensionId}`));
  check('the Settings page lists outside requests', (await page.locator('.bf-bridge-log tbody tr').count()) > 3);
  await toggle.click();
  let socketGone = false;
  for (const deadline = Date.now() + 10_000; Date.now() < deadline && !socketGone; ) {
    socketGone = !existsSync(bridge.socket);
    if (!socketGone) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  check('switching off on the Settings page stops the host', socketGone && (await worker.evaluate(async () => (await chrome.storage.local.get('bf:settings'))['bf:settings']?.outsideControl)) === false);
  await toggle.click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Allow outside control"]')?.checked === true, null, { timeout: 10_000 }).catch(() => {});
  let back = false;
  for (const deadline = Date.now() + 15_000; Date.now() < deadline && !back; ) {
    back = existsSync(bridge.socket);
    if (!back) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  check('switching on again on the Settings page restarts the host', back);
  await worker.evaluate(() => chrome.storage.local.set({ 'bf:settings': { outsideControl: false } }));
}

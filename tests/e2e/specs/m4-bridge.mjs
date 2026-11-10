import { existsSync } from 'node:fs';

/**
 * M4 bridge, end to end: a real native host (packages/bridge) installed for this throwaway profile,
 * the extension's native port, and the socket client. Outside control is switched on through storage
 * (as the Settings page does), then every method the extension serves is exercised against the fixture site.
 * @param {import('../harness.mjs').Harness} h
 */
export default async function (h) {
  const { base, check, worker, bridge, path, here } = h;
  console.log('M4: bridge (native host ⇄ extension, socket client)');
  const { installHost } = await import(path.resolve(here, '../../packages/bridge/install.mjs'));
  const { connectBridge } = await import(path.resolve(here, '../../packages/bridge/client.mjs'));
  installHost({ dirs: bridge.hostsDirs, extensionIds: [h.extensionId] });

  const settings = (value) => worker.evaluate((on) => chrome.storage.local.set({ 'bf:settings': { outsideControl: on } }), value);
  const status = () => worker.evaluate(async () => (await chrome.storage.session.get('bf:bridge-status'))['bf:bridge-status']);
  await settings(true);

  // The worker connects, Chromium starts the host, the host opens the socket.
  let client;
  let lastError = '';
  for (const deadline = Date.now() + 20_000; Date.now() < deadline && !client; ) {
    if (existsSync(bridge.socket) && existsSync(bridge.tokenFile)) {
      try {
        client = await connectBridge({ socketPath: bridge.socket, tokenFile: bridge.tokenFile, client: 'e2e', timeoutMs: 60_000 });
      } catch (error) {
        lastError = String(error);
      }
    }
    if (!client) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  check('switching outside control on starts the host and opens the socket', Boolean(client), `${lastError} status=${JSON.stringify(await status())}`);
  if (!client) return;
  const hello = await client.call('hello', { protocol: 1, client: 'e2e' });
  check('the worker reports the bridge connected', (await status())?.state === 'connected', JSON.stringify(await status()));
  check('hello answers with the extension id and version', hello.extensionId === h.extensionId && typeof hello.extensionVersion === 'string', JSON.stringify(hello));

  const script = {
    format: 'blockflow-script',
    version: 1,
    name: 'Bridge welcome',
    steps: [
      { id: 'open', open: { url: `${base}/welcome.html`, active: false } },
      { id: 'see', assert: { locator: '#greeting', expected: 'Welcome' } },
      { id: 'say', log: { message: 'token {{secret.bridgeToken}}' } },
      { id: 'close', 'close-tab': {} },
    ],
  };
  const valid = await client.call('validate', { source: script });
  check('validate accepts the fixture script', valid.ok === true && valid.workflows[0]?.nodes === 4, JSON.stringify(valid));
  const invalid = await client.call('validate', { source: { ...script, steps: [{ id: 'x', assert: { locater: '#a' } }] } });
  check('validate reports issues with codes and paths', invalid.ok === false && invalid.issues.some((issue) => issue.code && issue.path.startsWith('/steps/0')), JSON.stringify(invalid.issues));

  const imported = await client.call('import', { source: script, replace: true });
  const importedId = imported.workflows[0]?.id;
  check('import saves the workflow tagged via bridge', imported.workflows[0]?.viaBridge === true, JSON.stringify(imported));
  const listed = await client.call('list', {});
  check('list shows the imported workflow', listed.workflows.some((workflow) => workflow.id === importedId && workflow.viaBridge), JSON.stringify(listed));
  const stored = (await worker.evaluate(() => chrome.storage.local.get('bf:workflows')))['bf:workflows'] ?? [];
  check('the stored workflow carries importedVia', stored.some((workflow) => workflow.id === importedId && workflow.importedVia === 'bridge'));

  const secret = 'e2e-overlay-secret-4711';
  const notes = [];
  const ran = await client.call('run', { workflowId: importedId, secrets: { bridgeToken: secret } }, { onNotification: (note) => notes.push(note), timeoutMs: 0 });
  const started = notes.find((note) => note.method === 'run.started');
  const stepNotes = notes.filter((note) => note.method === 'run.step');
  check('run passes on the fixture site', ran.run?.status === 'passed', JSON.stringify(ran.run?.steps?.map((s) => `${s.nodeId}:${s.status} ${s.error ?? ''}`)));
  check('run streams run.started and run.step for the run', started?.params.runId === ran.run?.id && stepNotes.length >= 4 && stepNotes.every((note) => note.params.runId === ran.run?.id), JSON.stringify(notes.map((note) => note.method)));
  const storage = JSON.stringify(await worker.evaluate(() => chrome.storage.local.get(null)));
  check('the per-run secret is never stored (runs, logs, secrets, bridge log)', !storage.includes(secret) && !JSON.stringify(ran).includes(secret), 'secret found in storage or result');
  const logs = (await worker.evaluate(() => chrome.storage.local.get('bf:logs')))['bf:logs'] ?? [];
  check('the per-run secret is masked in the run log', logs.some((entry) => entry.message === 'token •••'), JSON.stringify(logs.slice(-5).map((entry) => entry.message)));

  const inline = await client.call('run', { source: { ...script, name: 'Bridge inline' } }, { timeoutMs: 0 });
  check('an inline source runs without being saved', inline.run?.status === 'passed' && !(await client.call('list', {})).workflows.some((workflow) => workflow.name === 'Bridge inline'), JSON.stringify(inline.run?.status));

  const junit = await client.call('report', { format: 'junit', runIds: [ran.run.id] });
  check('report junit for the run', junit.format === 'junit' && junit.content.includes('<testsuite name="Bridge welcome"'), String(junit.content).slice(0, 300));

  const snapshot = await client.call('snapshot', { url: `${base}/snapshot.html` });
  check('snapshot of a URL returns the outline', snapshot.title === 'Fixture: snapshot' && snapshot.outline.includes('Snapshot shop'), JSON.stringify(snapshot).slice(0, 300));
  const tabs = await worker.evaluate(async (url) => (await chrome.tabs.query({})).filter((tab) => tab.url?.startsWith(url)).length, `${base}/snapshot.html`);
  check('the snapshot tab is closed afterwards', tabs === 0, `${tabs} tab(s) left`);

  // A slow script: stop it while its timer waits.
  const slow = { format: 'blockflow-script', version: 1, name: 'Bridge slow', steps: [{ id: 'open', open: { url: `${base}/welcome.html`, active: false } }, { id: 'wait', timer: { seconds: 60 } }, { id: 'close', 'close-tab': {} }] };
  let runId;
  const stopping = client.call('run', { source: slow }, { onNotification: (note) => { if (note.method === 'run.started') runId = note.params.runId; }, timeoutMs: 0 });
  for (const deadline = Date.now() + 15_000; !runId && Date.now() < deadline; ) await new Promise((resolve) => setTimeout(resolve, 100));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const stop = runId ? await client.call('stop', { runId }) : { stopped: false };
  const stoppedRun = (await stopping).run;
  check('stop ends a running run', stop.stopped === true && stoppedRun?.status === 'cancelled', JSON.stringify({ stop, status: stoppedRun?.status }));
  const timed = (await client.call('run', { source: slow, timeoutSeconds: 3 }, { timeoutMs: 0 })).run;
  check('timeoutSeconds stops the run', timed?.status === 'cancelled' && /Timed out after 3 s/.test(timed?.error ?? ''), JSON.stringify({ status: timed?.status, error: timed?.error }));
  await worker.evaluate(async (url) => {
    for (const tab of await chrome.tabs.query({})) if (tab.url?.startsWith(url) && tab.id) await chrome.tabs.remove(tab.id).catch(() => {});
  }, `${base}/welcome.html`);

  const log = (await worker.evaluate(() => chrome.storage.local.get('bf:bridge-log')))['bf:bridge-log'] ?? [];
  check('every request is in bf:bridge-log', ['hello', 'validate', 'import', 'list', 'run', 'report', 'snapshot', 'stop'].every((method) => log.some((entry) => entry.method === method)), JSON.stringify(log.map((entry) => entry.method)));

  // Switching off: the extension sends bridge.disabled, the host closes its clients.
  await settings(false);
  const closed = await Promise.race([client.closed.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 10_000))]);
  check('switching outside control off closes the client connection', closed === true);
  await new Promise((resolve) => setTimeout(resolve, 500));
  check('the worker reports the bridge off', (await status())?.state === 'off', JSON.stringify(await status()));
  client.close();
  // Leave nothing from this spec behind for later specs.
  await worker.evaluate((id) => chrome.storage.local.get('bf:workflows').then((stored) => chrome.storage.local.set({ 'bf:workflows': (stored['bf:workflows'] ?? []).filter((workflow) => workflow.id !== id) })), importedId);
}

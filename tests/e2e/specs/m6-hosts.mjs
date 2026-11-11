// e2e for M6.2: the store build has no site access until the user grants it per workflow.
// Needs the e2e build WITHOUT host permissions (a prompt cannot be clicked in an automated browser):
//   BF_E2E_NO_HOSTS=1 npx wxt build            # -> .output-e2e-nohosts
//   BF_HEADLESS=1 BF_EXTENSION_DIR=.output-e2e-nohosts/chrome-mv3 node tests/e2e/run.mjs m6-hosts
// Against the normal e2e build (every site granted) the spec skips itself.

/** @param {import('../harness.mjs').Harness} h */
export default async function m6Hosts(h) {
  const { check, worker, workflow, run, step, summary, seedWorkflows, base } = h;
  console.log('M6.2 host access: no site access until granted');

  const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
  const granted = await worker.evaluate(() => chrome.permissions.contains({ origins: ['http://127.0.0.1/*'] }));
  if (granted || (manifest.host_permissions ?? []).length > 0) {
    console.log('  (skipped: this build has site access; build with BF_E2E_NO_HOSTS=1)');
    return;
  }
  check('the manifest asks for no site at install', (manifest.host_permissions ?? []).length === 0 && (manifest.optional_host_permissions ?? []).includes('<all_urls>'), JSON.stringify({ host: manifest.host_permissions, optional: manifest.optional_host_permissions }));

  const wf = workflow('M6 hosts', [
    { id: 'open', type: 'open-url', config: { url: `${base}/login.html`, active: false } },
    { id: 'see', type: 'click', config: { locator: 'role=button[name="Sign in"]' }, step: { timeoutSeconds: 5 } },
    { id: 'close', type: 'close-tab' },
  ]);
  await seedWorkflows([wf]);

  // The editor shows what the workflow needs, with a Grant button (the prompt itself is a human step).
  await h.editor.waitForSelector('.bf-permission', { timeout: 10_000 }).catch(() => {});
  const noteText = (await h.editor.locator('.bf-permission').allInnerTexts()).join(' ');
  check('the editor offers "Grant access" for the sites the workflow uses', /needs access to/i.test(noteText) && noteText.includes('127.0.0.1') && /Grant access/.test(noteText), noteText);

  // A run started anyway (a timer, the bridge) refuses with a clear code instead of failing mysteriously.
  const record = await run(wf);
  const failed = step(record, 'see');
  check('a page step without site access fails with permission.missing', record.status === 'failed' && failed?.code === 'permission.missing', `${failed?.code} ${summary(record)}`);
  check('…and the message names the site and how to grant it', /http:\/\/127\.0\.0\.1/.test(failed?.error ?? '') && /Run the workflow from the editor/.test(failed?.error ?? ''), failed?.error ?? '');

  // Steps that need no site access still work (the tab opened, the run reached the click).
  check('Open Tab works without site access (it needs no page access)', step(record, 'open')?.status === 'passed', summary(record));

  // Tidy: the opened tab.
  await worker.evaluate(async () => {
    for (const tab of await chrome.tabs.query({})) if (tab.url?.includes('login.html')) await chrome.tabs.remove(tab.id).catch(() => {});
  });
}

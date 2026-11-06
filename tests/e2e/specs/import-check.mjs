// e2e: importing a file checks it first (src/core/check.ts). A broken file is refused and every
// problem is listed in a dialog with its code and JSON path; a file with only warnings imports and
// says so in a toast whose "Details" opens the same list.
// Run alone with `npm run e2e -- import-check`. `h` is the shared harness (tests/e2e/harness.mjs).

/** @param {import('../harness.mjs').Harness} h */
export default async function importCheck(h) {
  const { check, worker } = h;
  console.log('Import checking: refused file lists its problems, warnings import with a toast');

  const workflows = async () => (await worker.evaluate(() => chrome.storage.local.get('bf:workflows')))['bf:workflows'] ?? [];
  const importText = async (name, data) => {
    await h.editor.locator('input[type=file]').first().setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data)) });
  };
  const issueRows = async () =>
    h.editor.locator('.bf-modal .bf-issue').evaluateAll((items) =>
      items.map((item) => ({
        code: item.querySelector('.bf-issue-code')?.textContent,
        path: item.querySelector('.bf-issue-path')?.textContent,
        hint: item.querySelector('.bf-issue-hint')?.textContent ?? '',
      })),
    );

  // --- a broken file: refused, problems listed -------------------------------------------------
  const before = (await workflows()).length;
  await importText('broken.blockflow.json', {
    format: 'blockflow-workflows',
    version: 1,
    workflows: [
      {
        name: 'Import check broken',
        nodes: [
          { id: 'open', type: 'open-tab', config: { url: 'https://example.com' } },
          { id: 'go', type: 'click', config: { locater: '#go' } },
        ],
        edges: [{ source: 'open', target: 'go' }],
      },
    ],
  });
  const modal = h.editor.locator('.bf-modal');
  await modal.waitFor({ timeout: 5_000 });
  const rows = await issueRows();
  const title = await modal.locator('h3').textContent();
  check(
    'a broken file is refused with every problem listed (code, JSON path, did-you-mean)',
    title?.includes('broken.blockflow.json') &&
      rows.some((row) => row.code === 'node.type.unknown' && row.path === '/workflows/0/nodes/0/type' && row.hint.includes('"open-url"')) &&
      rows.some((row) => row.code === 'config.key.unknown' && row.path === '/workflows/0/nodes/1/config/locater' && row.hint.includes('"locator"')),
    JSON.stringify(rows),
  );
  await modal.locator('button:has-text("Close")').click();
  await h.editor.waitForTimeout(500);
  check('nothing was imported from the broken file', (await workflows()).length === before && (await modal.count()) === 0);

  // --- warnings only: imported, toast with Details --------------------------------------------
  await importText('warns.blockflow.json', {
    name: 'Import check warnings',
    nodes: [{ id: 'go', type: 'click', config: { locator: '#go' } }],
    edges: [],
  });
  const toast = h.editor.locator('.bf-toast:has(.bf-toast-action)');
  await toast.waitFor({ timeout: 5_000 });
  await h.editor.waitForTimeout(500);
  check('a file with warnings imports', (await workflows()).some((w) => w.name === 'Import check warnings'));
  await toast.locator('.bf-toast-action').click();
  await modal.waitFor({ timeout: 5_000 });
  const warned = await issueRows();
  check('its toast opens the warnings (page.no-tab)', warned.some((row) => row.code === 'page.no-tab' && row.path === '/nodes/0'), JSON.stringify(warned));
  await h.editor.keyboard.press('Escape');
  await h.editor.waitForTimeout(300);
  check('Escape closes the issues dialog', (await modal.count()) === 0);
}

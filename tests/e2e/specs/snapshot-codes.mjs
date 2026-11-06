// e2e scenarios: Page Snapshot (M1.3) and coded step errors (M1.4) on tests/fixtures/site/snapshot.html.
// Run alone with `npm run e2e -- snapshot-codes`. `h` is the shared harness (tests/e2e/harness.mjs).

/** @param {import('../harness.mjs').Harness} h */
export default async function (h) {
  const { base, check, context, run, seedWorkflows, step, summary, workflow } = h;
  const open = { id: 'open', type: 'open-url', config: { url: `${base}/snapshot.html`, active: true } };
  /** Assert on the snapshot text (step payloads are cut in run records, asserts see all of it). */
  const has = (id, text, operator = 'contains') => ({ id, type: 'assert', config: { subject: 'value', value: '{{snapshot}}', operator, expected: text }, step: { onError: 'continue' } });

  {
    console.log('Page Snapshot: outline, locators, frames, shadow roots, cap');
    const expectations = [
      ['h1', '- heading "Snapshot shop" [level=1] [ref=e1] locator=role=heading[name="Snapshot shop"]'],
      ['nav', '- navigation "Main" [ref=e2]'],
      ['query', '- textbox "Query" [value="lamps"] [ref='],
      ['sort', '- combobox "Sort" [value="Cheapest"] [options="Newest | Cheapest"]'],
      ['stock', '- checkbox "In stock only" [checked]'],
      ['reset', '- button "Reset" [disabled]'],
      ['shadow', '- shop-badge [shadow]'],
      ['badge', 'locator=role=button[name="Badge action"]'],
      ['frame', '- iframe "Payment" [frame]'],
      ['card', 'locator=frame=#pay >> label="Card number"'],
      ['cap', '- … truncated at 1499 lines'],
    ];
    const wf = workflow('snapshot', [
      open,
      { id: 'snap', type: 'page-snapshot', config: {} },
      ...expectations.map(([id, text]) => has(id, text)),
      has('hidden1', 'Secret deal', 'not-contains'),
      has('hidden2', 'Also hidden', 'not-contains'),
      // The snapshot's locators work as they are.
      { id: 'fill', type: 'fill', config: { locator: 'frame=#pay >> label="Card number"', value: '4242' } },
      { id: 'pay', type: 'click', config: { locator: 'frame=#pay >> role=button[name="Pay"]' } },
      { id: 'paid', type: 'assert', config: { subject: 'text', locator: 'frame=#pay >> #paid', operator: 'contains', expected: 'Paid 4242' } },
      { id: 'part', type: 'page-snapshot', config: { locator: '#search' } },
      has('part-form', '- form "Search"'),
      has('part-only', 'Snapshot shop', 'not-contains'),
    ]);
    await seedWorkflows([wf]);
    const record = await run(wf);
    const failed = record.steps.filter((s) => s.status !== 'passed').map((s) => `${s.nodeId}: ${s.error}`);
    check('page-snapshot ran and every expectation about the outline held', record.status === 'passed' && failed.length === 0, failed.join('\n      ') || summary(record));
    const snap = step(record, 'snap');
    check('a 2,000-element page snapshots in under 5 s', (snap?.durationMs ?? 99_999) < 5_000, `${snap?.durationMs} ms`);
    console.log(`    (snapshot of the fixture took ${snap?.durationMs} ms)`);
  }

  {
    console.log('Coded step errors: not found, strict, disabled, assert, timeout');
    const quick = { onError: 'continue', timeoutSeconds: 3 };
    const wf = workflow('codes', [
      open,
      { id: 'missing', type: 'click', config: { locator: '#nope' }, step: quick },
      { id: 'strict', type: 'click', config: { locator: 'role=button[name="Add to cart"]' }, step: quick },
      { id: 'disabled', type: 'click', config: { locator: 'role=button[name="Reset"]' }, step: quick },
      { id: 'assert', type: 'assert', config: { subject: 'text', locator: '#greeting', operator: 'equals', expected: 'Bye' }, step: quick },
      { id: 'text', type: 'wait-for', config: { mode: 'text', text: 'never shown' }, step: quick },
      { id: 'invalid', type: 'click', config: { locator: 'role=button[bogus]' }, step: quick },
    ]);
    await seedWorkflows([wf]);
    const record = await run(wf);
    const code = (id) => step(record, id)?.code;
    check('missing element → locator.not-found, with locator and page URL', code('missing') === 'locator.not-found' && step(record, 'missing')?.locator === '#nope' && String(step(record, 'missing')?.url).endsWith('/snapshot.html'), JSON.stringify(step(record, 'missing')));
    const strict = step(record, 'strict');
    check(
      'two matches → locator.strict with both matches described',
      strict?.code === 'locator.strict' && strict.matches?.length === 2 && strict.matches.every((match) => match.includes('Add to cart')),
      JSON.stringify(strict),
    );
    check('disabled button → element.disabled', code('disabled') === 'element.disabled', JSON.stringify(step(record, 'disabled')));
    check('failed Assert → assert.failed with its locator', code('assert') === 'assert.failed' && step(record, 'assert')?.locator === '#greeting', JSON.stringify(step(record, 'assert')));
    check('text that never shows → timeout', code('text') === 'timeout', JSON.stringify(step(record, 'text')));
    check('bad locator syntax → locator.invalid', code('invalid') === 'locator.invalid', JSON.stringify(step(record, 'invalid')));

    // The Reports page exports it as versioned JSON.
    await h.editor.click('.bf-header .bf-tabs button:has-text("Reports")');
    const [download] = await Promise.all([h.editor.waitForEvent('download'), h.editor.click('button:has-text("Export JSON")')]);
    const report = JSON.parse(await (await import('node:fs/promises')).readFile(await download.path(), 'utf8'));
    const exported = report.runs?.find((candidate) => candidate.id === record.id);
    check('JSON export has schemaVersion 1 and the step codes', report.schemaVersion === 1 && exported?.steps.some((s) => s.code === 'locator.strict'), JSON.stringify(report).slice(0, 300));
  }

  {
    console.log('Editor: 📸 Snapshot page on Open Tab copies the outline');
    const wf = workflow('snapshot button', [{ id: 'open', type: 'open-url', config: { url: `${base}/snapshot.html` } }]);
    await seedWorkflows([wf]);
    // Playwright cannot grant clipboard access to an extension origin: catch what the editor writes instead.
    await h.editor.evaluate(() => {
      navigator.clipboard.writeText = async (text) => {
        window.__copied = text;
      };
    });
    await h.editor.click('.bf-node:has-text("Open Tab")');
    await h.editor.click('button:has-text("Snapshot page")');
    await h.editor.waitForSelector('.bf-toast', { timeout: 20_000 });
    const toastText = await h.editor.textContent('.bf-toast');
    const copied = String(await h.editor.evaluate(() => window.__copied ?? ''));
    check('the snapshot was copied, with the page title and URL', String(toastText).includes('copied') && copied.startsWith('# Page snapshot: Fixture: snapshot') && copied.includes(`URL: ${base}/snapshot.html`) && copied.includes('- button "Reset" [disabled]'), `${toastText}\n      ${copied.slice(0, 200)}`);
    for (const page of context.pages()) if (page.url().includes('/snapshot.html')) await page.close();
  }
}

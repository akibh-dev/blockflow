// e2e: Assert aria-snapshot (M5.4) on tests/fixtures/site/login.html and welcome.html: passing templates
// (whole page, a part by locator, regex names, states), a failing one with its message, and the same
// workflow exported to Playwright and run with real `npx playwright test` (toMatchAriaSnapshot).
// Run alone with `npm run e2e -- m5-aria`. `h` is the shared harness (tests/e2e/harness.mjs).

/** @param {import('../harness.mjs').Harness} h */
export default async function (h) {
  const { base, check, executablePath, here, path, run, seedWorkflows, step, summary, workflow } = h;
  const aria = (id, expected, extra = {}) => ({ id, type: 'assert', config: { subject: 'aria-snapshot', expected, ...extra } });

  // Templates that hold both in BlockFlow's outline and in Playwright's ARIA tree.
  const passing = () => [
    { id: 'open', type: 'open-url', config: { url: `${base}/login.html`, active: true } },
    aria('page', '- heading "Sign in" [level=1]'),
    aria(
      'form',
      [
        '- textbox "Email"',
        '- textbox "Password"',
        '- combobox "Country"',
        '- checkbox "Remember me" [checked=false]',
        '- paragraph:',
        '  - button "Sign in"',
        '  - button /Forgot( your)? password\\?/',
      ].join('\n'),
      { locator: 'form' },
    ),
    { id: 'login', type: 'fill-form', config: { fields: [{ locator: 'label=Email', value: 'ann@test.dev' }, { locator: 'label=Country', value: 'Bangladesh' }] } },
    { id: 'remember', type: 'check', config: { locator: 'label=Remember me' } },
    aria('checked', '- checkbox "Remember me" [checked]\n- paragraph:\n  - button /^Sign/', { locator: 'form' }),
    { id: 'go', type: 'navigate', config: { action: 'goto', url: `${base}/welcome.html?name=Ann&country=BD&remember=on` } },
    aria('welcome', '- heading /Welcome, \\w+!/ [level=1]\n- paragraph: /Country: BD/'),
  ];

  {
    console.log('Assert aria-snapshot: page, part, regex names, states; a failing template explains itself');
    const wf = workflow('M5 aria', [
      ...passing().slice(0, 3),
      { id: 'snap', type: 'page-snapshot', config: { locator: 'form' } },
      aria('wrong', '- paragraph:\n  - button "Sign up"', { locator: 'form' }),
      aria('order', '- button "Forgot password?"\n- button "Sign in"'),
      aria('nested', '- form:\n  - button "Sign in"'),
      aria('missing', '- button', { locator: '#nope' }),
    ].map((node) => (['wrong', 'order', 'nested', 'missing'].includes(node.id) ? { ...node, step: { onError: 'continue', timeoutSeconds: 3 } } : node)));
    const record = await run(wf);
    console.log(`    outline of the form:\n${String(step(record, 'snap')?.output?.snapshot ?? '').replace(/^/gm, '      ')}`);
    check('whole-page template passes', step(record, 'page')?.status === 'passed', summary(record));
    check('part of the page (locator) with regex name and [checked=false] passes', step(record, 'form')?.status === 'passed', step(record, 'form')?.error ?? summary(record));
    const wrong = step(record, 'wrong');
    check(
      'a wrong name fails with assert.failed, the template line, the closest button and the page part',
      wrong?.status !== 'passed' &&
        wrong.code === 'assert.failed' &&
        /template line 2 found nothing on the page:\n {2}- button "Sign up"/.test(wrong.error) &&
        wrong.error.includes('Closest on the page: - button "Sign in"') &&
        wrong.error.includes('its name is "Sign in", expected "Sign up"') &&
        !/ref=|locator=/.test(wrong.error),
      wrong?.error ?? summary(record),
    );
    console.log(`    failure message:\n${String(wrong?.error ?? '').replace(/^/gm, '      ')}`);
    const order = step(record, 'order');
    const nested = step(record, 'nested');
    check('a line that is deeper than its parent line says where it is', nested?.status !== 'passed' && String(nested?.error).includes('it is under - paragraph'), nested?.error);
    check('the wrong order fails and says so', order?.status !== 'passed' && String(order.error).includes('the order differs'), order?.error);
    const missing = step(record, 'missing');
    check('a locator that matches nothing fails after retrying', missing?.status !== 'passed' && String(missing.error).includes('no element matches #nope') && (missing.durationMs ?? 0) >= 1000, `${missing?.error} (${missing?.durationMs} ms)`);
  }

  {
    console.log('Assert aria-snapshot after the page changes, then exported to Playwright');
    const wf = workflow('M5 aria export', passing());
    const record = await run(wf);
    check('in BlockFlow: every aria-snapshot assert passes on login and welcome', record.status === 'passed', summary(record));

    await seedWorkflows([wf]);
    await h.editor.click('.bf-header .bf-tabs button:has-text("All workflows")');
    const fs = await import('node:fs/promises');
    const dir = path.resolve(here, '../../.output-aria-pw');
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    const row = h.editor.locator('.bf-table tr', { hasText: wf.name });
    const [download] = await Promise.all([h.editor.waitForEvent('download'), row.locator('button:has-text("Playwright")').click()]);
    const file = path.join(dir, 'aria.spec.ts');
    await fs.copyFile(await download.path(), file);
    const spec = await fs.readFile(file, 'utf8');
    const count = (spec.match(/\.toMatchAriaSnapshot\(`/g) ?? []).length;
    check(
      'the spec uses toMatchAriaSnapshot on the body and on the form, templates without BlockFlow hints',
      count === 4 && spec.includes(`tabs["main"].locator('body')).toMatchAriaSnapshot(`) && spec.includes('.locator("form").first()).toMatchAriaSnapshot(') && !spec.includes('ref='),
      spec.split('\n').filter((line) => line.includes('AriaSnapshot') || line.trim().startsWith('- ')).join('\n'),
    );
    await fs.writeFile(
      path.join(dir, 'playwright.config.mjs'),
      `export default { testDir: '.', timeout: 60000, workers: 1, reporter: 'line', use: { headless: true, launchOptions: { executablePath: ${JSON.stringify(executablePath)} } } };\n`,
    );
    const { spawn } = await import('node:child_process');
    const result = await new Promise((resolve) => {
      const child = spawn('npx', ['playwright', 'test', '--config', path.join(dir, 'playwright.config.mjs')], { cwd: path.resolve(here, '../..') });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
      const timer = setTimeout(() => child.kill(), 180_000);
      child.on('close', (status) => {
        clearTimeout(timer);
        resolve({ status, stdout, stderr });
      });
    });
    check('the exported spec passes under npx playwright test', result.status === 0 && /1 passed/.test(result.stdout), `${result.stdout}\n${result.stderr}`.slice(-3000));
  }
}

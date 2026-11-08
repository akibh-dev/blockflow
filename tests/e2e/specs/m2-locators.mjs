// e2e (M2.1, M2.2, M2.9, M2.14): locator filters and `||`, role states, the new Assert subjects, key
// chords in both input modes, and Press Key's insert-text mode, on tests/fixtures/site/m2.html. The
// synthetic-input workflow is then exported to Playwright and run with `npx playwright test`.
// Run alone with `npm run e2e -- m2-locators`. `h` is the shared harness (tests/e2e/harness.mjs).

/** @param {import('../harness.mjs').Harness} h */
export default async function (h) {
  const { base, check, executablePath, here, path, run, seedWorkflows, step, summary, workflow } = h;

  console.log('Locator filters, ||, role states and the new Assert subjects');
  const locators = workflow('M2: locators and asserts', [
    { id: 'open', type: 'open-url', config: { url: `${base}/m2.html`, active: true } },
    { id: 'del', type: 'click', config: { locator: 'role=listitem >> has-text=Banana >> role=button[name="Delete"]' } },
    { id: 'deleted', type: 'assert', config: { subject: 'text', locator: '#status', operator: 'equals', expected: 'deleted Banana' } },
    { id: 'rows', type: 'assert', config: { subject: 'count', locator: 'li >> visible >> has=button', operator: 'equals', expected: '2' } },
    { id: 'sold', type: 'assert', config: { subject: 'text', locator: '#cart li >> has-not=button >> has-not-text=Banana', operator: 'contains', expected: 'Cherry' } },
    { id: 'bold', type: 'click', config: { locator: 'role=button[name="Bold"][pressed=false]' } },
    { id: 'pressed', type: 'assert', config: { subject: 'text', locator: 'role=button[pressed]', operator: 'equals', expected: 'Bold' } },
    { id: 'menu', type: 'click', config: { locator: 'role=button[expanded=false]' } },
    { id: 'open-menu', type: 'assert', config: { subject: 'visible', locator: 'role=menu >> has-text=Open' } },
    { id: 'tab', type: 'click', config: { locator: 'role=tab[selected=false]' } },
    { id: 'selected', type: 'assert', config: { subject: 'text', locator: 'role=tab[selected]', operator: 'equals', expected: 'Two' } },
    { id: 'disabled', type: 'assert', config: { subject: 'text', locator: 'role=button[disabled]', operator: 'equals', expected: 'Archive' } },
    { id: 'save', type: 'click', config: { locator: '#missing || button >> has-text=Save >> visible' } },
    { id: 'saved', type: 'assert', config: { subject: 'text', locator: '#status', operator: 'equals', expected: 'saved' } },
    { id: 'class', type: 'assert', config: { subject: 'class', locator: '#save', operator: 'contains', expected: 'primary' } },
    { id: 'css', type: 'assert', config: { subject: 'css', locator: '#save', name: 'color', operator: 'equals', expected: 'rgb(0, 128, 0)' } },
    { id: 'name', type: 'assert', config: { subject: 'accessible-name', locator: '#email', operator: 'equals', expected: 'Email address' } },
    { id: 'desc', type: 'assert', config: { subject: 'accessible-description', locator: 'label=Email', operator: 'contains', expected: 'never share' } },
    { id: 'editable', type: 'assert', config: { subject: 'editable', locator: '#email' } },
    { id: 'ro', type: 'assert', config: { subject: 'editable', locator: '#ro' }, step: { timeoutSeconds: 2, onError: 'port' } },
    { id: 'ro-seen', type: 'set-variable', config: { name: 'readOnly', value: 'yes' } },
    { id: 'top', type: 'assert', config: { subject: 'in-viewport', locator: '#top' } },
    { id: 'far', type: 'assert', config: { subject: 'in-viewport', locator: '#far' }, step: { timeoutSeconds: 2, onError: 'port' } },
    { id: 'far-seen', type: 'set-variable', config: { name: 'below', value: 'yes' } },
    { id: 'focus', type: 'press-key', config: { key: 'Tab', locator: '#email' } },
    { id: 'focused', type: 'assert', config: { subject: 'focused', locator: '#ro' } },
    { id: 'close', type: 'close-tab' },
  ], [
    ['open', 'del'], ['del', 'deleted'], ['deleted', 'rows'], ['rows', 'sold'], ['sold', 'bold'], ['bold', 'pressed'], ['pressed', 'menu'], ['menu', 'open-menu'],
    ['open-menu', 'tab'], ['tab', 'selected'], ['selected', 'disabled'], ['disabled', 'save'], ['save', 'saved'], ['saved', 'class'], ['class', 'css'], ['css', 'name'],
    ['name', 'desc'], ['desc', 'editable'], ['editable', 'ro'], ['ro', 'ro-seen', 'error'], ['ro-seen', 'top'], ['top', 'far'], ['far', 'far-seen', 'error'],
    ['far-seen', 'focus'], ['focus', 'focused'], ['focused', 'close'],
  ]);
  {
    const record = await run(locators);
    check('run passed', record.status === 'passed', summary(record));
    check('has-text picked the Banana row\'s Delete button', step(record, 'deleted')?.status === 'passed', step(record, 'deleted')?.error);
    check('a read-only field is not editable', step(record, 'ro')?.status === 'handled', step(record, 'ro')?.error);
    check('an element far below is not in the viewport', step(record, 'far')?.status === 'handled', step(record, 'far')?.error);
  }

  /** Chords and insert-text on #keys, in one input mode. */
  const keys = (real) => {
    const settings = real ? { realInput: true } : {};
    return workflow(`M2: keys (${real ? 'real' : 'synthetic'} input)`, [
      { id: 'open', type: 'open-url', config: { url: `${base}/m2.html`, active: true } },
      { id: 'fill', type: 'fill', config: { locator: 'label=Keys', value: 'hello' } },
      { id: 'chord', type: 'press-key', config: { key: 'Control+Shift+K', locator: 'label=Keys' }, step: settings },
      { id: 'meta', type: 'press-key', config: { key: 'Meta+b' }, step: settings },
      { id: 'logged', type: 'assert', config: { subject: 'text', locator: '#log', operator: 'equals', expected: 'K+ctrl+shift (2 down) | b+meta (1 down)' } },
      { id: 'all', type: 'press-key', config: { key: 'ControlOrMeta+A', locator: 'label=Keys' }, step: settings },
      { id: 'sel', type: 'assert', config: { subject: 'text', locator: '#status', operator: 'equals', expected: 'selected 5 of 5' } },
      { id: 'insert', type: 'press-key', config: { mode: 'text', text: 'Hi 👋 {{url}}' }, step: settings },
      { id: 'value', type: 'assert', config: { subject: 'input', locator: 'label=Keys', operator: 'starts-with', expected: 'Hi 👋 http' } },
      { id: 'close', type: 'close-tab' },
    ]);
  };
  for (const real of [false, true]) {
    console.log(`Key chords and insert text, ${real ? 'real' : 'synthetic'} input`);
    const record = await run(keys(real));
    check('run passed', record.status === 'passed', summary(record));
    check('Control+Shift+K and Meta+b arrived with their modifiers, modifier keys first', step(record, 'logged')?.status === 'passed', String(step(record, 'logged')?.error));
    check('ControlOrMeta+A selected the field', step(record, 'sel')?.status === 'passed', String(step(record, 'sel')?.error));
    check('insert-text replaced the selection', step(record, 'value')?.status === 'passed', String(step(record, 'value')?.error));
  }

  console.log('Export the synthetic workflows to Playwright and run them');
  const flows = [locators, keys(false)];
  await seedWorkflows(flows);
  await h.editor.click('.bf-header .bf-tabs button:has-text("All workflows")');
  const fs = await import('node:fs/promises');
  const dir = path.resolve(here, '../../.output-e2e/m2-locators-export');
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  for (const [index, flow] of flows.entries()) {
    const row = h.editor.locator('.bf-table tr', { hasText: flow.name });
    const [download] = await Promise.all([h.editor.waitForEvent('download'), row.locator('button:has-text("Playwright")').click()]);
    await fs.copyFile(await download.path(), path.join(dir, `m2-${index + 1}.spec.ts`));
  }
  const all = (await Promise.all((await fs.readdir(dir)).map((name) => fs.readFile(path.join(dir, name), 'utf8')))).join('\n');
  check(
    'the specs use filters, or(), role states and the new matchers',
    ['.filter({ hasText: "Banana" })', '.filter({ has: ', '.filter({ visible: true })', '.or(', 'pressed: false', 'expanded: false', 'selected: true', 'disabled: true', 'toContainClass(', 'toHaveCSS(', 'toHaveAccessibleName(', 'toHaveAccessibleDescription(', 'toBeEditable(', 'toBeInViewport(', 'toBeFocused(', 'keyboard.insertText('].every((part) => all.includes(part)),
    all.slice(0, 400),
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
    const timer = setTimeout(() => child.kill(), 240_000);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
  check('the 2 exported specs pass under npx playwright test', result.status === 0 && /2 passed/.test(result.stdout), `${result.stdout}\n${result.stderr}`.slice(-3000));
}

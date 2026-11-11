// e2e for M6.1 encrypted secrets: protect with a passphrase, run a workflow that uses
// {{secret.loginPassword}}, simulate a browser restart (drop the session key) and confirm the run
// fails locked, then unlock through the editor and confirm the run passes again.
// Run with: BF_E2E=1 npx wxt build && BF_HEADLESS=1 node tests/e2e/run.mjs m6-secrets
import { PASSWORD } from '../server.mjs';

/** @param {import('../harness.mjs').Harness} h */
export default async function m6Secrets(h) {
  const { check, editor, worker, workflow, run, base } = h;
  console.log('M6.1 secrets: protect, run with {{secret.loginPassword}}, lock, unlock');

  // --- 1. Open the editor, go to Secrets, add loginPassword = h.PASSWORD ------------------
  await editor.click('.bf-tabs button:has-text("Secrets")');
  await editor.waitForTimeout(400);
  await editor.fill('input[aria-label="New secret name"]', 'loginPassword');
  await editor.fill('input[aria-label="New secret value"]', PASSWORD);
  await editor.click('button:has-text("Add secret")');
  await editor.waitForTimeout(400);
  const nameRow = await editor.locator('.bf-table tr:has(strong:has-text("loginPassword"))').count();
  check('secret loginPassword was added', nameRow === 1, String(nameRow));

  // --- 2. Protect with passphrase ---------------------------------------------------------
  await editor.fill('input[aria-label="New passphrase"]', 'correct horse battery');
  await editor.fill('input[aria-label="Repeat passphrase"]', 'correct horse battery');
  await editor.click('button:has-text("Protect with a passphrase")');
  await editor.waitForTimeout(400);
  check('protect form is gone (store encrypted, unlocked this session)',
    (await editor.locator('button:has-text("Protect with a passphrase")').count()) === 0);

  // --- 3. The password string must not appear in storage.local ----------------------------
  const stored = await worker.evaluate(() => chrome.storage.local.get('bf:secrets'));
  const value = stored['bf:secrets'];
  check('secrets are encrypted in storage.local (no plaintext)',
    typeof value === 'object' && value !== null && value.format === 'blockflow-secrets' && !JSON.stringify(value).includes(PASSWORD),
    JSON.stringify(value).slice(0, 200));

  // --- 4. Run a workflow that types {{secret.loginPassword}} on login.html -> passes ------
  const wf = workflow('secret login', [
    { id: 'open', type: 'open-url', config: { url: `${base}/login.html`, active: false } },
    {
      id: 'form',
      type: 'fill-form',
      config: {
        fields: [
          { locator: 'label=Email', value: 'user@example.com' },
          { locator: 'label=Password', value: '{{secret.loginPassword}}' },
        ],
        submit: 'role=button[name="Sign in"]',
      },
    },
    { id: 'wait', type: 'wait-for', config: { mode: 'url', url: '/welcome' } },
  ]);
  const unlockedRun = await run(wf);
  check('unlocked run passes ({{secret.loginPassword}} works)', unlockedRun.status === 'passed', h.summary(unlockedRun));

  // --- 5. Simulate a browser restart: drop the session key -> run fails locked ------------
  await worker.evaluate(() => chrome.storage.session.remove('bf:secrets-key'));
  const lockedRun = await run(wf);
  check('locked run fails with secrets.locked and runs no steps',
    lockedRun.status === 'failed' && String(lockedRun.error).includes('locked') && lockedRun.steps.length === 0,
    JSON.stringify(lockedRun));

  // --- 6. Unlock through the page -> run passes again -------------------------------------
  await editor.click('.bf-tabs button:has-text("Secrets")');
  await editor.waitForTimeout(400);
  await editor.fill('input[aria-label="Unlock passphrase"]', 'correct horse battery');
  await editor.click('button:has-text("Unlock")');
  await editor.waitForTimeout(400);
  const unlockedAgain = await run(wf);
  check('after unlock the run passes again', unlockedAgain.status === 'passed', h.summary(unlockedAgain));

  check('failures', h.failures === 0);
}

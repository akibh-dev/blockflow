// e2e: the authoring eval set (tests/evals/tasks.json) is solvable. Each reference solution in
// tests/evals/solutions is imported through the editor (so it is compiled and checked), run, and scored
// with the task's own checks, the same way a model's answer will be scored by the CLI (M4).
// Run alone with `npm run e2e -- evals`. `h` is the shared harness (tests/e2e/harness.mjs).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const evalsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../evals');

/** The value at a dot path; `length` works on lists and strings. */
function at(value, dotPath) {
  return dotPath.split('.').reduce((item, key) => (item == null ? undefined : item[key]), value);
}

/** One task check against a finished run and the imported workflow: [ok, detail]. */
function score(check, run, workflow) {
  if (check.kind === 'status') return [run.status === check.equals, `status ${run.status}`];
  if (check.kind === 'step-type') return [workflow.nodes.some((node) => node.type === check.type), `no ${check.type} block`];
  if (check.kind === 'output') {
    const values = run.steps.map((step) => at(step.output, check.path)).filter((value) => value !== undefined);
    const ok = values.some((value) =>
      'equals' in check ? value === check.equals : (typeof value === 'string' ? value : JSON.stringify(value)).includes(check.contains),
    );
    return [ok, `${check.path}: ${JSON.stringify(values).slice(0, 300)}`];
  }
  return [false, `unknown check kind ${check.kind}`];
}

/** @param {import('../harness.mjs').Harness} h */
export default async function evals(h) {
  const { base, check, run, seedWorkflows, summary, worker } = h;
  const { tasks } = JSON.parse(readFileSync(path.join(evalsDir, 'tasks.json'), 'utf8'));
  console.log(`Authoring evals: ${tasks.length} reference solutions import, run and pass their checks`);
  await seedWorkflows([]);
  const secrets = Object.assign({}, ...tasks.map((task) => task.secrets ?? {}));
  await worker.evaluate((values) => chrome.storage.local.set({ 'bf:secrets': values }), secrets);

  for (const task of tasks) {
    const text = readFileSync(path.join(evalsDir, 'solutions', `${task.id}.script.json`), 'utf8').replaceAll('{{BASE}}', base);
    const name = JSON.parse(text).name;
    await h.editor.locator('input[type=file]').first().setInputFiles({ name: `${task.id}.script.json`, mimeType: 'application/json', buffer: Buffer.from(text) });
    let workflow;
    for (let i = 0; i < 25 && !workflow; i += 1) {
      await h.editor.waitForTimeout(200);
      workflow = ((await worker.evaluate(() => chrome.storage.local.get('bf:workflows')))['bf:workflows'] ?? []).find((candidate) => candidate.name === name);
    }
    if (!workflow) {
      check(`${task.id}: imports`, false, 'not in storage after import');
      continue;
    }
    const result = await run(workflow);
    const failed = task.checks.map((item) => [item, ...score(item, result, workflow)]).filter(([, ok]) => !ok);
    check(`${task.id}: ${task.title}`, failed.length === 0, `${failed.map(([item, , detail]) => `${item.kind}: ${detail}`).join('; ')} | ${summary(result)}`);
  }
}

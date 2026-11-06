# Authoring evals

`tasks.json` holds ten tasks for measuring how well a model writes BlockFlow workflows from
[llms.txt](../../llms.txt) alone, against the fixture site in [tests/fixtures/site](../fixtures/site)
(served by [tests/e2e/server.mjs](../e2e/server.mjs)). They cover login, a failing login, a table, a
paged list, an infinite feed, a hidden file input, browser dialogs, a single-page app with a cookie
banner, a web component and a popup.

**How a task is scored.** Give the model `llms.txt` and the task's `prompt` (with `{{BASE}}` replaced by
the fixture server's origin). It answers with a workflow or script file. The task passes when the file
imports with no error issues, the run finishes, and every entry in `checks` holds (the check kinds are
described in the file). If it fails, the model gets one retry with the import issues (code, path, hint)
or the failed step's code and message. Target: 9 of 10 within two tries.

**Reference solutions.** `solutions/<task id>.script.json` is one passing answer per task, in the script
format. `npm run e2e -- evals` ([tests/e2e/specs/evals.mjs](../e2e/specs/evals.mjs)) imports each through
the editor, runs it and scores it with the task's checks, so every task is known to be solvable and the
scorer is tested. `tests/core/evals.test.ts` keeps `tasks.json` well formed and checks that each solution
imports with no issues.

**Scoring a model.** Automated scoring of a model's answers needs the CLI runner from M4
([IMPLEMENTATION.md](../../docs/IMPLEMENTATION.md)); it will reuse the scorer in `evals.mjs`. Until then,
paste `llms.txt` and a task into a chat, import the answer, and run it.

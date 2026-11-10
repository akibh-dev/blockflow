# BlockFlow wiki

BlockFlow is a browser extension for automating web pages (testing, forms, scraping, monitoring) by
connecting **blocks** in a visual editor or by writing the same workflow as a **JSON script**. The aim is
**Playwright-compatible automation in your browser**, usable by people through the editor and by LLMs
through well-defined scripts.

> **Status:** v0.4.0 + M3 (network and environment). 53 blocks, editor, recorder and reports; verified in Chromium, Brave and Firefox, with e2e tests for every block. See the [Roadmap](Roadmap.md).

## Using BlockFlow

| Page | For |
| --- | --- |
| [What is BlockFlow](What-is-BlockFlow.md) | The idea, how it compares to Playwright, when to use which |
| [Installing](Installing.md) | Build and load the extension, permissions |
| [Getting Started](Getting-Started.md) | Your first workflow, step by step |
| [Concepts](Concepts.md) | Blocks, data, triggers, tabs, locators, templates, runs |
| [Using the Editor](Using-the-Editor.md) | A tour of the editor: canvas, picker, recorder, reports, data, secrets |
| [Workflows as Scripts](Workflows-as-Scripts.md) | Writing workflows as JSON, for LLMs and developers; Playwright mapping and export |
| [Recipes](Recipes.md) | Login tests, data-driven tests, scraping, monitoring, forms, popups |
| [Capabilities and Limitations](Capabilities-and-Limitations.md) | What works, what doesn't yet, what no extension can do |
| [Troubleshooting](Troubleshooting.md) | Common errors and how to fix them |
| [Roadmap](Roadmap.md) | What's planned |

The detailed reference stays in the repo: the [usage guide](../guide/README.md) (also written for AI
tools) and the generated [block reference](../guide/blocks.md).

## Internals (for contributors)

What every module does, how the pieces talk, and how to change them safely. Read
[Contributing](../../CONTRIBUTING.md) and [Architecture](../ARCHITECTURE.md) first.

```text
 Editor (React, src/entrypoints/editor)      Background worker (src/entrypoints/background.ts)        Web pages
 ─────────────────────────────────────       ──────────────────────────────────────────────────        ─────────
 edit workflows ───────▶ storage ──────────▶ diff workflows, start/stop triggers
 Run / Stop / Pick ────▶ messages ─────────▶ WorkflowRunner (src/core) ──▶ Host (src/browser) ──▶ page agent (src/dom)
 run log, reports ◀───── storage ◀────────── runs, logs, datasets          alarms, tabs, CDP, offscreen
```

| Area | Pages |
| --- | --- |
| Engine (`src/core`) | [Core Engine](Core-Engine.md) · [Core Modules](Core-Modules.md) · [Page Protocol](Page-Protocol.md) · [Block Internals](Block-Internals.md) · [Adding a Block](Adding-a-Block.md) |
| Browser side (`src/browser`, `src/shared`) | [Background Worker](Background-Worker.md) · [Browser Host](Browser-Host.md) · [Scheduling and Timers](Scheduling-and-Timers.md) · [Message Protocol](Message-Protocol.md) · [Storage Keys](Storage-Keys.md) |
| In the page (`src/dom`) | [Page Agent](Page-Agent.md) · [Locators](Locators.md) · [Picker and Recorder](Picker-and-Recorder.md) |
| Editor (`src/entrypoints/editor`) | [Editor](Editor.md) · [Editor Components](Editor-Components.md) |
| Project | [Testing](Testing.md) · [Build and Release](Build-and-Release.md) · [Tooling and Scripts](Tooling-and-Scripts.md) |

Before you touch anything, know these rules from [CLAUDE.md](../../CLAUDE.md):

- `src/core` never imports browser APIs; it reaches the outside only through `Host`.
- Blocks never use `setTimeout` for workflow timing, because the MV3 worker sleeps.
- Payloads stay JSON-serialisable.
- After changing blocks, run `npm run guide:sync`. `npm run check` must pass.

## About this wiki

It lives in the repo at [docs/wiki](../wiki) and is published to the Forgejo and GitHub wikis with
`npm run wiki:publish`. Edit the repo files, never the web pages (the next publish overwrites them).

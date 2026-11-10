# Roadmap

Where BlockFlow is going. This page summarises the product plan; the full version, with the reasoning
and the decisions taken, is [docs/PLAN.md](../PLAN.md).

## The goal

BlockFlow aims to be **Playwright-compatible automation in your browser**, usable by **people through the block
editor** and by **LLMs through well-defined workflow scripts**. The same engine and the same file format
serve both.

## Milestones

| Milestone | What it brings |
| --- | --- |
| ✅ **M0: Stabilise and test** (done, v0.2.0) | Fixed the known bugs (copy and import losing step settings and branches, timeouts that don't stop a step, Start running on switch-on, and others). End-to-end tests for every block, in CI. Firefox verified with its own e2e run |
| ✅ **M1: Script-first** (done, v0.3.0) | Strict import checking with error codes, exact paths and "did you mean" hints; the script format (a list of steps) that compiles to blocks; auto-layout and Tidy up; a page snapshot (accessibility tree with ready locators) as a block and an Open Tab button; error codes on failed steps and in reports; `selector`/`next` renamed to `locator` with automatic migration; an eval set of ten authoring tasks |
| ✅ **M2: Playwright essentials** (done, v0.4.0) | Locator filters, click modifiers, focus/clear, drag and drop, drop zones, waiting for downloads, a Screenshot block, more Assert checks, cookies and storage control, Switch, loop-until |
| ✅ **M3: Network and environment** (done, v0.5.0) | Run-scoped CDP sessions; Route (mock, block, modify, redirect), HAR Record, Emulate (device, viewport, locale, timezone, location, media, offline), Clear Site Data, console capture and Assert `console-errors`. Chromium; block/redirect routes on every browser |
| ✅ **M4: Outside access** (done, v0.5.0) | A native-messaging bridge and an **MCP server**, so an AI agent can validate, run, read reports and fix workflows by itself; the `blockflow` CLI for CI; Suites with one combined report |
| ✅ **M5: Debugging and visual** (done, v0.6.0) | Trace timeline with before/after pictures, breakpoints with Step / Continue / Stop, visual comparison with baselines, ARIA snapshot assert, Run from here, re-run failed |
| **M6: Ship** | Encrypted secrets, a permissions review, store listings, and the completed wiki |

Order: M0 → M1 → M2. M3 and M4 can run in parallel after M1, then M5 and M6.

## What stays as it is

Everything built so far stays: the engine, Playwright-style locators and auto-wait, the 53 blocks,
triggers, the recorder and picker, reports, datasets, secrets and Playwright export. The plan is about
finishing and extending, not replacing.

## See also

- [Capabilities and Limitations](Capabilities-and-Limitations.md): today's ✅ / ❌ per feature
- [docs/PLAN.md](../PLAN.md): the full plan, the bug list and the decisions
- [docs/IMPLEMENTATION.md](../IMPLEMENTATION.md): how each milestone is built, task by task, with progress
- [What is BlockFlow](What-is-BlockFlow.md) · [Home](Home.md)

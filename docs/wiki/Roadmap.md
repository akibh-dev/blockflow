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
| **M1: Script-first** | Strict validation with exact error paths and suggestions; a simple linear `steps` format that compiles to blocks; auto-layout; a page snapshot (ARIA tree with ready locators) so LLMs can write correct locators; machine-readable errors |
| **M2: Playwright essentials** | Locator filters, click modifiers, focus/clear, drag and drop, drop zones, waiting for downloads, a Screenshot block, more Assert checks, cookies and storage control, Switch, loop-until |
| **M3: Network and environment** (Chromium) | Mock and block requests, HAR recording, device/viewport/location/timezone emulation, clean site data between runs |
| **M4: Outside access** | A local bridge and an **MCP server**, so an AI agent can validate, run, read reports and fix workflows by itself; a CLI runner for CI; suites |
| **M5: Debugging and visual** | Trace timeline with snapshots, breakpoints and step-through, visual comparison |
| **M6: Ship** | Encrypted secrets, a permissions review, store listings, and the completed wiki |

Order: M0 → M1 → M2. M3 and M4 can run in parallel after M1, then M5 and M6.

## What stays as it is

Everything built so far stays: the engine, Playwright-style locators and auto-wait, the 42 blocks,
triggers, the recorder and picker, reports, datasets, secrets and Playwright export. The plan is about
finishing and extending, not replacing.

## See also

- [Capabilities and Limitations](Capabilities-and-Limitations.md): today's ✅ / ❌ per feature
- [docs/PLAN.md](../PLAN.md): the full plan, the bug list and the decisions
- [docs/IMPLEMENTATION.md](../IMPLEMENTATION.md): how each milestone is built, task by task, with progress
- [What is BlockFlow](What-is-BlockFlow.md) · [Home](Home.md)

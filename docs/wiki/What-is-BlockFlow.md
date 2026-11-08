# What is BlockFlow

Start here if you're new. This page explains what BlockFlow is for, how it compares to Playwright, and
when to use which.

## In one paragraph

BlockFlow is a browser extension for automating web pages: testing them, filling forms, scraping data
and watching for changes. You build an automation by connecting **blocks** (Open Tab → Fill Form → Assert)
on a canvas, or you write the same thing as a **JSON script**. That makes it usable by people who never
write code and by LLMs that generate scripts. It runs in your own browser (Chromium-based browsers such as Chrome, Edge and Brave today;
Firefox experimental), with your logins.

## The goal: Playwright-compatible automation in your browser

[Playwright](https://playwright.dev) is the standard tool for driving browsers from code. BlockFlow
borrows its *ideas* so that what you know transfers both ways:

| Playwright | BlockFlow |
| --- | --- |
| `page.getByRole('button', { name: 'Save' })` | locator `role=button[name="Save"]` |
| Actions auto-wait for the element to be visible, enabled, stable, not covered | Same checks, with the same messages ("is covered by div#overlay") |
| Strict locators: two matches is an error | Same |
| `expect(locator).toHaveText(…)` retries until it passes | **Assert** retries until it passes or times out |
| `npx playwright codegen` | **● Record** in the editor |
| A test is a `.spec.ts` file | A test is a workflow: blocks on a canvas, saved as a `.blockflow.json` file |

A workflow can also be exported as a Playwright `.spec.ts` to run in CI.

## Two ways to use it

**As a person:** open the editor, start from a template or click **● Record** and use the page, pick
elements with 🎯, press **▶ Run**, and read the report. See [Getting Started](Getting-Started.md).

**As an LLM or a program:** generate a workflow file following the [usage guide](../guide/README.md)
and the generated [block reference](../guide/blocks.md), then import it. The format has a JSON Schema and
validation. See [Workflows as Scripts](Workflows-as-Scripts.md).

Both produce the same thing, so a person can open and fix a workflow a model wrote, and the reverse.

## Being an extension: what's better, what's harder

| Better than a test runner | Harder than a test runner |
| --- | --- |
| Runs in your real, logged-in browser: no login scripts | No headless mode and no fresh browser per test (your profile is shared) |
| Triggers: run when a page opens, from the right-click menu, on a schedule, or when an element changes | The browser may put the extension to sleep. BlockFlow is built around this, but very long runs depend on it |
| Nothing to install besides the extension; share a workflow as one file | Trusted input, and later network mocking and emulation, need an optional "debugger" permission (Chromium only) |
| A person can step in (CAPTCHA, 2FA) with Manual Step | Browser-protected pages (`chrome://`, web stores, PDF viewer) can't be automated |

The full list is in [Capabilities and Limitations](Capabilities-and-Limitations.md).

## When to use which

- **BlockFlow:** you want to automate something in *your* browser, without code or with an LLM writing it.
  Examples: monitoring pages, routine form work, scraping behind a login, or smoke tests you click
  together and share with a team.
- **Playwright:** large test suites in CI, many browsers in parallel, full network control on every
  engine. Start in BlockFlow and export when you outgrow it.

## Status

BlockFlow is a **prototype**. It has 49 blocks, a canvas editor, a recorder, reports and a background
engine. It has been verified in Chromium and Brave. Firefox and Safari aren't fully verified. What comes next is in the
[Roadmap](Roadmap.md).

## See also

- [Getting Started](Getting-Started.md) · [Concepts](Concepts.md) · [Installing](Installing.md)
- [Workflows as Scripts](Workflows-as-Scripts.md) · [Capabilities and Limitations](Capabilities-and-Limitations.md)
- [Roadmap](Roadmap.md) · [Home](Home.md)

# Maintaining the learning material

For Claude (or any contributor). The reader is the project owner, who knows React/Next.js/SaaS but is
new to extensions, and wants to **hand-code their own extension**. Lessons must teach, not just document.

## Rules

1. **Write lessons while building.** When a feature teaches a concept (a new API, a new gotcha, a design
   decision), add or extend a lesson in the same change. Update the lesson that already covers it rather than
   appending a new one. Add a "In BlockFlow" pointer to the real file.
2. **Code in lessons is the source of truth for examples.** A fence like
   ```` ```js file=05-name/popup.js ```` is extracted to `examples/05-name/popup.js` by
   `node docs/learning/tools/sync-examples.mjs`. Run it after editing; `--check` must pass before commit.
   Never hand-edit files under `examples/`.
3. **Verify before claiming.** Every example extension must be loaded in a real Chromium and exercised
   (see lesson 8 for the Playwright recipe). Each lesson states honestly what was verified; a lesson
   written without running it carries a `> **Status:**` note at the top. Do not delete such notes until it has been run.
4. **Teach by structure:** goal → concept → steps with code to type → checkpoint (what you should see) →
   common problems → exercises → "In BlockFlow" → next link. Keep each lesson to one sitting.
5. **Use the reader's vocabulary.** Translate to React/Next/SaaS concepts first (see the cheat sheet in
   `README.md`), then show the extension-specific difference.
6. **Keep the glossary and README index current**, and keep claims about the project in line with the code
   (file names, function names, numbers). Grep before you cite a name.
7. Plain JS for lessons 1 to 5 (no build tooling) so nothing hides the mechanism; TypeScript/React only
   from lesson 6.

## When to touch which lesson

| You changed | Update |
| --- | --- |
| Scheduling, alarms, worker lifecycle | 04, glossary, 07 table |
| Element picker / messages | 03, 07 |
| Watch Element / tab handling | 05, 07 |
| Build, WXT config, entrypoints | 06, 07 |
| Test approach, new test layer | 08, 07 |
| New block type | 07 exercises (remove an exercise if you built it) |

## Template for a new lesson

```markdown
# Lesson N: Title

Goal: one sentence, something that runs at the end.
You will learn: concepts, APIs.
Finished version: examples/NN-name

## Step 1 ... (code fences with file= for anything that ends up in examples/)

## Checkpoint
What you should see. Table of common problems.

## Exercises
3-5, in rising difficulty; at least one that forces them to break and fix something.

## In BlockFlow
Pointers to real files.

Next: link
```

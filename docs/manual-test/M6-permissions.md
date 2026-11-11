# Manual check: site access per workflow (M6.2) — needs a person

Automated tests cannot click the browser's permission prompt, so this part is manual. The automated part
(`tests/e2e/specs/m6-hosts.mjs`, built with `BF_E2E_NO_HOSTS=1`) checks the refusal path and the editor note.

Use the **normal** build (`npm run build`, load `.output/chrome-mv3` unpacked; Firefox:
`npm run build:firefox`, `about:debugging` → Load Temporary Add-on) and a fixture or any public page.

## Chrome / Edge / Brave

1. `chrome://extensions` → BlockFlow → **Details** → "Site access": it must say it has **no** site access
   ("On click" / "Allow this extension to read and change all your data…" off). The install warning must not
   mention "Read and change all your data on all websites".
2. Open the editor, create a workflow: Open Tab `https://example.com` → Click `text=More information` → Assert.
3. The editor shows "This workflow needs access to **example.com**" with a **Grant access** button.
4. Press **▶ Run** (not the button): the browser prompts for example.com. **Decline** → a toast says BlockFlow
   needs access, no run starts.
5. Press **▶ Run** again, **Allow** → the run passes. Details → Site access now lists example.com.
6. Edit the Open Tab URL to `https://{{host}}/` → the note now says "all sites"; Run asks for all sites.
7. Switch the workflow **On** with a Timer start while access is missing: the browser prompts at the click.
   Decline → it stays Off with a toast.
8. Revoke the access in the browser, leave a Timer workflow On, wait for it to fire: the run fails with
   `permission.missing` naming the site (see Reports).

## Firefox

Repeat 2–5. Firefox shows site access under `about:addons` → BlockFlow → Permissions → "Optional permissions".

## Record

Note the browser version, what you saw, and anything that differs from the above in `docs/M6-NOTES.md`.

# Gotcha — Development

MV3 extension built with Vite + `@crxjs/vite-plugin` + TypeScript (strict).
Covers the full `PRD.md` feature set — MVP capture, the v1.5 moat (Playwright
test-gen + `chrome.debugger` deep capture), and v2 surfaces (Jira/GitHub
integrations, team dashboard, settings).

## Run it

```bash
npm install
npm run build          # → dist/
```

Then load it in Chrome:

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select the `dist/` folder
3. Open any regular web page (not `chrome://`), click the 🐛 toolbar icon → **Capture this bug**

`npm run dev` runs Vite with HMR for the popup/review UI. (MAIN-world hooks
can't hot-reload — rebuild and reload the extension after editing those.)

## Architecture (as built)

```
MAIN world (src/injected/, document_start)        ← wraps globals before the page runs
  console-hook · network-hook · error-hook · repro-recorder
        │  window.postMessage (BRIDGE_MARKER)
        ▼
ISOLATED content (src/content/)                    ← source of truth for THIS tab
  buffer-store (ring buffers) · packager (DOM + env snapshot)
        │  chrome.runtime.sendMessage { bundle:save }
        ▼
Service worker (src/background/)                   ← ephemeral, holds NO capture state
  screenshot (captureVisibleTab) · IndexedDB (extension origin) · Linear filing
        │  opens
        ▼
Review page (src/review/)                          ← edit, redact, file → success
```

**Why buffers live in the content script, not the worker:** the MV3 worker is
evicted after ~30s idle. State there would be lost the moment the user hits a
bug. The content script is always buffering from `document_start`, so the
recent past is already captured the instant they click capture.

**Why the worker persists, not the content script:** IndexedDB is per-origin.
The content script's IndexedDB is the *page's* origin; the review page runs in
the *extension* origin. Only the worker (extension origin) can write a store
the review page can read — so the content script hands the packaged bundle to
the worker to persist.

## Layout

| Path | Role |
|---|---|
| `src/injected/` | MAIN-world hooks (no `chrome.*`; postMessage only) |
| `src/content/` | ISOLATED buffers, packaging, DOM snapshot, in-page widget |
| `src/background/` | Service worker: screenshot, persistence, filing, deep capture |
| `src/integrations/` | Pluggable filing: Linear, Jira, GitHub (simulate without keys) |
| `src/testgen/` | Repro → runnable Playwright `.spec.ts` (the moat) |
| `src/shared/` | Bundle types + Zod schemas, messaging contract, redaction |
| `src/popup/` · `src/review/` · `src/dashboard/` · `src/options/` · `src/ui/` | UI + shared design tokens |

## The six screens (PRD / prototype) → code

| Screen | Where |
|---|---|
| 1 Popup | `src/popup/` — one-click capture, recording session, deep-capture toggle |
| 2 Capture | `src/content/widget.ts` — Shadow-DOM recording overlay |
| 3 Review | `src/review/` — edit, redact, annotate screenshot (box/arrow/blur) |
| 4 File | `src/review/` file step — pick Linear/Jira/GitHub, assignee, priority |
| 5 Done | `src/review/` success — ticket link + generated Playwright test |
| 6 Dashboard | `src/dashboard/` — reports, generated tests, insights, KPIs |

## Filing & credentials

Without credentials every integration returns a simulated reference (`GOT-###`
/ `BUG-###` / `#123`) so the full flow is demonstrable offline. To file for
real, open the extension's **Settings** page (right-click the icon → Options,
or the dashboard's "Integrations & settings") and fill in:

- **Linear** — API key + team id
- **Jira** — host, email, API token, project key
- **GitHub** — fine-grained PAT (Issues: write) + `owner/repo`

## Deep capture (v1.5)

The popup's **Deep capture** toggle attaches `chrome.debugger` to the active
tab (Chrome shows a debug banner — hence opt-in) and records full response
bodies plus requests fired before the page's own code ran. Those entries are
merged into the bundle at finish time, superseding the monkey-patched copies.

## Still PRD-roadmap, not built

These are explicitly v2+ "data flywheel" items that need a backend/shared
workspace, out of scope for a local extension build: SSO, org-specific selector
learning, configurable per-workspace redaction rules, self-host, and team-wide
analytics (real cannot-reproduce rate / triage-time deltas, which need
before/after data the local store can't provide).

# 🐛 Gotcha

> **One-click bug report that ships with a runnable regression test.**
> *Caught the bug, caught the excuse.*

A Chrome (Manifest V3) extension that captures a complete, reproducible bug report from
any web app — screenshot, console errors, failed network requests, auto-recorded repro
steps, DOM snapshot, environment — and files it into Linear/Jira. The moat: those repro
steps become a runnable **Playwright regression test**.

## Contents

| File | What |
|---|---|
| `PRD.md` | Full product requirements — problem, users, moat, features, MV3 architecture, roadmap, risks |
| `prototype.html` | Clickable 6-screen prototype (open in any browser) |
| `DEVELOPMENT.md` | How to build, load, and the as-built MV3 architecture |
| `src/` | The extension — MVP capture-engine core (TypeScript + Vite) |

## Build & run

```bash
npm install && npm run build        # → dist/
# chrome://extensions → Developer mode → Load unpacked → select dist/
```

See `DEVELOPMENT.md` for the architecture and the Linear filing setup.

## The 6 screens

1. **Popup** — toolbar click, background capture running, recent reports
2. **Capture** — in-page recording overlay on the app under test
3. **Review** — everything captured, edit & redact before filing
4. **File** — pick integration (Linear first), assignee, priority
5. **Done** — filed with full evidence + generated Playwright test
6. **Dashboard** — team view + the metrics that sell renewals

## View the prototype

```bash
open prototype.html
```

## The wedge (why not just Jam)

We don't compete on *better capture* — we compete on **capture that becomes coverage.**
Every filed bug → captured repro → a test in CI → fewer regressions over time. That
test-gen flywheel improves per-customer with usage and is the durable moat.

## Open decisions

1. First integration — **Linear** (recommended) or Jira?
2. Test-gen in v1 or v1.5? (Recommended: v1.5 — it's the wedge, not the week-1 build.)
3. Free vs paid line at launch.
4. ICP — agencies/small QA teams, or mid-size in-house eng?

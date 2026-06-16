import type { RuntimeResponse, BundleSummary } from '@shared/messaging';
import type { CaptureBundle } from '@shared/types';
import { MAX_REPORTS, WARN_REPORTS } from '@shared/capture-config';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
};

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const gotId = (id: string): string => 'GOT-' + id.slice(0, 4).toUpperCase();

async function listSummaries(): Promise<BundleSummary[]> {
  const res = (await chrome.runtime.sendMessage({ type: 'bundle:list' })) as
    | RuntimeResponse
    | undefined;
  return res && res.ok && 'bundles' in res ? res.bundles : [];
}

function renderKpis(rows: BundleSummary[]): void {
  const total = rows.length;
  const tested = rows.filter((r) => r.hasTest).length;
  const filed = rows.filter((r) => r.filed).length;
  const pct = (n: number): string => (total ? `${Math.round((n / total) * 100)}%` : '–');
  $('kpis').innerHTML = `
    <div class="kpi"><div class="n">${total}</div><div class="l">Reports captured</div><div class="d">local to this browser</div></div>
    <div class="kpi"><div class="n">${tested}</div><div class="l">Tests generated</div><div class="d">${pct(tested)} of reports</div></div>
    <div class="kpi"><div class="n">${filed}</div><div class="l">Filed to tracker</div><div class="d">${pct(filed)} of reports</div></div>`;
}

// Warn as the report count approaches the cap. At MAX_REPORTS the oldest is
// auto-deleted on the next save, so nudge the user to clear space first.
function renderStorageWarning(rows: BundleSummary[]): void {
  const el = $('storage-warning');
  if (rows.length < WARN_REPORTS) {
    el.hidden = true;
    return;
  }
  const atCap = rows.length >= MAX_REPORTS;
  el.hidden = false;
  el.classList.toggle('at-cap', atCap);
  el.innerHTML = atCap
    ? `<b>Storage limit reached (${rows.length}/${MAX_REPORTS}).</b> New reports now delete the oldest automatically. Delete reports you no longer need to keep your history and keep the dashboard fast.`
    : `<b>${rows.length} of ${MAX_REPORTS} reports stored.</b> At ${MAX_REPORTS} the oldest report is deleted automatically on each new capture. Delete some you no longer need — large histories also slow the dashboard.`;
}

function renderReports(rows: BundleSummary[]): void {
  const body = $('reports-body');
  $('reports-empty').hidden = rows.length > 0;
  body.innerHTML = rows
    .map((r) => {
      // Evidence chips: clear labels + tooltips, single line. The most
      // diagnostic counts — failed requests, console errors, repro steps.
      const chip = (n: number, label: string, title: string, alert = false): string =>
        `<span class="ev-chip${alert && n > 0 ? ' ev-alert' : ''}" title="${title}"><b>${n}</b>${label}</span>`;
      const ev =
        `<div class="evidence">` +
        chip(r.counts.failed, 'failed', 'Failed network requests', true) +
        chip(r.counts.errors, 'errors', 'Console errors', true) +
        chip(r.counts.steps, 'steps', 'Repro steps recorded') +
        `</div>`;
      const test = r.hasTest ? '<span class="tag ok">✓ generated</span>' : '<span class="tag plain">–</span>';
      const filed = r.filed
        ? `<span class="tag ok">${esc(r.filed.identifier)}</span>`
        : '<span class="tag plain">open</span>';
      return `<tr data-id="${r.id}">
        <td class="mono">${gotId(r.id)}</td>
        <td>${esc(r.title)}</td>
        <td>${new Date(r.createdAt).toLocaleDateString()}</td>
        <td>${ev}</td>
        <td>${test}</td>
        <td>${filed}</td>
        <td class="col-actions"><button class="del-btn" data-del="${r.id}" title="Delete report" aria-label="Delete report">🗑</button></td>
      </tr>`;
    })
    .join('');
  body.querySelectorAll<HTMLElement>('tr').forEach((tr) => {
    tr.addEventListener('click', () => {
      void chrome.tabs.create({
        url: chrome.runtime.getURL(`src/review/review.html?id=${tr.dataset.id}`),
      });
    });
  });
  body.querySelectorAll<HTMLButtonElement>('.del-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      void deleteReport(btn.dataset.del!);
    });
  });
}

async function deleteReport(id: string): Promise<void> {
  if (!confirm(`Delete report ${gotId(id)}? This cannot be undone.`)) return;
  await chrome.runtime.sendMessage({ type: 'bundle:delete', id });
  // Re-render only — re-running init() would stack a second set of nav
  // listeners (with stale captured rows) on every delete.
  await refresh();
}

async function renderTests(rows: BundleSummary[]): Promise<void> {
  const withTests = rows.filter((r) => r.hasTest);
  $('tests-empty').hidden = withTests.length > 0;
  const list = $('tests-list');
  list.innerHTML = '';
  for (const r of withTests) {
    const res = (await chrome.runtime.sendMessage({ type: 'bundle:get', id: r.id })) as
      | RuntimeResponse
      | undefined;
    if (!res || !res.ok || !('bundle' in res) || !res.bundle.generatedTest) continue;
    const test = (res.bundle as CaptureBundle).generatedTest!;
    const card = document.createElement('div');
    card.className = 'test-card';
    card.innerHTML = `<div class="top">
        <span class="tag red">${esc(gotId(r.id))}</span>
        <span class="name mono">${esc(test.filename)}</span>
      </div>
      <pre>${esc(test.source)}</pre>`;
    list.appendChild(card);
  }
}

function renderInsights(rows: BundleSummary[]): void {
  const total = rows.length || 1;
  const tested = rows.filter((r) => r.hasTest).length;
  const filed = rows.filter((r) => r.filed).length;
  const withFailed = rows.filter((r) => r.counts.failed > 0).length;
  const avgSteps = Math.round(rows.reduce((a, r) => a + r.counts.steps, 0) / total);
  $('insights-body').innerHTML = `
    <div class="insight-row"><span>Reports with a failing request</span><b>${withFailed}/${rows.length}</b></div>
    <div class="insight-row"><span>Reports converted to a test</span><b>${tested}/${rows.length}</b></div>
    <div class="insight-row"><span>Reports filed to a tracker</span><b>${filed}/${rows.length}</b></div>
    <div class="insight-row"><span>Average repro steps per report</span><b>${avgSteps}</b></div>`;
}

const VIEWS = ['reports', 'tests', 'insights'] as const;
type View = (typeof VIEWS)[number];

function showView(view: View): void {
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== view;
  document.querySelectorAll<HTMLElement>('.nv[data-view]').forEach((nv) => {
    nv.classList.toggle('on', nv.dataset.view === view);
  });
}

// Re-fetch summaries and repaint every data-driven panel. Safe to call after
// any mutation (e.g. delete) — listener wiring lives in bindNav() instead, so
// repainting never duplicates handlers.
async function refresh(): Promise<void> {
  const rows = await listSummaries();
  renderKpis(rows);
  renderStorageWarning(rows);
  renderReports(rows);
  renderInsights(rows);
}

// Bound-once guard: init() used to attach these on every call, so each delete
// stacked another handler closing over a stale row list — N+1 handlers,
// interleaved async re-renders, and cards for deleted reports.
let navBound = false;

function bindNav(): void {
  if (navBound) return;
  navBound = true;
  document.querySelectorAll<HTMLElement>('.nv[data-view]').forEach((nv) => {
    nv.addEventListener('click', () => {
      const view = nv.dataset.view as View;
      showView(view);
      // Re-fetch on demand so the tests view always reflects current data,
      // not the rows captured when the listener was bound.
      if (view === 'tests') void listSummaries().then((rows) => renderTests(rows));
    });
  });
  $('nav-settings').addEventListener('click', () => void chrome.runtime.openOptionsPage());
}

async function init(): Promise<void> {
  bindNav();
  await refresh();
}

void init();

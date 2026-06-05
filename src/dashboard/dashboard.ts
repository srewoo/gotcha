import type { RuntimeResponse, BundleSummary } from '@shared/messaging';
import type { CaptureBundle } from '@shared/types';

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

function renderReports(rows: BundleSummary[]): void {
  const body = $('reports-body');
  $('reports-empty').hidden = rows.length > 0;
  body.innerHTML = rows
    .map((r) => {
      const ev = `${r.counts.console}🖥 · ${r.counts.failed}⚠ · ${r.counts.steps}🔁`;
      const test = r.hasTest ? '<span class="tag ok">✓ generated</span>' : '<span class="tag plain">–</span>';
      const filed = r.filed
        ? `<span class="tag ok">${esc(r.filed.identifier)}</span>`
        : '<span class="tag plain">open</span>';
      return `<tr data-id="${r.id}">
        <td class="mono">${gotId(r.id)}</td>
        <td>${esc(r.title)}</td>
        <td>${new Date(r.createdAt).toLocaleDateString()}</td>
        <td class="mono">${ev}</td>
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
  await init();
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

async function init(): Promise<void> {
  const rows = await listSummaries();
  renderKpis(rows);
  renderReports(rows);
  renderInsights(rows);

  document.querySelectorAll<HTMLElement>('.nv[data-view]').forEach((nv) => {
    nv.addEventListener('click', () => {
      const view = nv.dataset.view as View;
      showView(view);
      if (view === 'tests') void renderTests(rows);
    });
  });
  $('nav-settings').addEventListener('click', () => void chrome.runtime.openOptionsPage());
}

void init();

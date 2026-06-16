import type { RuntimeResponse, IntegrationId, FiledResult } from '@shared/messaging';
import type { CaptureBundle } from '@shared/types';
import { generatePlaywrightTest, type GeneratedTest } from '../testgen/playwright';
import { Annotator, type Tool } from './annotate';
import { mountReplay } from './replay';
import { mountScreencast } from './screencast';
import { exportBundleHtml } from '../share/export-html';
import { buildHar } from '../share/har';

let annotator: Annotator | null = null;
let aiAvailable = false;
let dupChecked = false;

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
};

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

// Cap long single-line strings (console messages, relative URLs that keep their
// query string) so they can't overflow the panel and force horizontal scroll.
// The full value stays available via the title tooltip.
const clip = (s: string, max = 180): string => (s.length > max ? `${s.slice(0, max)}…` : s);

function statusClass(status: number): string {
  if (status >= 500 || status === 0) return 's5';
  if (status >= 400) return 's4';
  return 's2';
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

// Generate + attach the Playwright test from the review screen.
async function generateTest(id: string, b: CaptureBundle): Promise<void> {
  const btn = $<HTMLButtonElement>('gen-test');
  btn.disabled = true;
  // Reflect the edited title before slugging the test name.
  b.title = $<HTMLInputElement>('title').value || b.title;
  // Persist edits (title/steps) so the worker reads the current bundle when the
  // LLM authors the spec. Title rides along — without it the worker re-reads
  // the stored bundle and names the spec after the stale auto-title.
  await chrome.runtime.sendMessage({ type: 'bundle:setSteps', id, steps: b.steps, title: b.title });

  let test: GeneratedTest | null = null;

  // LLM-first: the worker authors the whole spec (redacting before it reaches
  // the model). The worker itself falls back to the deterministic generator on
  // any LLM/parse error, so a configured key always yields a test.
  if (aiAvailable) {
    btn.textContent = 'Generating with AI…';
    const res = (await chrome.runtime.sendMessage({ type: 'ai:generateTest', id })) as
      | RuntimeResponse
      | undefined;
    if (res && res.ok && 'test' in res) test = res.test;
  }

  // No key (or messaging failed) → deterministic generator, client-side, folding
  // in any prior AI analysis hints.
  if (!test) {
    btn.textContent = 'Generating…';
    test = generatePlaywrightTest(b, b.aiAnalysis?.testHints);
  }

  b.generatedTest = test;
  await chrome.runtime.sendMessage({
    type: 'bundle:attachTest',
    id,
    filename: test.filename,
    source: test.source,
  });
  $('rv-test-name').textContent = test.filename;
  $('rv-test-code').textContent = test.source;
  $('rv-testgen-result').hidden = false;
  btn.disabled = false;
  btn.textContent = 'Regenerate';
  $('rv-download-test').onclick = (): void => download(test.filename, test.source, 'text/typescript');
  $('rv-copy-test').onclick = (): void => {
    void navigator.clipboard.writeText(test.source).then(() => {
      $('rv-copy-test').textContent = 'Copied ✓';
    });
  };
}

function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Editable / deletable repro steps (feature F3). Mutates bundle.steps in place
// (so test-gen + filing use the edits) and persists to the stored bundle.
// Also owns title persistence: the worker's fileBundle / generateAiTest re-read
// the STORED bundle, so an edited title must reach storage, not just the DOM.
function setupSteps(id: string, b: CaptureBundle): void {
  const root = $('steps');
  const persist = (): void => {
    void chrome.runtime.sendMessage({ type: 'bundle:setSteps', id, steps: b.steps, title: b.title });
  };
  // The title input had no edit handler at all — edits only lived in the DOM
  // until some other action happened to read .value. Persist on change/blur.
  const titleInput = $<HTMLInputElement>('title');
  titleInput.addEventListener('change', () => {
    b.title = titleInput.value || b.title;
    persist();
  });
  const render = (): void => {
    $('steps-count').textContent = `${b.steps.length} recorded`;
    if (b.steps.length === 0) {
      root.innerHTML = '<li class="empty-note">No steps recorded</li>';
      return;
    }
    root.innerHTML = b.steps
      .map((s, i) => {
        const sel = s.selector ? `<b class="mono">${esc(s.selector)}</b>` : '';
        return `<li><span class="step-kind">${esc(s.kind)}</span>
          <input class="step-label" data-i="${i}" value="${esc(s.label)}" />${sel}
          <button class="step-del" data-i="${i}" title="Delete step">✕</button></li>`;
      })
      .join('');
    root.querySelectorAll<HTMLInputElement>('.step-label').forEach((inp) => {
      inp.addEventListener('change', () => {
        const i = Number(inp.dataset.i);
        if (b.steps[i]) {
          b.steps[i].label = inp.value;
          persist();
        }
      });
    });
    root.querySelectorAll<HTMLButtonElement>('.step-del').forEach((btn) => {
      btn.addEventListener('click', () => {
        b.steps.splice(Number(btn.dataset.i), 1);
        persist();
        render();
      });
    });
  };
  render();
}

function renderBundle(b: CaptureBundle): void {
  $<HTMLInputElement>('title').value = b.title;

  // Steps
  $('steps-count').textContent = `${b.steps.length} recorded`;
  $('steps').innerHTML = b.steps.length
    ? b.steps
        .map((s) => {
          const sel = s.selector ? ` <b class="mono">${esc(s.selector)}</b>` : '';
          const val = s.value ? ` → "${esc(s.value)}"` : '';
          return `<li><span>${esc(s.kind)} ${esc(s.label)}${sel}${val}</span></li>`;
        })
        .join('')
    : '<li class="empty-note">No steps recorded</li>';

  // Console
  const errors = b.console.filter((c) => c.level === 'error');
  const warns = b.console.filter((c) => c.level === 'warn');
  $('console-count').textContent = `${b.console.length} logs · ${errors.length} errors`;
  const shown = [...errors.slice(0, 6), ...warns.slice(0, 3)];
  $('console').innerHTML = shown.length
    ? shown
        .map((c) => `<div class="${c.level === 'error' ? 'e' : 'w'}" title="${esc(c.message)}">${c.level === 'error' ? '✕' : '⚠'} ${esc(clip(c.message))}</div>`)
        .join('')
    : '<div class="empty-note">No console output captured</div>';

  // Network
  const failed = b.network.filter((n) => n.failed);
  $('network-count').textContent = `${failed.length} failed`;
  const rows = [...failed, ...b.network.filter((n) => !n.failed).slice(0, 4)];
  $('network').innerHTML = rows.length
    ? rows
        .map(
          (n) =>
            `<div class="row"><span class="c ${statusClass(n.status)}">${n.status || 'ERR'}</span><span class="m">${esc(n.method)}</span><span class="u" title="${esc(n.url)}">${esc(clip(pathOf(n.url)))}</span></div>`,
        )
        .join('')
    : '<div class="empty-note">No network requests captured</div>';

  // Environment
  const e = b.environment;
  $('env').innerHTML = `${esc(e.browser)} · ${esc(e.os)}<br>Viewport ${e.viewport.width}×${e.viewport.height} · DPR ${e.dpr}<br>${esc(e.locale)} · ${esc(pathOf(e.url))}`;
}

async function load(): Promise<void> {
  const id = new URLSearchParams(location.search).get('id');
  if (!id) return showError('No capture id in URL');

  const res = (await chrome.runtime.sendMessage({ type: 'bundle:get', id })) as
    | RuntimeResponse
    | undefined;
  if (!res || !res.ok || !('bundle' in res)) {
    return showError(res && !res.ok ? res.error : 'Capture not found');
  }

  const bundle = res.bundle;
  renderBundle(bundle);
  $('loading').hidden = true;
  $('review').hidden = false;
  initScreenshot(bundle);
  initScreencast(bundle);
  initReplay(bundle);
  setupSteps(id, bundle);

  // Export a self-contained HTML report (gap #5 — local share substitute for a
  // hosted no-install link). Shares the redaction toggle so secrets are masked
  // when the toggle is on, matching the file path.
  $('export-share').addEventListener('click', () => {
    const redact = $<HTMLInputElement>('redact').checked;
    const titled = { ...bundle, title: $<HTMLInputElement>('title').value || bundle.title };
    const out = exportBundleHtml(titled, { redact });
    download(out.filename, out.html, 'text/html');
  });

  // Export the network log as HAR for DevTools/Charles/Proxyman (feature F4).
  $('export-har').addEventListener('click', () => {
    const redact = $<HTMLInputElement>('redact').checked;
    const out = buildHar(bundle, { redact });
    download(out.filename, out.json, 'application/json');
  });

  // Generate the Playwright test right here (not only on the file step). Uses
  // the (possibly edited) steps + any AI test hints; attaches it to the bundle.
  $('gen-test').addEventListener('click', () => void generateTest(id, bundle));

  $<HTMLInputElement>('redact').addEventListener('change', (ev) => {
    $('redact-state').textContent = (ev.target as HTMLInputElement).checked ? 'on' : 'off';
  });

  renderIntegrations();
  $('file').addEventListener('click', () => {
    show('file-step');
    void runDupCheck(id); // #3 — surface likely duplicates before filing
  });
  $('file-back').addEventListener('click', () => show('review'));
  $('file-confirm').addEventListener('click', () => void file(id, bundle));

  void initAi(id, bundle);
}

// AI triage card (bring-your-own-key). Only shown when a key is configured.
// Renders a cached analysis if one exists; otherwise offers to run it.
async function initAi(id: string, bundle: CaptureBundle): Promise<void> {
  const avail = (await chrome.runtime.sendMessage({ type: 'ai:available' })) as
    | RuntimeResponse
    | undefined;
  aiAvailable = !!(avail && avail.ok && 'available' in avail && avail.available);
  if (!aiAvailable) return; // no key — leave the card + dup-check off

  $('ai-card').hidden = false;
  if (bundle.aiAnalysis) renderAi(bundle.aiAnalysis, bundle);
  $('ai-run').addEventListener('click', () => void runAiStream(id, bundle));
}

// #5 — stream the analysis over a Port so the summary fills in live, then render
// the full structured result (causes / steps / severity / title / test hints).
function runAiStream(id: string, bundle: CaptureBundle): void {
  const btn = $<HTMLButtonElement>('ai-run');
  btn.disabled = true;
  btn.textContent = 'Analysing…';
  $('ai-result').hidden = false;
  $('ai-summary').textContent = '';

  let raw = '';
  const port = chrome.runtime.connect({ name: `ai:analyze:${id}` });
  port.onMessage.addListener((msg: { type: string; delta?: string; analysis?: unknown; error?: string }) => {
    if (msg.type === 'delta' && msg.delta) {
      raw += msg.delta;
      // Live-extract the in-progress summary value from the streaming JSON.
      $('ai-summary').textContent = partialSummary(raw) || 'Analysing…';
    } else if (msg.type === 'done' && msg.analysis) {
      const analysis = msg.analysis as NonNullable<CaptureBundle['aiAnalysis']>;
      bundle.aiAnalysis = analysis;
      renderAi(analysis, bundle);
      btn.disabled = false;
      btn.textContent = 'Re-analyse';
    } else if (msg.type === 'error') {
      $('ai-hint').textContent = msg.error ?? 'Analysis failed.';
      btn.disabled = false;
      btn.textContent = 'Try again';
    }
  });
  port.onDisconnect.addListener(() => {
    if (btn.disabled) {
      btn.disabled = false;
      btn.textContent = 'Re-analyse';
    }
  });
}

// Pull the (possibly incomplete) "summary" string out of a streaming JSON blob.
function partialSummary(raw: string): string {
  const m = raw.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (!m) return '';
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return m[1].replace(/\\n/g, ' ');
  }
}

const SEV_PRIORITY: Record<string, string> = { P0: 'Urgent', P1: 'High', P2: 'Medium', P3: 'Low' };

function renderAi(a: NonNullable<CaptureBundle['aiAnalysis']>, bundle: CaptureBundle): void {
  $('ai-summary').textContent = a.summary;
  $('ai-causes').innerHTML = a.rootCauses.map((c) => `<li>${esc(c)}</li>`).join('');
  $('ai-steps').innerHTML = a.debuggingSteps.map((s) => `<li>${esc(s)}</li>`).join('');
  $('ai-meta').textContent = `${a.provider} · ${a.model} · redacted before sending`;

  // #4 — severity badge + pre-fill the file-step priority.
  const sev = $('ai-severity');
  if (a.severity) {
    sev.hidden = false;
    sev.className = `ai-sev sev-${a.severity.level}`;
    sev.textContent = `${a.severity.level} · ${a.severity.reason}`;
    const prio = document.getElementById('f-priority') as HTMLInputElement | null;
    if (prio) prio.value = SEV_PRIORITY[a.severity.level] ?? prio.value;
  } else {
    sev.hidden = true;
  }

  // #1 — suggested title with one-click apply.
  const row = $('ai-title-row');
  if (a.suggestedTitle) {
    row.hidden = false;
    $('ai-title-text').textContent = a.suggestedTitle;
    $('ai-use-title').onclick = () => {
      $<HTMLInputElement>('title').value = a.suggestedTitle ?? '';
      bundle.title = a.suggestedTitle ?? bundle.title;
    };
  } else {
    row.hidden = true;
  }

  $('ai-result').hidden = false;
  $<HTMLButtonElement>('ai-run').textContent = 'Re-analyse';
}

// #3 — ask the model which recent reports look like the same bug.
async function runDupCheck(id: string): Promise<void> {
  if (!aiAvailable || dupChecked) return;
  dupChecked = true;
  const box = $('dup-warn');
  const res = (await chrome.runtime.sendMessage({ type: 'ai:duplicates', id })) as
    | RuntimeResponse
    | undefined;
  if (!res || !res.ok || !('duplicates' in res) || res.duplicates.length === 0) return;
  box.hidden = false;
  box.innerHTML =
    '<b>⚠ Possible duplicates</b><ul>' +
    res.duplicates
      .map(
        (d) =>
          `<li><a href="${esc(chrome.runtime.getURL(`src/review/review.html?id=${d.id}`))}" target="_blank">${esc(d.title)}</a> — ${esc(d.reason)}</li>`,
      )
      .join('') +
    '</ul>';
}

const INTEGRATIONS: ReadonlyArray<{ id: IntegrationId; ic: string; name: string; phase: string }> = [
  { id: 'linear', ic: '▲', name: 'Linear', phase: 'MVP' },
  { id: 'jira', ic: '🔷', name: 'Jira', phase: 'v2' },
  { id: 'github', ic: '🐙', name: 'GitHub', phase: 'v2' },
  { id: 'slack', ic: '💬', name: 'Slack', phase: 'v2' },
];
let chosen: IntegrationId = 'linear';

function renderIntegrations(): void {
  const root = $('integ');
  root.innerHTML = INTEGRATIONS.map(
    (it) =>
      `<div class="opt ${it.id === chosen ? 'sel' : ''}" data-id="${it.id}">
        <div class="ic">${it.ic}</div><b>${it.name}</b><span class="tag plain">${it.phase}</span>
      </div>`,
  ).join('');
  root.querySelectorAll<HTMLElement>('.opt').forEach((el) => {
    el.addEventListener('click', () => {
      chosen = el.dataset.id as IntegrationId;
      renderIntegrations();
    });
  });
}

// Mount the canvas annotator over the screenshot, or show a placeholder.
function initScreenshot(b: CaptureBundle): void {
  const shot = $('shot');
  if (!b.screenshotDataUrl) {
    shot.innerHTML = '<span class="ph">No screenshot</span>';
    return;
  }
  const canvas = document.createElement('canvas');
  canvas.className = 'anno-canvas';
  shot.innerHTML = '';
  shot.appendChild(canvas);
  const maxWidth = Math.max(280, shot.clientWidth || 380);
  annotator = new Annotator(canvas, b.screenshotDataUrl, maxWidth);

  const commentList = $('shot-comments');
  const refreshComments = (): void => {
    const comments = annotator?.comments() ?? [];
    if (comments.length === 0) {
      commentList.hidden = true;
      commentList.innerHTML = '';
      return;
    }
    commentList.hidden = false;
    commentList.innerHTML = comments.map((c) => `<li>${esc(c)}</li>`).join('');
  };

  const tools = $('shot-tools');
  tools.hidden = false;
  tools.querySelectorAll<HTMLButtonElement>('.anno-tool[data-tool]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tool = btn.dataset.tool;
      if (tool === 'undo') {
        annotator?.undo();
        refreshComments();
        return;
      }
      tools
        .querySelectorAll('.anno-tool[data-tool]')
        .forEach((b2) => b2.classList.remove('active'));
      btn.classList.add('active');
      annotator?.setTool(tool as Tool);
    });
  });
  // Keep the comment list in sync after a pin's editor commits (pointerup on the
  // canvas fires before the input blur, so refresh on focus leaving the canvas).
  canvas.addEventListener('pointerup', () => setTimeout(refreshComments, 0));
  shot.addEventListener('focusout', () => setTimeout(refreshComments, 0));

  // Full-screen / minimize controls (the screenshot can be large; let reviewers
  // blow it up to inspect a defect, or collapse it to scan the rest of the card).
  const setMax = (on: boolean): void => {
    shot.classList.toggle('shot--max', on);
    shot.classList.remove('shot--min');
    document.body.classList.toggle('shot-maxed', on);
    const maxBtn = $<HTMLButtonElement>('shot-max');
    maxBtn.textContent = on ? '🗗' : '⛶';
    maxBtn.title = on ? 'Exit full screen' : 'View full screen';
  };
  $('shot-max').addEventListener('click', () => setMax(!shot.classList.contains('shot--max')));
  $('shot-min').addEventListener('click', () => {
    if (shot.classList.contains('shot--max')) setMax(false);
    shot.classList.toggle('shot--min');
    $<HTMLButtonElement>('shot-min').title = shot.classList.contains('shot--min')
      ? 'Restore'
      : 'Minimize';
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && shot.classList.contains('shot--max')) setMax(false);
  });
}

// Mount the session-replay player (gap #1) when replay events were captured.
function initReplay(b: CaptureBundle): void {
  const sect = $('replay-sect');
  const host = $('replay');
  const count = b.replay?.length ?? 0;
  if (count === 0) {
    sect.hidden = true;
    return;
  }
  sect.hidden = false;
  $('replay-count').textContent = `${count} events`;
  mountReplay(host, b);
}

// Mount the true-pixel screencast player when deep-capture recorded frames.
function initScreencast(b: CaptureBundle): void {
  const sect = $('screencast-sect');
  const frames = b.screencast?.length ?? 0;
  if (frames === 0) {
    sect.hidden = true;
    return;
  }
  sect.hidden = false;
  $('screencast-count').textContent = `${frames} frames`;
  mountScreencast($('screencast'), b);
}

function show(stepId: 'review' | 'file-step' | 'success'): void {
  for (const s of ['review', 'file-step', 'success']) $(s).hidden = s !== stepId;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function file(id: string, bundle: CaptureBundle): Promise<void> {
  const btn = $<HTMLButtonElement>('file-confirm');
  btn.disabled = true;
  btn.textContent = 'Filing…';
  const redact = $<HTMLInputElement>('redact').checked;
  const withTest = $<HTMLInputElement>('f-gentest').checked;

  // Apply edited title, persist any annotations, generate + attach the test
  // first so it lands in the filed issue body, then file to the integration.
  bundle.title = $<HTMLInputElement>('title').value || bundle.title;
  if (annotator?.dirty) {
    const dataUrl = annotator.export();
    bundle.screenshotDataUrl = dataUrl;
    await chrome.runtime.sendMessage({ type: 'bundle:setScreenshot', id, dataUrl });
  }
  if (withTest) {
    // Reuse a test the user already generated (which may be the richer
    // LLM-authored spec); otherwise produce the deterministic baseline now,
    // folding in any AI analysis hints (#2).
    const test =
      bundle.generatedTest ?? generatePlaywrightTest(bundle, bundle.aiAnalysis?.testHints);
    bundle.generatedTest = test;
    await chrome.runtime.sendMessage({
      type: 'bundle:attachTest',
      id,
      filename: test.filename,
      source: test.source,
    });
  }

  // Team / Assignee / Priority were dead UI: read, trimmed, and forwarded so
  // the worker can plumb them into the integration payload. Empty inputs are
  // omitted (and `fields` entirely when all are empty) so integrations can
  // distinguish "not provided" from "".
  const fieldValue = (fid: string): string | undefined => {
    const v = (document.getElementById(fid) as HTMLInputElement | null)?.value.trim();
    return v ? v : undefined;
  };
  const team = fieldValue('f-team');
  const assignee = fieldValue('f-assignee');
  const priority = fieldValue('f-priority');
  const fields =
    team || assignee || priority
      ? {
          ...(team ? { team } : {}),
          ...(assignee ? { assignee } : {}),
          ...(priority ? { priority } : {}),
        }
      : undefined;

  const res = (await chrome.runtime.sendMessage({
    type: 'bundle:file',
    id,
    redact,
    integration: chosen,
    ...(fields ? { fields } : {}),
  })) as RuntimeResponse | undefined;

  if (!res || !res.ok || !('filed' in res)) {
    btn.disabled = false;
    btn.textContent = 'Create issue';
    return showError(res && !res.ok ? res.error : 'Filing failed');
  }
  showSuccess(bundle, res.filed);
}

function showSuccess(b: CaptureBundle, filed: FiledResult): void {
  $('ticket-title').textContent = $<HTMLInputElement>('title').value || b.title;
  $('ticket-id').textContent = filed.identifier;
  const open = $<HTMLAnchorElement>('ticket-open');
  const label = INTEGRATIONS.find((i) => i.id === filed.integration)?.name ?? 'tracker';
  if (filed.url && filed.url !== '#') {
    open.href = filed.url;
    open.textContent = `Open in ${label} ↗`;
  } else {
    open.textContent = `Filed in ${label} (demo)`;
  }

  $('evid').innerHTML = [
    b.screenshotDataUrl ? '📸 screenshot' : null,
    `🖥️ console ×${b.console.length}`,
    `🌐 network ×${b.network.length}`,
    `🔁 ${b.steps.length} steps`,
    '🧾 env',
  ]
    .filter(Boolean)
    .map((t) => `<span class="tag plain">${t}</span>`)
    .join('');

  renderGeneratedTest(b);
  show('success');
}

// The moat: show the generated Playwright spec and offer download / copy.
function renderGeneratedTest(b: CaptureBundle): void {
  const block = $('testgen-result');
  if (!b.generatedTest) {
    block.hidden = true;
    return;
  }
  block.hidden = false;
  const test = b.generatedTest;
  $('test-name').textContent = test.filename;
  $('test-code').textContent = test.source;

  $('download-test').addEventListener('click', () => {
    const blob = new Blob([test.source], { type: 'text/typescript' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = test.filename;
    a.click();
    URL.revokeObjectURL(url);
  });

  $('copy-test').addEventListener('click', () => {
    void navigator.clipboard.writeText(test.source).then(() => {
      $('copy-test').textContent = 'Copied ✓';
    });
  });
}

function showError(msg: string): void {
  $('loading').hidden = true;
  const box = $('error');
  box.textContent = msg;
  box.hidden = false;
}

void load();

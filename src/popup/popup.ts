import type { RuntimeMessage, RuntimeResponse, CaptureStatus } from '@shared/messaging';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
};

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function activeTabId(): Promise<number | undefined> {
  return (await activeTab())?.id;
}

// chrome.debugger (and thus deep capture) can only attach to ordinary web
// pages. chrome://, chrome-extension://, the Web Store, and view-source pages
// reject attach with "Cannot access …" — so we gate the toggle on the URL
// rather than letting the attach fail and silently flip the checkbox back.
function isDebuggable(url: string | undefined): boolean {
  if (!url) return false;
  return /^(https?|file):/i.test(url);
}

// Talk to the content script in the active tab.
async function toTab(message: RuntimeMessage): Promise<RuntimeResponse | undefined> {
  const id = await activeTabId();
  if (id === undefined) return undefined;
  try {
    return (await chrome.tabs.sendMessage(id, message)) as RuntimeResponse;
  } catch {
    // No content script on this tab (e.g. chrome:// pages).
    return undefined;
  }
}

// Talk to the service worker.
async function toWorker(message: RuntimeMessage): Promise<RuntimeResponse | undefined> {
  try {
    return (await chrome.runtime.sendMessage(message)) as RuntimeResponse;
  } catch {
    return undefined;
  }
}

function renderStatus(status: CaptureStatus | null): void {
  $('c-console').textContent = status ? String(status.counts.console) : '–';
  $('c-failed').textContent = status ? String(status.counts.failed) : '–';
  const sub = $('sub');
  if (!status) {
    sub.textContent = 'Open a regular web page to capture';
  } else {
    sub.textContent = `${status.counts.errors} errors · ${status.counts.failed} failed reqs buffered`;
  }
}

const dotColor = (i: number): string =>
  ['var(--ok)', 'var(--warn)', 'var(--muted)'][i] ?? 'var(--muted)';

async function renderRecent(): Promise<void> {
  const res = await toWorker({ type: 'bundle:list' });
  const list = $('recent-list');
  const empty = $('recent-empty');
  list.innerHTML = '';
  if (!res || !res.ok || !('bundles' in res) || res.bundles.length === 0) {
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  res.bundles.slice(0, 3).forEach((b, i) => {
    const row = document.createElement('div');
    row.className = 'rep';
    row.innerHTML = `<span class="dot" style="background:${dotColor(i)}"></span>
      <span class="t">${escapeHtml(b.title)}</span>
      <span class="meta mono">${new Date(b.createdAt).toLocaleDateString()}</span>
      <button class="rep-del" title="Delete report" aria-label="Delete report">🗑</button>`;
    row.addEventListener('click', () => {
      void chrome.tabs.create({
        url: chrome.runtime.getURL(`src/review/review.html?id=${b.id}`),
      });
    });
    row.querySelector('.rep-del')!.addEventListener('click', (e) => {
      e.stopPropagation();
      void toWorker({ type: 'bundle:delete', id: b.id }).then(() => renderRecent());
    });
    list.appendChild(row);
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function setDeepAvailability(debuggable: boolean): void {
  const box = $<HTMLInputElement>('deep');
  const row = box.closest('.deep-row') as HTMLElement | null;
  box.disabled = !debuggable;
  if (row) {
    row.classList.toggle('disabled', !debuggable);
    row.title = debuggable
      ? ''
      : 'Deep capture needs a regular web page (not a chrome:// or extension page).';
  }
}

async function refresh(): Promise<void> {
  const tab = await activeTab();
  const res = await toTab({ type: 'capture:status' });
  renderStatus(res && res.ok && 'status' in res ? res.status : null);

  const debuggable = isDebuggable(tab?.url);
  setDeepAvailability(debuggable);
  const deep = await toWorker({ type: 'deep:status' });
  if (deep && deep.ok && 'deep' in deep) ($('deep') as HTMLInputElement).checked = deep.deep;
  await renderRecent();
}

$('capture').addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('capture');
  btn.disabled = true;
  btn.textContent = '● Capturing…';
  const res = await toTab({ type: 'capture:finish' });
  if (res && res.ok && 'reviewUrl' in res) {
    window.close(); // review tab opened by the worker
  } else {
    btn.disabled = false;
    btn.textContent = '● Capture this bug';
    $('sub').textContent = res && !res.ok ? res.error : 'Cannot capture this page';
  }
});

// Map a raw chrome.debugger.attach failure to an actionable message. We only
// claim "needs a regular web page" when the tab URL genuinely isn't debuggable
// (checked here, not guessed from the error string) — otherwise we surface the
// real reason (e.g. DevTools already attached) so it's diagnosable.
function deepErrorMessage(raw: string, url: string | undefined): string {
  if (!isDebuggable(url)) {
    return 'Deep capture needs a regular web page (not a chrome:// or extension page).';
  }
  if (/already attached|another debugger|attach to the/i.test(raw)) {
    return 'A debugger is already attached to this tab — close DevTools (or another debugging extension) on this page, then retry.';
  }
  if (/different extension|chrome-extension:\/\//i.test(raw)) {
    return 'Another extension has injected content into this page, so Chrome won’t let Gotcha attach its debugger here. Disable conflicting extensions (or use a clean/incognito profile with only Gotcha). Normal capture still works without deep mode.';
  }
  if (/cannot attach|cannot access|not allowed/i.test(raw)) {
    return `Chrome blocked deep capture on this tab: ${raw}`;
  }
  return raw;
}

$('deep').addEventListener('change', async (ev) => {
  const box = ev.target as HTMLInputElement;
  const on = box.checked;
  const tab = await activeTab();
  // Pass the resolved tab id so the worker attaches to exactly this tab (no
  // active-tab ambiguity), and pre-gate on the URL before attempting attach.
  if (on && !isDebuggable(tab?.url)) {
    box.checked = false;
    $('sub').textContent = 'Deep capture needs a regular web page (not a chrome:// or extension page).';
    return;
  }
  const res = await toWorker(
    on ? { type: 'deep:enable', tabId: tab?.id } : { type: 'deep:disable', tabId: tab?.id },
  );
  if (!res || !res.ok) {
    box.checked = !on;
    const raw = res && !res.ok ? res.error : 'Deep capture unavailable here';
    $('sub').textContent = deepErrorMessage(raw, tab?.url);
  } else {
    $('sub').textContent = on
      ? 'Deep capture on — Chrome shows a debug banner while attached.'
      : 'Console & network capture running quietly';
  }
});

$('record').addEventListener('click', async () => {
  const res = await toTab({ type: 'capture:start' });
  if (res && res.ok) {
    window.close(); // widget is now visible in the page; user reproduces, then Finish
  } else {
    $('sub').textContent = res && !res.ok ? res.error : 'Cannot record this page';
  }
});

$('open-dash').addEventListener('click', (e) => {
  e.preventDefault();
  void chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/dashboard.html') });
});

void refresh();

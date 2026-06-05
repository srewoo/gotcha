// Settings page — credentials live in chrome.storage.local under the exact keys
// each integration reads. Token fields are password inputs; nothing is logged.
const KEYS = [
  'linearApiKey',
  'linearTeamId',
  'jiraHost',
  'jiraEmail',
  'jiraToken',
  'jiraProjectKey',
  'githubToken',
  'githubRepo',
  'slackWebhookUrl',
  'aiProvider',
  'aiApiKey',
  'aiModel',
  'redactExtraPatterns',
  'captureDenyDomains',
] as const;

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
};

async function load(): Promise<void> {
  const stored = await chrome.storage.local.get([...KEYS]);
  for (const key of KEYS) {
    const input = document.getElementById(key) as HTMLInputElement | null;
    if (input && typeof stored[key] === 'string') input.value = stored[key] as string;
  }
}

async function save(): Promise<void> {
  const patch: Record<string, string> = {};
  for (const key of KEYS) {
    const input = document.getElementById(key) as HTMLInputElement | null;
    patch[key] = input?.value.trim() ?? '';
  }
  await chrome.storage.local.set(patch);
  const saved = $('saved');
  saved.hidden = false;
  setTimeout(() => (saved.hidden = true), 1800);
}

$('save').addEventListener('click', () => void save());

$('ai-test').addEventListener('click', () => void testConnection());

// Per-integration "Test connection" buttons (Linear / Jira / GitHub / Slack).
document.querySelectorAll<HTMLButtonElement>('.itest').forEach((btn) => {
  btn.addEventListener('click', () => void testIntegration(btn));
});

async function testIntegration(btn: HTMLButtonElement): Promise<void> {
  const id = btn.dataset.integ;
  if (!id) return;
  await save(); // persist latest credentials so the worker reads them
  const out = document.querySelector<HTMLElement>(`[data-result="${id}"]`);
  if (out) {
    out.hidden = false;
    out.textContent = 'Testing…';
  }
  const res = (await chrome.runtime.sendMessage({ type: 'integration:test', id })) as
    | { ok: true }
    | { ok: false; error: string }
    | undefined;
  if (out) out.textContent = res?.ok ? 'Connected ✓' : `Failed: ${res && !res.ok ? res.error : 'no response'}`;
}

async function testConnection(): Promise<void> {
  await save(); // persist current fields so the worker reads the latest key
  const out = $('ai-test-result');
  out.hidden = false;
  out.textContent = 'Testing…';
  const res = (await chrome.runtime.sendMessage({ type: 'ai:test' })) as
    | { ok: true }
    | { ok: false; error: string }
    | undefined;
  out.textContent = res?.ok ? 'Connection OK ✓' : `Failed: ${res && !res.ok ? res.error : 'no response'}`;
}
$('open-dash').addEventListener('click', (e) => {
  e.preventDefault();
  void chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/dashboard.html') });
});

void load();

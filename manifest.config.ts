import { defineManifest } from '@crxjs/vite-plugin';

// MV3 manifest. Two content scripts run at document_start:
//   - injected (MAIN world): hooks console/fetch/XHR/errors + repro events
//   - content  (ISOLATED world): owns buffers + IndexedDB, talks to the worker
// The service worker holds NO capture state — it dies after ~30s idle.
export default defineManifest({
  manifest_version: 3,
  name: 'Gotcha',
  version: '1.2',
  description: 'One-click bug report that ships with a runnable regression test.',
  action: {
    default_popup: 'src/popup/popup.html',
    default_title: 'Gotcha — catch a bug',
    default_icon: {
      '16': 'icons/icon-16.png',
      '32': 'icons/icon-32.png',
    },
  },
  icons: {
    '16': 'icons/icon-16.png',
    '32': 'icons/icon-32.png',
    '48': 'icons/icon-48.png',
    '128': 'icons/icon-128.png',
  },
  options_ui: {
    page: 'src/options/options.html',
    open_in_tab: true,
  },
  commands: {
    'capture-bug': {
      suggested_key: { default: 'Ctrl+Shift+Y', mac: 'Command+Shift+Y' },
      description: 'Capture a bug with Gotcha',
    },
  },
  background: {
    service_worker: 'src/background/service-worker.ts',
    type: 'module',
  },
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['src/injected/main.ts'],
      run_at: 'document_start',
      world: 'MAIN',
      // Capture iframes too (embedded apps, OAuth flows). Sub-frame events are
      // forwarded to the top frame's content script, which owns the buffers.
      all_frames: true,
    },
    {
      matches: ['<all_urls>'],
      js: ['src/content/content.ts'],
      run_at: 'document_start',
      world: 'ISOLATED',
      all_frames: true,
    },
  ],
  // No 'activeTab': host_permissions '<all_urls>' (below) already grants the
  // scripting-target + captureVisibleTab access activeTab would, so it'd be a
  // redundant over-request. 'scripting' powers on-demand re-injection of the
  // content scripts into tabs that predate the extension load (see
  // ensureContentScript in popup.ts).
  // 'debugger' powers opt-in deep-capture mode (full response bodies +
  // pre-injection requests + CDP screencast). Chrome forbids 'debugger' in
  // optional_permissions ("cannot be listed as optional" — it gets silently
  // omitted), so it MUST be a required permission, granted at install. Deep
  // capture stays opt-in at runtime (off until the user toggles it on); the
  // grant just has to be present up front. The install prompt is already broad
  // because of <all_urls> + tabs, so the incremental ask is small.
  permissions: ['scripting', 'storage', 'tabs', 'debugger'],
  // <all_urls> already covers integration endpoints (Linear/Jira/GitHub/Slack
  // webhooks) for the worker's fetch calls.
  host_permissions: ['<all_urls>'],
  web_accessible_resources: [
    {
      resources: [
        'src/review/review.html',
        'src/dashboard/dashboard.html',
        'src/help/help.html',
        'src/privacy/privacypolicy.html',
      ],
      matches: ['<all_urls>'],
    },
  ],
});

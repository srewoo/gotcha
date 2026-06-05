import { installConsoleHook } from './console-hook';
import { installNetworkHook } from './network-hook';
import { installErrorHook } from './error-hook';
import { installReproRecorder } from './repro-recorder';
// Capture blind spots (gap #6): transports the fetch/XHR patch can't see.
import { installBeaconHook } from './beacon-hook';
import { installWebSocketHook } from './websocket-hook';
import { installEventSourceHook } from './eventsource-hook';
import { installWorkerHook } from './worker-hook';
// Session replay (gap #1): rrweb-style DOM event stream.
import { installDomRecorder } from './dom-recorder';

// MAIN-world entry, runs at document_start so we wrap globals BEFORE the page's
// own code touches them. Hooks are installed unconditionally and always emit;
// the ISOLATED content script decides what to buffer. This is deliberate: a
// bug reporter that only starts capturing AFTER you notice the bug is useless.
(() => {
  const w = window as Window & { __gotchaInstalled?: boolean };
  if (w.__gotchaInstalled) return;
  w.__gotchaInstalled = true;

  installConsoleHook();
  installNetworkHook();
  installErrorHook();
  installReproRecorder();
  installBeaconHook();
  installWebSocketHook();
  installEventSourceHook();
  installWorkerHook();
  installDomRecorder();
})();

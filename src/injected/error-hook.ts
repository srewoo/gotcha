import { BRIDGE_MARKER, post } from './bridge';
import { uid } from '@shared/uid';

// Uncaught errors and rejected promises never reach console.error reliably,
// so we capture them directly. These are the highest-signal console entries.
export function installErrorHook(): void {
  window.addEventListener('error', (event) => {
    post({
      marker: BRIDGE_MARKER,
      type: 'console',
      entry: {
        id: uid(),
        level: 'error',
        message: event.message || 'Uncaught error',
        stack: event.error instanceof Error ? event.error.stack : undefined,
        ts: Date.now(),
      },
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    post({
      marker: BRIDGE_MARKER,
      type: 'console',
      entry: {
        id: uid(),
        level: 'error',
        message:
          reason instanceof Error
            ? `Unhandled rejection: ${reason.message}`
            : `Unhandled rejection: ${String(reason)}`,
        stack: reason instanceof Error ? reason.stack : undefined,
        ts: Date.now(),
      },
    });
  });
}

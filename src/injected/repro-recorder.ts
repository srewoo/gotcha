import { BRIDGE_MARKER, post } from './bridge';
import { uid } from '@shared/uid';
import type { ReproStep, ReproStepKind } from '@shared/types';
import { rankedSelectors } from '../testgen/selector';

// WHY: bestSelector + rankedSelectors replace the old inline `selectorFor` so
// we capture all stable candidate selectors at record time, not just the first
// class-pair fallback. The testgen can then pick the best one (or let the
// developer swap in a fallback from the comment).

function labelFor(el: Element): string {
  const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
  const aria = el.getAttribute('aria-label');
  const placeholder = el.getAttribute('placeholder');
  return aria || text || placeholder || el.tagName.toLowerCase();
}

function emit(kind: ReproStepKind, label: string, extra?: Partial<ReproStep>): void {
  const step: ReproStep = { id: uid(), kind, label, ts: Date.now(), ...extra };
  post({ marker: BRIDGE_MARKER, type: 'step', step });
}

function isSensitive(el: Element): boolean {
  const type = el.getAttribute('type')?.toLowerCase();
  return type === 'password' || /pass|secret|card|cvv|ssn/i.test(el.getAttribute('name') ?? '');
}

/**
 * Populate both `selector` (best single pick) and `selectorCandidates` (full
 * ranked list, best-first) on the emitted step so the test-gen has options.
 *
 * WHY: recording all candidates once at capture time is cheaper than
 * re-computing them at test-gen time (the DOM is gone by then).
 */
function selectorsFor(el: Element): Pick<ReproStep, 'selector' | 'selectorCandidates'> {
  const candidates = rankedSelectors(el);
  return {
    selector: candidates[0],
    selectorCandidates: candidates,
  };
}

export function installReproRecorder(): void {
  // First step is always the entry navigation.
  emit('navigate', location.pathname + location.search);

  document.addEventListener(
    'click',
    (e) => {
      const el = e.target as Element | null;
      if (!el || !(el instanceof Element)) return;
      const target = el.closest('button, a, [role="button"], input[type="submit"]') ?? el;
      emit('click', labelFor(target), selectorsFor(target));
    },
    true,
  );

  document.addEventListener(
    'change',
    (e) => {
      const el = e.target as HTMLInputElement | null;
      if (!el || !(el instanceof HTMLElement)) return;
      const value = isSensitive(el) ? '«hidden»' : (el as HTMLInputElement).value?.slice(0, 80);
      emit('input', labelFor(el), { ...selectorsFor(el), value });
    },
    true,
  );

  document.addEventListener(
    'submit',
    (e) => {
      const el = e.target as Element | null;
      if (el) emit('submit', labelFor(el), selectorsFor(el));
    },
    true,
  );

  // SPA route changes via History API.
  const wrap = (fn: typeof history.pushState) =>
    function (this: History, ...args: Parameters<typeof history.pushState>) {
      const ret = fn.apply(this, args);
      emit('navigate', location.pathname + location.search);
      return ret;
    };
  history.pushState = wrap(history.pushState);
  history.replaceState = wrap(history.replaceState);
  window.addEventListener('popstate', () => emit('navigate', location.pathname + location.search));
}

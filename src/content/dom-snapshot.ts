// A lightweight outerHTML snapshot with obvious secrets stripped at capture
// time. This is NOT a faithful replay (that's v1.5 with resource inlining) —
// it's enough context for a dev to see structure and for selectors to resolve.
const MAX_SNAPSHOT = 500_000;

export function captureDomSnapshot(): string {
  const clone = document.documentElement.cloneNode(true) as HTMLElement;

  // Drop script/noscript — never needed, often huge.
  clone.querySelectorAll('script, noscript').forEach((n) => n.remove());

  // Mask values of sensitive inputs in the snapshot itself.
  clone.querySelectorAll('input, textarea').forEach((el) => {
    const type = el.getAttribute('type')?.toLowerCase();
    const name = el.getAttribute('name') ?? '';
    if (type === 'password' || /pass|secret|card|cvv|ssn/i.test(name)) {
      el.setAttribute('value', '«redacted»');
    }
  });

  const html = `<!DOCTYPE html>\n${clone.outerHTML}`;
  return html.length > MAX_SNAPSHOT ? html.slice(0, MAX_SNAPSHOT) : html;
}

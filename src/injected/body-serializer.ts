// Shared synchronous serialisation of request bodies — fetch RequestInit.body,
// XHR send() payloads, and sendBeacon data all accept the same BodyInit zoo.
// Before this existed, fetch fell through to String(body) ("[object FormData]")
// and XHR only captured plain strings, so structured payloads were lost.
//
// Everything here MUST stay synchronous: it runs inline on the page's hot
// network path, so binary payloads get a descriptive placeholder instead of an
// async read. Clipping is intentionally left to the callers — each hook has
// its own MAX_BODY budget.
export function serializeBody(body: unknown): string | undefined {
  if (body == null) return undefined;
  try {
    if (typeof body === 'string') return body;
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams)
      return body.toString();
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      const parts: string[] = [];
      body.forEach((value, key) => {
        parts.push(
          typeof value === 'string'
            ? `${key}=${value}`
            : `${key}=[File ${value.name}, ${value.size} bytes]`,
        );
      });
      return parts.join('\n');
    }
    // Blob can only be read asynchronously — a placeholder keeps this sync.
    if (typeof Blob !== 'undefined' && body instanceof Blob)
      return `[Blob ${body.type}, ${body.size} bytes]`;
    if (body instanceof ArrayBuffer) return `[binary ${body.byteLength} bytes]`;
    if (ArrayBuffer.isView(body)) return `[binary ${body.byteLength} bytes]`;
    // instanceof Document can fail across realms (iframe documents, test DOM
    // shims) — fall back to the DOCUMENT_NODE nodeType check.
    if (
      (typeof Document !== 'undefined' && body instanceof Document) ||
      (body as { nodeType?: unknown }).nodeType === 9
    )
      return '[Document]';
    return String(body);
  } catch {
    return undefined;
  }
}

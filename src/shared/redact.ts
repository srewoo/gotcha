import type { CaptureBundle, NetworkEntry } from './types';

const REDACTED = '«redacted»';

// Headers stripped wholesale — never useful in a bug report, always sensitive.
const SECRET_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'proxy-authorization',
]);

// Value-level patterns masked inside bodies and input values. Phone numbers
// and IP addresses are deliberately omitted (false-positive rate is too high —
// they collide with ids, versions, timestamps); users can opt in via the
// custom F7 patterns below.
const PATTERNS: ReadonlyArray<RegExp> = [
  /\b[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, // email
  /\b(?:\d[ -]*?){13,19}\b/g, // card-like number runs
  /\bBearer\s+[A-Za-z0-9._-]+/gi, // bearer tokens
  /\beyJ[A-Za-z0-9._-]{10,}/g, // JWT-ish
  /\b\d{3}-\d{2}-\d{4}\b/g, // US SSN
];

// Body field names whose values are masked regardless of pattern.
const SECRET_FIELDS = /(pass(word)?|secret|token|ssn|cardnumber|cvv|pin)/i;

// Query-string params whose values commonly carry secrets (magic links, signed
// URLs, OAuth callbacks). Masked in the URL itself.
const SECRET_QUERY =
  /^(?:token|access_token|refresh_token|id_token|api_?key|key|secret|password|pwd|sig|signature|auth|code|session|sid|state|nonce)$/i;

// User-defined extra patterns (feature F7), compiled from Settings. Applied on
// top of the built-ins by every maskString call (and thus redactBundle).
let extraPatterns: ReadonlyArray<RegExp> = [];

export function setExtraRedactionPatterns(sources: ReadonlyArray<string>): void {
  const compiled: RegExp[] = [];
  for (const src of sources) {
    const t = src.trim();
    if (!t) continue;
    try {
      compiled.push(new RegExp(t, 'gi'));
    } catch {
      // Skip invalid user regex rather than break redaction.
    }
  }
  extraPatterns = compiled;
}

export function maskString(input: string): string {
  let out = input;
  for (const re of PATTERNS) out = out.replace(re, REDACTED);
  for (const re of extraPatterns) out = out.replace(re, REDACTED);
  return out;
}

function redactHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
  if (!headers) return headers;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SECRET_HEADERS.has(k.toLowerCase()) ? REDACTED : v;
  }
  return out;
}

function redactBody(body?: string): string | undefined {
  if (!body) return body;
  // Mask secret-named JSON / form-encoded fields, then run value patterns over
  // the rest. Quoted JSON values are matched as a full string literal
  // (including spaces and escapes — a naive token match leaked
  // `"password":"hunter two"`); unquoted values stop at the usual delimiters,
  // which keeps `key=value&...` form encoding working.
  const masked = body.replace(
    /("?\b[\w-]+"?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|[^",&}\s]+)/g,
    (full, prefix: string, value: string) =>
      SECRET_FIELDS.test(prefix)
        ? `${prefix}${value.startsWith('"') ? `"${REDACTED}"` : REDACTED}`
        : full,
  );
  return maskString(masked);
}

// Mask secret-looking query-string values, then run value patterns over the
// whole URL (catches tokens embedded in the path too).
function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) {
      if (SECRET_QUERY.test(k)) u.searchParams.set(k, 'REDACTED');
    }
    return maskString(u.toString());
  } catch {
    return maskString(url);
  }
}

function redactNetwork(entry: NetworkEntry): NetworkEntry {
  return {
    ...entry,
    url: redactUrl(entry.url),
    requestHeaders: redactHeaders(entry.requestHeaders),
    responseHeaders: redactHeaders(entry.responseHeaders),
    requestBody: redactBody(entry.requestBody),
    responseBody: redactBody(entry.responseBody),
    // WebSocket / EventSource frame payloads carry the same risk as bodies.
    frames: entry.frames?.map((f) => ({ ...f, data: maskString(f.data) })),
  };
}

// Applied before a bundle leaves the browser. Idempotent.
export function redactBundle(bundle: CaptureBundle): CaptureBundle {
  return {
    ...bundle,
    // Titles are derived from console errors / failed URLs and can carry PII;
    // the captured page URL can carry magic-link / OAuth tokens. Both leave
    // the browser in filed tickets and LLM prompts, so they're masked too.
    title: maskString(bundle.title),
    environment: { ...bundle.environment, url: redactUrl(bundle.environment.url) },
    console: bundle.console.map((c) => ({ ...c, message: maskString(c.message) })),
    network: bundle.network.map(redactNetwork),
    // The DOM snapshot is page text/markup — it can contain visible PII (emails,
    // names, card numbers) and tokens in attributes. It leaves the browser in
    // the filed ticket and the HTML export, so it must be masked too.
    domSnapshot: bundle.domSnapshot ? maskString(bundle.domSnapshot) : bundle.domSnapshot,
    steps: bundle.steps.map((s) => (s.value ? { ...s, value: maskString(s.value) } : s)),
    // Replay frames are rebuilt into the DOM in the review/share view, so the
    // same pattern masking must apply to their html/value payloads. The
    // recorder already drops sensitive input values at capture; this is the
    // belt-and-braces pass for anything that slipped through (gap #1).
    replay: bundle.replay?.map((e) => ({
      ...e,
      html: e.html ? maskString(e.html) : e.html,
      value: e.value ? maskString(e.value) : e.value,
    })),
    redacted: true,
  };
}

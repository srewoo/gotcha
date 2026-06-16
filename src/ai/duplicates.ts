import type { CaptureBundle } from '@shared/types';
import { z } from 'zod';
import { chat, type AiConfig } from './llm';
import { maskString } from '@shared/redact';

// "Is this a dup?" (#3). Before filing, compare the current bug against recent
// reports and surface likely duplicates so the user doesn't file the same thing
// twice. Provider-agnostic: rather than store embedding vectors (OpenAI-only,
// adds persistence), we hand the model a compact candidate list and ask which
// match — cheap and works on every provider. Embeddings + cosine is the scale
// path once report volume is large.

const DupResult = z.object({
  duplicates: z.array(z.object({ id: z.string(), reason: z.string() })),
});

export interface DuplicateMatch {
  id: string;
  title: string;
  reason: string;
}

// A one-line fingerprint of a bug for the candidate list.
function fingerprint(b: CaptureBundle): string {
  const failed = b.network.find((n) => n.failed);
  const err = b.console.find((c) => c.level === 'error');
  // The AI summary is the strongest signal when present; fall back to the
  // first failed request, then the first console error, then the title.
  // (Parenthesized deliberately — `a ?? b ? x : y` parses as `(a ?? b) ? x : y`,
  // which silently discarded the summary and produced "undefined undefined".)
  const signal =
    b.aiAnalysis?.summary ??
    (failed ? `${failed.status} ${failed.method} ${failed.url}` : (err?.message ?? b.title));
  return `${b.title} :: ${signal}`.slice(0, 200);
}

const SYSTEM =
  'You deduplicate bug reports. Given a NEW bug and a list of EXISTING bugs (id :: fingerprint), ' +
  'return ONLY JSON {"duplicates":[{"id":string,"reason":string}]} listing existing bugs that are ' +
  'very likely the SAME underlying issue as the new one. Be conservative — only include strong matches. ' +
  'Empty array if none.';

// `current` is the bundle being filed; `recent` are other stored bundles.
export async function findDuplicates(
  current: CaptureBundle,
  recent: CaptureBundle[],
  cfg: AiConfig,
): Promise<DuplicateMatch[]> {
  // allBundles() returns key order (random UUIDs), so sort by recency before
  // capping — otherwise "the 30 most recent" was 30 arbitrary bundles.
  const candidates = recent
    .filter((b) => b.id !== current.id)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 30);
  if (candidates.length === 0) return [];

  const user = [
    `NEW bug:\n${current.aiAnalysis?.summary ?? fingerprint(current)}`,
    '',
    'EXISTING bugs:',
    ...candidates.map((b) => `${b.id} :: ${fingerprint(b)}`),
  ].join('\n');

  // Fingerprints are built from raw titles/URLs/console errors, which can carry
  // PII or tokens. Mask before sending — same guarantee the rest of the AI path
  // (and the UI copy) promises.
  const raw = await chat(cfg, SYSTEM, maskString(user));
  const fenced = raw.replace(/```(?:json)?/gi, '').trim();
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  // A prose-only reply (no braces) or malformed JSON means "no matches", the
  // same graceful degradation as a schema failure — never an escaped throw.
  if (start < 0 || end <= start) return [];
  let json: unknown;
  try {
    json = JSON.parse(fenced.slice(start, end + 1));
  } catch {
    return [];
  }
  const parsed = DupResult.safeParse(json);
  if (!parsed.success) return [];

  const byId = new Map(candidates.map((b) => [b.id, b.title]));
  return parsed.data.duplicates
    .filter((d) => byId.has(d.id))
    .map((d) => ({ id: d.id, title: byId.get(d.id) ?? '', reason: d.reason }));
}

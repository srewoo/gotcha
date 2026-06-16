import { describe, it, expect } from 'vitest';
import { mockFetch } from '../setup/chrome-mock';
import { makeBundle } from '../setup/factory';
import { findDuplicates } from '../../src/ai/duplicates';
import type { AiConfig } from '../../src/ai/llm';

const cfg: AiConfig = { provider: 'openai', apiKey: 'k', model: 'm' };

describe('ai — findDuplicates', () => {
  it('returns [] when there are no candidates', async () => {
    expect(await findDuplicates(makeBundle({ id: 'a' }), [], cfg)).toEqual([]);
  });

  it('maps model-reported ids back to titles and filters unknown ids', async () => {
    const current = makeBundle({ id: 'cur', title: 'Save fails' });
    const recent = [
      makeBundle({ id: 'r1', title: 'Saving broken' }),
      makeBundle({ id: 'r2', title: 'Unrelated' }),
    ];
    mockFetch(() => ({
      body: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                duplicates: [
                  { id: 'r1', reason: 'same save endpoint' },
                  { id: 'ghost', reason: 'not a real id' },
                ],
              }),
            },
          },
        ],
      },
    }));
    const dupes = await findDuplicates(current, recent, cfg);
    expect(dupes).toEqual([{ id: 'r1', title: 'Saving broken', reason: 'same save endpoint' }]);
  });

  it('returns [] when the model output fails schema validation', async () => {
    mockFetch(() => ({ body: { choices: [{ message: { content: '{"nope":1}' } }] } }));
    const dupes = await findDuplicates(makeBundle({ id: 'cur' }), [makeBundle({ id: 'r1' })], cfg);
    expect(dupes).toEqual([]);
  });

  it('should use the AI summary as the fingerprint signal when a candidate has one', async () => {
    const current = makeBundle({ id: 'cur', title: 'Save fails' });
    const withSummary = makeBundle({
      id: 'r1',
      title: 'Saving broken',
      // No failed network entry — the old precedence bug rendered this
      // candidate as "undefined undefined undefined" despite the summary.
      aiAnalysis: {
        summary: 'POST /save returns 500 due to backend timeout',
        rootCauses: [],
        debuggingSteps: [],
        provider: 'openai',
        model: 'm',
        at: 1,
      },
    });
    let sent = '';
    mockFetch((_u, init) => {
      sent = String(init?.body);
      return { body: { choices: [{ message: { content: '{"duplicates":[]}' } }] } };
    });
    await findDuplicates(current, [withSummary], cfg);
    expect(sent).toContain('POST /save returns 500 due to backend timeout');
    expect(sent).not.toContain('undefined undefined');
  });

  it('should fall back to the failed request fingerprint when there is no AI summary', async () => {
    const candidate = makeBundle({
      id: 'r1',
      network: [{ id: 'n1', url: 'https://a/save', method: 'POST', status: 500, durationMs: 1, failed: true, ts: 1 }],
    });
    let sent = '';
    mockFetch((_u, init) => {
      sent = String(init?.body);
      return { body: { choices: [{ message: { content: '{"duplicates":[]}' } }] } };
    });
    await findDuplicates(makeBundle({ id: 'cur' }), [candidate], cfg);
    expect(sent).toContain('500 POST https://a/save');
  });

  it('should keep the 30 most recent candidates when more than 30 exist', async () => {
    // Key-ordered input (random UUIDs in the real store) — oldest first here so
    // a missing sort would cap away the most recent bundles.
    const recent = Array.from({ length: 31 }, (_, i) =>
      makeBundle({ id: `cand-${i}`, title: `Bug number ${i}`, createdAt: 1000 + i }),
    );
    let sent = '';
    mockFetch((_u, init) => {
      sent = String(init?.body);
      return { body: { choices: [{ message: { content: '{"duplicates":[]}' } }] } };
    });
    await findDuplicates(makeBundle({ id: 'cur' }), recent, cfg);
    expect(sent).toContain('cand-30'); // newest survives the cap
    expect(sent).not.toContain('cand-0 ::'); // oldest is the one dropped
  });

  it('should return [] when the model replies with prose containing no JSON', async () => {
    mockFetch(() => ({
      body: { choices: [{ message: { content: 'I could not find any duplicates, sorry!' } }] },
    }));
    const dupes = await findDuplicates(makeBundle({ id: 'cur' }), [makeBundle({ id: 'r1' })], cfg);
    expect(dupes).toEqual([]);
  });

  it('should return [] when the brace slice is not valid JSON', async () => {
    mockFetch(() => ({ body: { choices: [{ message: { content: 'maybe {duplicates: nope}' } }] } }));
    const dupes = await findDuplicates(makeBundle({ id: 'cur' }), [makeBundle({ id: 'r1' })], cfg);
    expect(dupes).toEqual([]);
  });

  it('excludes the current bundle from candidates', async () => {
    let sent = '';
    mockFetch((_u, init) => {
      sent = String(init?.body);
      return { body: { choices: [{ message: { content: '{"duplicates":[]}' } }] } };
    });
    await findDuplicates(makeBundle({ id: 'cur' }), [makeBundle({ id: 'cur' })], cfg);
    // only the current bundle was supplied → no EXISTING candidates → no fetch body with its id beyond NEW
    expect(sent).toBe('');
  });
});

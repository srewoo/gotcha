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

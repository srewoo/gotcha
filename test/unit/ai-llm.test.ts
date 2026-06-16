import { describe, it, expect, beforeEach, vi } from 'vitest';
import { storageLocal, mockFetch } from '../setup/chrome-mock';
import { makeBundle } from '../setup/factory';
import {
  getAiConfig,
  analyzeBundle,
  analyzeBundleStream,
  generatePlaywrightTestWithAi,
  chat,
  type AiConfig,
} from '../../src/ai/llm';

const ANALYSIS_JSON = JSON.stringify({
  summary: 'Login fails with 500',
  rootCauses: ['backend down'],
  debuggingSteps: ['check server'],
  suggestedTitle: 'Login 500',
  severity: { level: 'P1', reason: 'no workaround' },
  testHints: { endStateAssertion: 'await expect(page).toHaveURL("/home")', selectors: [] },
});

function cfg(provider: AiConfig['provider']): AiConfig {
  return { provider, apiKey: 'k', model: 'm' };
}

describe('llm — getAiConfig', () => {
  it('returns null without a stored key', async () => {
    expect(await getAiConfig()).toBeNull();
  });

  it('defaults provider+model per provider', async () => {
    storageLocal.set({ aiApiKey: 'k' });
    expect(await getAiConfig()).toMatchObject({ provider: 'openai', model: 'gpt-4.1-mini' });
    storageLocal.set({ aiApiKey: 'k', aiProvider: 'anthropic' });
    expect((await getAiConfig())?.model).toBe('claude-haiku-4-5');
    storageLocal.set({ aiApiKey: 'k', aiProvider: 'gemini' });
    expect((await getAiConfig())?.model).toBe('gemini-2.5-flash');
  });

  it('honors a custom model', async () => {
    storageLocal.set({ aiApiKey: 'k', aiProvider: 'openai', aiModel: 'gpt-x' });
    expect((await getAiConfig())?.model).toBe('gpt-x');
  });

  it('returns null when the stored key is not a string', async () => {
    storageLocal.set({ aiApiKey: 12345 });
    expect(await getAiConfig()).toBeNull();
  });
});

describe('llm — evidence truncation', () => {
  it('truncates very large evidence before sending', async () => {
    let sentLen = 0;
    mockFetch((_u, init) => {
      const body = JSON.parse(String(init?.body));
      const userMsg = (body.messages ?? []).find((m: { role: string }) => m.role === 'user');
      sentLen = String(userMsg?.content ?? '').length;
      return { body: { choices: [{ message: { content: ANALYSIS_JSON } }] } };
    });
    // 500 steps with long labels easily exceeds the MAX_EVIDENCE ceiling.
    const steps = Array.from({ length: 500 }, (_, i) => ({
      id: `s${i}`,
      kind: 'click' as const,
      label: 'a very long label '.repeat(20) + i,
      ts: i,
    }));
    await analyzeBundle(makeBundle({ steps }), cfg('openai'));
    expect(sentLen).toBeLessThan(20000); // bounded by MAX_EVIDENCE (+ truncation marker)
  });
});

describe('llm — analyzeBundle per provider', () => {
  const cases: Array<[AiConfig['provider'], unknown, Record<string, unknown>]> = [
    ['openai', { choices: [{ message: { content: ANALYSIS_JSON } }] }, { Authorization: 'Bearer k' }],
    ['anthropic', { content: [{ text: ANALYSIS_JSON }] }, { 'x-api-key': 'k' }],
    ['gemini', { candidates: [{ content: { parts: [{ text: ANALYSIS_JSON }] } }] }, { 'x-goog-api-key': 'k' }],
  ];

  for (const [provider, body, expectHeaders] of cases) {
    it(`parses ${provider} response and sends max_tokens 12000`, async () => {
      let sentUrl = '';
      let sentBody: Record<string, unknown> = {};
      let sentHeaders: Record<string, string> = {};
      mockFetch((url, init) => {
        sentUrl = url;
        sentBody = JSON.parse(String(init?.body));
        sentHeaders = (init?.headers as Record<string, string>) ?? {};
        return { body };
      });
      const out = await analyzeBundle(makeBundle(), cfg(provider));
      expect(out.summary).toBe('Login fails with 500');
      expect(out.provider).toBe(provider);
      for (const [k, v] of Object.entries(expectHeaders)) expect(sentHeaders[k]).toBe(v);
      // max output token ceiling applied across providers
      const tokenField = provider === 'gemini'
        ? (sentBody.generationConfig as Record<string, unknown>).maxOutputTokens
        : sentBody.max_tokens;
      expect(tokenField).toBe(12000);
      if (provider === 'gemini') expect(sentUrl).toContain('generativelanguage.googleapis.com');
    });
  }

  it('should keep the Gemini API key out of the URL and encode the model path segment', async () => {
    let sentUrl = '';
    let sentHeaders: Record<string, string> = {};
    mockFetch((url, init) => {
      sentUrl = url;
      sentHeaders = (init?.headers as Record<string, string>) ?? {};
      return { body: { candidates: [{ content: { parts: [{ text: ANALYSIS_JSON }] } }] } };
    });
    await analyzeBundle(makeBundle(), { provider: 'gemini', apiKey: 'sekret', model: 'tuned models/x' });
    // Keys in query strings leak into logs/HARs — header only.
    expect(sentUrl).not.toContain('key=');
    expect(sentUrl).not.toContain('sekret');
    expect(sentHeaders['x-goog-api-key']).toBe('sekret');
    expect(sentUrl).toContain('tuned%20models%2Fx');
  });

  it('throws a helpful error on non-200', async () => {
    mockFetch(() => ({ status: 429, text: 'rate limited' }));
    await expect(analyzeBundle(makeBundle(), cfg('openai'))).rejects.toThrow(/OpenAI 429/);
  });

  it('throws when the model returns non-JSON', async () => {
    mockFetch(() => ({ body: { choices: [{ message: { content: 'not json at all' } }] } }));
    await expect(analyzeBundle(makeBundle(), cfg('openai'))).rejects.toThrow();
  });

  it('strips ```json fences before parsing', async () => {
    mockFetch(() => ({ body: { choices: [{ message: { content: '```json\n' + ANALYSIS_JSON + '\n```' } }] } }));
    const out = await analyzeBundle(makeBundle(), cfg('openai'));
    expect(out.suggestedTitle).toBe('Login 500');
  });
});

describe('llm — generatePlaywrightTestWithAi', () => {
  it('returns the spec when the model emits a valid test', async () => {
    const spec = "import { test, expect } from '@playwright/test';\ntest('x', async ({ page }) => {});";
    mockFetch(() => ({ body: { choices: [{ message: { content: '```ts\n' + spec + '\n```' } }] } }));
    const src = await generatePlaywrightTestWithAi(makeBundle(), cfg('openai'));
    expect(src).toContain('@playwright/test');
    expect(src).not.toContain('```');
  });

  it('throws when the model output is not a Playwright test (caller falls back)', async () => {
    mockFetch(() => ({ body: { choices: [{ message: { content: 'sorry I cannot' } }] } }));
    await expect(generatePlaywrightTestWithAi(makeBundle(), cfg('openai'))).rejects.toThrow(/Playwright test/);
  });

  it('does NOT request gemini JSON mime for codegen', async () => {
    const spec = "import { test, expect } from '@playwright/test';\ntest('x', async () => {});";
    let body: Record<string, unknown> = {};
    mockFetch((_u, init) => {
      body = JSON.parse(String(init?.body));
      return { body: { candidates: [{ content: { parts: [{ text: spec }] } }] } };
    });
    await generatePlaywrightTestWithAi(makeBundle(), cfg('gemini'));
    expect((body.generationConfig as Record<string, unknown>).responseMimeType).toBeUndefined();
  });
});

describe('llm — chatStream', () => {
  function sseStream(lines: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        for (const l of lines) controller.enqueue(enc.encode(l + '\n'));
        controller.close();
      },
    });
  }

  it('accumulates OpenAI deltas and returns the final analysis', async () => {
    // Two deltas: a prose preamble, then the full JSON object. parseResult
    // extracts the {...} slice from the accumulated text.
    const frames = [
      'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Here is the analysis: ' } }] }),
      'data: ' + JSON.stringify({ choices: [{ delta: { content: ANALYSIS_JSON } }] }),
      'data: [DONE]',
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: true, status: 200, body: sseStream(frames) } as unknown as Response)),
    );
    const deltas: string[] = [];
    const out = await analyzeBundleStream(makeBundle(), cfg('openai'), (d) => deltas.push(d));
    expect(out.summary).toBe('Login fails with 500');
    expect(deltas.join('')).toContain('Here is the analysis');
  });

  it('chat() rejects on a failed status', async () => {
    mockFetch(() => ({ status: 500, text: 'err' }));
    await expect(chat(cfg('openai'), 'sys', 'user')).rejects.toThrow(/OpenAI 500/);
  });

  it('accumulates Anthropic + Gemini SSE deltas', async () => {
    const json = JSON.stringify({ summary: 's', rootCauses: [], debuggingSteps: [] });
    const make = (frame: string) => {
      const enc = new TextEncoder();
      return new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode('data: ' + frame + '\n'));
          c.enqueue(enc.encode('data: [DONE]\n'));
          c.close();
        },
      });
    };
    // Anthropic delta shape
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({ ok: true, status: 200, body: make(JSON.stringify({ delta: { text: json } })) } as unknown as Response),
      ),
    );
    expect((await analyzeBundleStream(makeBundle(), cfg('anthropic'), () => {})).summary).toBe('s');

    // Gemini delta shape (parts joined)
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          body: make(JSON.stringify({ candidates: [{ content: { parts: [{ text: json }] } }] })),
        } as unknown as Response),
      ),
    );
    expect((await analyzeBundleStream(makeBundle(), cfg('gemini'), () => {})).summary).toBe('s');
  });

  it('throws when a provider returns empty content', async () => {
    mockFetch(() => ({ body: { choices: [{ message: {} }] } }));
    await expect(chat(cfg('openai'), 'sys', 'user')).rejects.toThrow(/Empty response/);
  });

  it('generatePlaywrightTestWithAi works on Anthropic', async () => {
    const spec = "import { test, expect } from '@playwright/test';\ntest('x', async () => {});";
    mockFetch(() => ({ body: { content: [{ text: spec }] } }));
    expect(await generatePlaywrightTestWithAi(makeBundle(), cfg('anthropic'))).toContain('@playwright/test');
  });
});

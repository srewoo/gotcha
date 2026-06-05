import type { CaptureBundle, AiAnalysis, AiAnalysisResult as AiAnalysisResultT } from '@shared/types';
import { AiAnalysisResult } from '@shared/types';
import { describeBundle } from '../integrations/format';

// Bring-your-own-key AI triage. Runs in the service worker (extension origin),
// so it can fetch cross-origin under <all_urls>. The bundle handed in MUST
// already be redacted (the worker redacts before calling) — we never send raw
// tokens/PII to a third-party model (CLAUDE.md §8).
//
// Providers: OpenAI, Anthropic, and Google Gemini. Latest models only.

export type AiProvider = 'openai' | 'anthropic' | 'gemini';

export interface AiConfig {
  provider: AiProvider;
  apiKey: string;
  model: string;
}

const MAX_EVIDENCE = 8000;

const SYSTEM = [
  'You are a senior engineer triaging a web application bug report.',
  'You are given evidence captured from the browser (already redacted of secrets/PII).',
  'Respond with ONLY a JSON object, no prose outside it, of this exact shape:',
  '{',
  '  "summary": string,            // one paragraph, plain English, what went wrong',
  '  "rootCauses": string[],       // 1-3 hypotheses, most-likely first',
  '  "debuggingSteps": string[],   // concrete ordered steps; cite the failing request/error/step',
  '  "suggestedTitle": string,     // a crisp <80-char bug title',
  '  "severity": { "level": "P0"|"P1"|"P2"|"P3", "reason": string },',
  '  "testHints": {                // help harden a Playwright regression test',
  '    "endStateAssertion": string,// ONE Playwright expect(...) line proving the bug is fixed',
  '    "selectors": [ { "stepId": string, "selector": string } ] // best selector per step, chosen from the candidates given',
  '  }',
  '}',
  'Severity scale: P0 data-loss/security/down, P1 major broken no workaround, P2 workaround exists, P3 minor/cosmetic.',
  'For selectors, choose ONLY from the candidate lists provided per step; prefer the most stable.',
  'Be specific, no filler.',
].join('\n');

export async function getAiConfig(): Promise<AiConfig | null> {
  const { aiProvider, aiApiKey, aiModel } = await chrome.storage.local.get([
    'aiProvider',
    'aiApiKey',
    'aiModel',
  ]);
  if (!aiApiKey || typeof aiApiKey !== 'string') return null;
  const provider = (aiProvider as AiProvider) || 'openai';
  return { provider, apiKey: aiApiKey, model: (aiModel as string) || defaultModel(provider) };
}

// Latest models only.
function defaultModel(provider: AiProvider): string {
  if (provider === 'anthropic') return 'claude-haiku-4-5';
  if (provider === 'gemini') return 'gemini-2.5-flash';
  return 'gpt-4.1-mini';
}

// Evidence = the shared markdown summary + the recorded steps WITH their
// selector candidates, so the model can pick the best selector per step (#2).
function evidence(bundle: CaptureBundle): string {
  const steps = bundle.steps
    .map((s) => {
      const cands = s.selectorCandidates?.length
        ? ` candidates=[${s.selectorCandidates.join(' | ')}]`
        : s.selector
          ? ` selector=${s.selector}`
          : '';
      return `- stepId=${s.id} ${s.kind} "${s.label}"${cands}`;
    })
    .join('\n');
  const text = `${describeBundle(bundle)}\n\n## Recorded steps (choose selectors from these)\n${steps || '_none_'}`;
  return text.length > MAX_EVIDENCE ? `${text.slice(0, MAX_EVIDENCE)}\n…[truncated]` : text;
}

// Pull a JSON object out of a model response that may be fenced or chatty.
function parseResult(content: string): AiAnalysisResultT {
  const fenced = content.replace(/```(?:json)?/gi, '').trim();
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  const slice = start >= 0 && end > start ? fenced.slice(start, end + 1) : fenced;
  const parsed = AiAnalysisResult.safeParse(JSON.parse(slice));
  if (!parsed.success) throw new Error('Model did not return the expected JSON shape');
  return parsed.data;
}

// ─── Low-level provider calls (reused by analyze + duplicate detection) ───────

interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

// One place that knows each provider's endpoint, auth, and request shape.
function buildRequest(cfg: AiConfig, system: string, user: string, stream: boolean): ProviderRequest {
  switch (cfg.provider) {
    case 'anthropic':
      return {
        url: 'https://api.anthropic.com/v1/messages',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': cfg.apiKey,
          'anthropic-version': '2023-06-01',
          // Required for direct browser/extension-origin calls.
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: { model: cfg.model, max_tokens: 1024, stream, system, messages: [{ role: 'user', content: user }] },
      };
    case 'gemini': {
      const method = stream ? 'streamGenerateContent?alt=sse&' : 'generateContent?';
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:${method}key=${cfg.apiKey}`,
        headers: { 'Content-Type': 'application/json' },
        body: {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          // Gemini can be told to emit raw JSON — perfect for our schema.
          generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
        },
      };
    }
    default: // openai
      return {
        url: 'https://api.openai.com/v1/chat/completions',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: {
          model: cfg.model,
          temperature: 0.1,
          stream,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        },
      };
  }
}

const PROVIDER_LABEL: Record<AiProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
};

async function fail(res: Response, label: string): Promise<never> {
  throw new Error(`${label} ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

// Minimal response shapes per provider (only the fields we read).
type AnthropicResp = { content?: Array<{ text?: string }>; delta?: { text?: string } };
type GeminiResp = { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
type OpenAiResp = {
  choices?: Array<{ message?: { content?: string }; delta?: { content?: string } }>;
};

// Pull the text content out of a provider's NON-streaming JSON response.
function extractContent(cfg: AiConfig, json: unknown): string {
  let content: string | undefined;
  if (cfg.provider === 'anthropic') content = (json as AnthropicResp).content?.[0]?.text;
  else if (cfg.provider === 'gemini')
    content = (json as GeminiResp).candidates?.[0]?.content?.parts?.[0]?.text;
  else content = (json as OpenAiResp).choices?.[0]?.message?.content;
  if (!content) throw new Error(`Empty response from ${PROVIDER_LABEL[cfg.provider]}`);
  return content;
}

// Pull a text delta out of one parsed streaming SSE frame.
function extractDelta(cfg: AiConfig, json: unknown): string {
  if (cfg.provider === 'anthropic') return (json as AnthropicResp).delta?.text ?? '';
  if (cfg.provider === 'gemini')
    return (json as GeminiResp).candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  return (json as OpenAiResp).choices?.[0]?.delta?.content ?? '';
}

export async function chat(cfg: AiConfig, system: string, user: string): Promise<string> {
  const req = buildRequest(cfg, system, user, false);
  const res = await fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body) });
  if (!res.ok) await fail(res, PROVIDER_LABEL[cfg.provider]);
  return extractContent(cfg, await res.json());
}

// Streaming variant (#5). Emits text deltas via onDelta and returns the full
// accumulated content. Parses provider-specific SSE frames.
export async function chatStream(
  cfg: AiConfig,
  system: string,
  user: string,
  onDelta: (text: string) => void,
): Promise<string> {
  const req = buildRequest(cfg, system, user, true);
  const res = await fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body) });
  if (!res.ok || !res.body) {
    if (!res.ok) await fail(res, PROVIDER_LABEL[cfg.provider]);
    throw new Error('No response stream');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const delta = extractDelta(cfg, JSON.parse(data));
        if (delta) {
          full += delta;
          onDelta(delta);
        }
      } catch {
        // ignore keep-alive / non-JSON frames
      }
    }
  }
  return full;
}

function stamp(result: AiAnalysisResultT, cfg: AiConfig): AiAnalysis {
  return { ...result, provider: cfg.provider, model: cfg.model, at: Date.now() };
}

// Analyse an ALREADY-REDACTED bundle (non-streaming).
export async function analyzeBundle(bundle: CaptureBundle, cfg: AiConfig): Promise<AiAnalysis> {
  return stamp(parseResult(await chat(cfg, SYSTEM, evidence(bundle))), cfg);
}

// Streaming analyse: onDelta gets raw token deltas; the final structured result
// is parsed from the full accumulated content.
export async function analyzeBundleStream(
  bundle: CaptureBundle,
  cfg: AiConfig,
  onDelta: (text: string) => void,
): Promise<AiAnalysis> {
  const full = await chatStream(cfg, SYSTEM, evidence(bundle), onDelta);
  return stamp(parseResult(full), cfg);
}

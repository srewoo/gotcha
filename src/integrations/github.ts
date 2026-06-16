import type { CaptureBundle } from '@shared/types';
import { describeBundle } from './format';
import {
  simulatedRef,
  type FileResult,
  type Integration,
  type TestResult,
  type TriageFields,
} from './types';

// GitHub Issues (PRD v2). Needs a fine-grained PAT with Issues:write and a
// "owner/repo" target in chrome.storage.local.
async function config(): Promise<{ token?: string; repo?: string }> {
  const { githubToken, githubRepo } = await chrome.storage.local.get(['githubToken', 'githubRepo']);
  return { token: githubToken, repo: githubRepo };
}

export const github: Integration = {
  id: 'github',
  name: 'GitHub',
  async file(bundle: CaptureBundle, fields?: TriageFields): Promise<FileResult> {
    const { token, repo } = await config();
    if (!token || !repo) return simulatedRef('github');

    const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      // Triage rides in the body text (see format.ts) — assigning a GitHub
      // login that doesn't exist on the repo would 422 the whole filing.
      body: JSON.stringify({
        title: bundle.title,
        body: describeBundle(bundle, { fields }),
        labels: ['bug', 'gotcha'],
      }),
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const json = (await res.json()) as { number: number; html_url: string };
    return {
      integration: 'github',
      identifier: `#${json.number}`,
      url: json.html_url,
      simulated: false,
    };
  },
  async test(): Promise<TestResult> {
    const { token, repo } = await config();
    if (!token || !repo) return { ok: false, detail: 'Not configured' };
    const res = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
    return res.ok ? { ok: true } : { ok: false, detail: `GitHub ${res.status}` };
  },
};

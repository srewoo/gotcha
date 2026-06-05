import type { CaptureBundle } from '@shared/types';
import { describeBundle } from './format';
import { simulatedRef, type FileResult, type Integration, type TestResult } from './types';

// Jira Cloud (PRD v2). Needs site host, email, API token, and a project key in
// chrome.storage.local. Jira's v3 API expects Atlassian Document Format, but it
// also accepts a plain wiki/markdown-ish description block; we send a single
// paragraph node carrying the markdown so this stays dependency-free.
async function config(): Promise<{
  host?: string;
  email?: string;
  token?: string;
  projectKey?: string;
}> {
  const { jiraHost, jiraEmail, jiraToken, jiraProjectKey } = await chrome.storage.local.get([
    'jiraHost',
    'jiraEmail',
    'jiraToken',
    'jiraProjectKey',
  ]);
  return { host: jiraHost, email: jiraEmail, token: jiraToken, projectKey: jiraProjectKey };
}

function adf(text: string): unknown {
  return {
    type: 'doc',
    version: 1,
    content: text
      .split('\n\n')
      .map((para) => ({ type: 'paragraph', content: [{ type: 'text', text: para || ' ' }] })),
  };
}

export const jira: Integration = {
  id: 'jira',
  name: 'Jira',
  async file(bundle: CaptureBundle): Promise<FileResult> {
    const { host, email, token, projectKey } = await config();
    if (!host || !email || !token || !projectKey) return simulatedRef('jira');

    const auth = btoa(`${email}:${token}`);
    const res = await fetch(`https://${host}/rest/api/3/issue`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fields: {
          project: { key: projectKey },
          issuetype: { name: 'Bug' },
          summary: bundle.title,
          description: adf(describeBundle(bundle)),
        },
      }),
    });
    if (!res.ok) throw new Error(`Jira API ${res.status}`);
    const json = (await res.json()) as { key: string };
    return {
      integration: 'jira',
      identifier: json.key,
      url: `https://${host}/browse/${json.key}`,
      simulated: false,
    };
  },
  async test(): Promise<TestResult> {
    const { host, email, token } = await config();
    if (!host || !email || !token) return { ok: false, detail: 'Not configured' };
    const res = await fetch(`https://${host}/rest/api/3/myself`, {
      headers: { Authorization: `Basic ${btoa(`${email}:${token}`)}`, Accept: 'application/json' },
    });
    return res.ok ? { ok: true } : { ok: false, detail: `Jira ${res.status}` };
  },
};

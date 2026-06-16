import type { CaptureBundle } from '@shared/types';
import { describeBundle } from './format';
import {
  simulatedRef,
  type FileResult,
  type Integration,
  type TestResult,
  type TriageFields,
} from './types';

// Jira Cloud (PRD v2). Needs site host, email, API token, and a project key in
// chrome.storage.local. Jira's v3 API expects Atlassian Document Format —
// raw markdown inside plain-text paragraphs renders literally ("##", "**",
// fences), so adf() does a minimal dependency-free markdown→ADF mapping.
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

// ADF node builders (text nodes may not be empty — pad with a space).
const textNode = (text: string): unknown => ({ type: 'text', text: text || ' ' });
const paragraph = (text: string): unknown => ({ type: 'paragraph', content: [textNode(text)] });

// Minimal markdown→ADF mapping for describeBundle's output: `## `/`### `
// headings, ``` fenced code blocks, consecutive `- ` bullets, and paragraphs
// for everything else. Inline bold markers are left as plain text — acceptable
// noise versus pulling in a full markdown parser.
function adf(text: string): unknown {
  const content: unknown[] = [];
  const lines = text.split('\n');
  let para: string[] = [];
  const flushPara = (): void => {
    const joined = para.join('\n').trim();
    if (joined) content.push(paragraph(joined));
    para = [];
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('```')) {
      flushPara();
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.startsWith('```')) {
        code.push(lines[i]!);
        i += 1;
      }
      i += 1; // skip the closing fence (or run off the end on an unclosed one)
      content.push({ type: 'codeBlock', content: [textNode(code.join('\n'))] });
      continue;
    }
    const heading = /^(#{2,3}) (.+)$/.exec(line);
    if (heading) {
      flushPara();
      content.push({
        type: 'heading',
        attrs: { level: heading[1]!.length },
        content: [textNode(heading[2]!)],
      });
      i += 1;
      continue;
    }
    if (line.startsWith('- ')) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length && lines[i]!.startsWith('- ')) {
        items.push(lines[i]!.slice(2));
        i += 1;
      }
      content.push({
        type: 'bulletList',
        content: items.map((item) => ({ type: 'listItem', content: [paragraph(item)] })),
      });
      continue;
    }
    if (line.trim() === '') {
      flushPara();
      i += 1;
      continue;
    }
    para.push(line);
    i += 1;
  }
  flushPara();
  if (content.length === 0) content.push(paragraph(' '));
  return { type: 'doc', version: 1, content };
}

export const jira: Integration = {
  id: 'jira',
  name: 'Jira',
  async file(bundle: CaptureBundle, fields?: TriageFields): Promise<FileResult> {
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
          // Triage rides in the description body (see format.ts) — setting a
          // Jira-native priority/assignee that the project doesn't define
          // returns a 400 and kills the whole filing.
          description: adf(describeBundle(bundle, { fields })),
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

import type { CaptureBundle } from '@shared/types';
import { describeBundle } from './format';
import {
  simulatedRef,
  type FileResult,
  type Integration,
  type TestResult,
  type TriageFields,
} from './types';

// Linear is the MVP integration (PRD §6). Files via GraphQL when an API key +
// team id are configured in chrome.storage.local; simulates otherwise.
const LINEAR_API = 'https://api.linear.app/graphql';

async function config(): Promise<{ apiKey?: string; teamId?: string }> {
  const { linearApiKey, linearTeamId } = await chrome.storage.local.get([
    'linearApiKey',
    'linearTeamId',
  ]);
  return { apiKey: linearApiKey, teamId: linearTeamId };
}

export const linear: Integration = {
  id: 'linear',
  name: 'Linear',
  async file(bundle: CaptureBundle, fields?: TriageFields): Promise<FileResult> {
    const { apiKey, teamId } = await config();
    if (!apiKey || !teamId) return simulatedRef('linear');

    const query = `
      mutation IssueCreate($input: IssueCreateInput!) {
        issueCreate(input: $input) { success issue { identifier url } }
      }`;
    const res = await fetch(LINEAR_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: apiKey },
      body: JSON.stringify({
        query,
        // Triage rides in the description body (see format.ts for why we never
        // map it to Linear-native team/assignee/priority ids here).
        variables: {
          input: { teamId, title: bundle.title, description: describeBundle(bundle, { fields }) },
        },
      }),
    });
    if (!res.ok) throw new Error(`Linear API ${res.status}`);
    const json = (await res.json()) as {
      data?: { issueCreate?: { success: boolean; issue?: { identifier: string; url: string } } };
      errors?: Array<{ message: string }>;
    };
    const issue = json.data?.issueCreate?.issue;
    if (!json.data?.issueCreate?.success || !issue) {
      throw new Error(json.errors?.[0]?.message ?? 'Linear issue creation failed');
    }
    return { integration: 'linear', identifier: issue.identifier, url: issue.url, simulated: false };
  },
  async test(): Promise<TestResult> {
    const { apiKey } = await config();
    if (!apiKey) return { ok: false, detail: 'Not configured' };
    const res = await fetch(LINEAR_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: apiKey },
      body: JSON.stringify({ query: '{ viewer { id name } }' }),
    });
    if (!res.ok) return { ok: false, detail: `Linear ${res.status}` };
    const json = (await res.json()) as { data?: { viewer?: { id: string } } };
    return json.data?.viewer?.id ? { ok: true } : { ok: false, detail: 'Invalid API key' };
  },
};

import type { CaptureBundle } from '@shared/types';
import { describeBundle } from './format';
import {
  simulatedRef,
  type FileResult,
  type Integration,
  type TestResult,
  type TriageFields,
} from './types';

// Reads the Incoming Webhook URL stored in chrome.storage.local.
async function config(): Promise<{ webhookUrl: string | undefined }> {
  const { slackWebhookUrl } = await chrome.storage.local.get(['slackWebhookUrl']);
  return { webhookUrl: slackWebhookUrl as string | undefined };
}

// Build a Slack Block Kit payload for the bug summary.
// Using header + section blocks so the message is scannable at a glance.
function buildBlocks(bundle: CaptureBundle, fields?: TriageFields): unknown {
  const env = bundle.environment;
  const failedCount = bundle.network.filter((n) => n.failed).length;
  const topError =
    bundle.console.find((c) => c.level === 'error')?.message ?? '_none_';
  const hasTest = bundle.generatedTest != null;

  return {
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: bundle.title.slice(0, 150), // Slack header max is 150 chars
          emoji: true,
        },
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Steps recorded*\n${bundle.steps.length}`,
          },
          {
            type: 'mrkdwn',
            text: `*Failed requests*\n${failedCount}`,
          },
          {
            type: 'mrkdwn',
            text: `*Top console error*\n\`${topError.slice(0, 300)}\``,
          },
          {
            type: 'mrkdwn',
            text: `*Regression test generated*\n${hasTest ? '✓ Yes' : '✗ No'}`,
          },
        ],
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Environment*\n${env.browser} · ${env.os}`,
          },
          {
            type: 'mrkdwn',
            text: `*URL*\n${env.url.slice(0, 300)}`,
          },
          {
            type: 'mrkdwn',
            text: `*Viewport*\n${env.viewport.width}×${env.viewport.height} · DPR ${env.dpr}`,
          },
          {
            type: 'mrkdwn',
            text: `*Redacted*\n${bundle.redacted ? '✓ Yes' : '✗ No'}`,
          },
        ],
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Filed by *Gotcha* · <${env.url}|source page>`,
          },
        ],
      },
    ],
    // Fallback text for notifications and accessibility — describeBundle gives
    // a well-formatted markdown summary that mirrors what other integrations
    // use, and carries the triage line (team/assignee/priority) when chosen.
    text: describeBundle(bundle, { fields }),
  };
}

export const slack: Integration = {
  id: 'slack',
  name: 'Slack',
  async file(bundle: CaptureBundle, fields?: TriageFields): Promise<FileResult> {
    const { webhookUrl } = await config();
    if (!webhookUrl) return simulatedRef('slack');

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildBlocks(bundle, fields)),
    });

    if (!res.ok) throw new Error(`Slack webhook ${res.status}`);

    // Slack Incoming Webhooks return only "ok" as plain text; they do NOT
    // return a message URL or identifier. We return a stable sentinel value so
    // callers can distinguish a real post from a simulated one.
    return { integration: 'slack', identifier: 'posted', url: '#', simulated: false };
  },
  // Slack webhooks have no read endpoint, so the only real validation is to
  // post — we send a clearly-labelled test message (the user explicitly asked).
  async test(): Promise<TestResult> {
    const { webhookUrl } = await config();
    if (!webhookUrl) return { ok: false, detail: 'Not configured' };
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '✅ Gotcha test connection — your webhook works.' }),
    });
    return res.ok ? { ok: true } : { ok: false, detail: `Slack ${res.status}` };
  },
};

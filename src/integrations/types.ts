import type { CaptureBundle } from '@shared/types';

export type IntegrationId = 'linear' | 'jira' | 'github' | 'slack';

export interface FileResult {
  integration: IntegrationId;
  identifier: string;
  url: string;
  simulated: boolean;
}

export interface TestResult {
  ok: boolean;
  detail?: string;
}

export interface Integration {
  readonly id: IntegrationId;
  readonly name: string;
  // Files the bundle and returns a reference. Implementations simulate a
  // reference when no credentials are configured, so the flow stays testable.
  file(bundle: CaptureBundle): Promise<FileResult>;
  // Validates the configured credentials with a lightweight authenticated call.
  test(): Promise<TestResult>;
}

// A short fake reference for offline/demo mode.
export function simulatedRef(id: IntegrationId): FileResult {
  const n = Math.floor(100 + Math.random() * 900);
  const prefix = { linear: 'GOT', jira: 'BUG', github: '', slack: 'MSG' }[id];
  return {
    integration: id,
    identifier: prefix ? `${prefix}-${n}` : `#${n}`,
    url: '#',
    simulated: true,
  };
}

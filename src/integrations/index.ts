import type { Integration, IntegrationId } from './types';
import { linear } from './linear';
import { jira } from './jira';
import { github } from './github';
import { slack } from './slack';

const REGISTRY: Record<IntegrationId, Integration> = {
  linear,
  jira,
  github,
  slack,
};

export function getIntegration(id: IntegrationId): Integration {
  return REGISTRY[id];
}

export const INTEGRATIONS: ReadonlyArray<Integration> = [linear, jira, github, slack];

export type { Integration, IntegrationId, FileResult } from './types';

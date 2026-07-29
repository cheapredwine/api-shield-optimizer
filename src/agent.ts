import type { Endpoint, ConnectorConfig, NormalizedGroup, ProposalBundle } from './types.js';
import { createConnector } from './connectors/index.js';
import { groupEndpoints } from './normalize.js';
import { classifyGroup } from './classify.js';
import { generateBundle } from './proposal.js';

export interface AgentOptions {
  connectorConfig: ConnectorConfig;
  minHits?: number;
  maxGroups?: number;
}

export class ShieldOptimizerAgent {
  async run(options: AgentOptions): Promise<ProposalBundle> {
    const connector = createConnector(options.connectorConfig);
    const endpoints = await connector.fetchEndpoints(options.connectorConfig);

    const filtered = this.filterEndpoints(endpoints, options);
    let groups = groupEndpoints(filtered);
    groups = groups.map((g) => {
      const classification = classifyGroup(g);
      return {
        ...g,
        recommendedAction: classification.action,
        confidence: classification.confidence,
        reasoning: classification.reasoning,
        flags: classification.flags,
      };
    });

    groups.sort((a, b) => {
      const hitsA = a.members.reduce((s: number, m: Endpoint) => s + m.hits, 0);
      const hitsB = b.members.reduce((s: number, m: Endpoint) => s + m.hits, 0);
      return hitsB - hitsA;
    });

    if (options.maxGroups && options.maxGroups > 0) {
      groups = groups.slice(0, options.maxGroups);
    }

    return generateBundle(groups);
  }

  private filterEndpoints(endpoints: Endpoint[], options: AgentOptions): Endpoint[] {
    let out = endpoints;
    if (options.minHits !== undefined && options.minHits > 0) {
      out = out.filter((e) => e.hits >= options.minHits!);
    }
    return out;
  }
}

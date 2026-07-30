import type {
  BudgetReport,
  ConnectorConfig,
  DataConnector,
  Endpoint,
  NormalizedGroup,
  ProposalBundle,
} from './types.js';
import { createConnector } from './connectors/index.js';
import { groupEndpoints } from './normalize.js';
import { applySiblingPropagation, classifyGroup, totalKnownHits, totalRequestsPerHour } from './classify.js';
import { generateBundle, type BundleContext } from './proposal.js';
import { resolveScoringConfig, type CompiledScoringConfig, type ScoringConfig } from './scoring-config.js';

export interface AgentOptions {
  connectorConfig: ConnectorConfig;
  minHits?: number;
  maxGroups?: number;
  /** Operation cap for the zone plan, used for budget reporting. */
  operationBudget?: number;
  /**
   * Analyse operations already saved or ignored in the zone. Defaults to true:
   * saved operations occupy the operation budget, and a saved operation is the
   * only place a `cf-risk-zombie` label can appear, so omitting them hides both
   * the slots in use and the slots worth reclaiming.
   */
  includeDecided?: boolean;
  /** Raw members embedded per proposal. `0` embeds every member. */
  maxEmbeddedMembers?: number;
  scoringOverrides?: Partial<ScoringConfig>;
}

export class ShieldOptimizerAgent {
  /**
   * The factory is injectable so tests can supply a stub connector. Normal
   * callers omit it and get the standard api/snapshot factory.
   */
  constructor(private readonly connectorFactory: (config: ConnectorConfig) => DataConnector = createConnector) {}

  async run(options: AgentOptions): Promise<ProposalBundle> {
    const connector = this.connectorFactory(options.connectorConfig);
    const endpoints = await connector.fetchEndpoints(options.connectorConfig);
    return this.analyze(endpoints, options);
  }

  /** Pure analysis stage, exposed for testing and for offline re-scoring. */
  analyze(endpoints: Endpoint[], options: AgentOptions): ProposalBundle {
    const config = resolveScoringConfig(options.scoringOverrides);

    const alreadySaved = endpoints.filter((e) => e.status === 'saved').length;
    const alreadyIgnored = endpoints.filter((e) => e.status === 'ignored').length;

    const candidates =
      options.includeDecided ?? true
        ? endpoints
        : endpoints.filter((e) => e.status !== 'saved' && e.status !== 'ignored');

    const filtered = this.filterEndpoints(candidates, options);

    let groups = groupEndpoints(filtered);
    groups = groups.map((group) => {
      const classification = classifyGroup(group, config);
      return {
        ...group,
        recommendedAction: classification.action,
        confidence: classification.confidence,
        score: classification.score,
        signals: classification.signals,
        reasoning: classification.reasoning,
        flags: classification.flags,
      };
    });

    groups = applySiblingPropagation(groups, config);

    const conflicting = this.findConflictingGroups(groups);

    // Rank by value so that a `maxGroups` or budget cut keeps the best entries.
    groups.sort((a, b) => rankValue(b) - rankValue(a));

    const analyzedGroupCount = groups.length;
    const analyzedEndpointCount = groups.reduce((sum, g) => sum + g.members.length, 0);

    if (options.maxGroups && options.maxGroups > 0) {
      groups = groups.slice(0, options.maxGroups);
    }

    const budget = this.buildBudget(groups, alreadySaved, options, config);

    const context: BundleContext = {
      zoneId: options.connectorConfig.zoneId,
      accountId: options.connectorConfig.accountId,
      analyzedGroupCount,
      analyzedEndpointCount,
      alreadyDecided: {
        saved: alreadySaved,
        ignored: alreadyIgnored,
        conflicting,
      },
      budget,
      rulesetVersion: config.rulesetVersion,
      maxEmbeddedMembers: options.maxEmbeddedMembers,
    };

    return generateBundle(groups, context);
  }

  private filterEndpoints(endpoints: Endpoint[], options: AgentOptions): Endpoint[] {
    const { minHits } = options;
    if (minHits === undefined || !Number.isFinite(minHits) || minHits <= 0) return endpoints;

    // Endpoints without traffic data are retained: `null` means unknown, not
    // zero. Dropping them silently removed every managed operation.
    return endpoints.filter((e) => e.hits === null || e.hits === undefined || e.hits >= minHits);
  }

  /** Groups whose members disagree about their current saved/ignored state. */
  private findConflictingGroups(groups: NormalizedGroup[]): string[] {
    return groups
      .filter((group) => {
        const states = new Set(group.members.map((m) => m.status ?? 'candidate'));
        return states.has('saved') && states.has('ignored');
      })
      .map((group) => group.groupId);
  }

  /**
   * Reports how the proposed saves fit within the zone's operation allowance.
   * API Shield caps saved operations per plan, so the useful question is not
   * "what could be saved" but "what are the best N to save".
   */
  private buildBudget(
    groups: NormalizedGroup[],
    alreadySaved: number,
    options: AgentOptions,
    config: CompiledScoringConfig,
  ): BudgetReport {
    const proposedSaves = groups.filter((g) => g.recommendedAction === 'save').length;
    const limit = options.operationBudget;
    const notes: string[] = [];

    if (limit === undefined) {
      notes.push(
        'No operation budget configured. Set `operationBudget` to the zone plan limit to rank proposals against available slots.',
      );
      return { alreadySaved, proposedSaves, overBudget: false, notes };
    }

    const remaining = limit - alreadySaved - proposedSaves;
    const overBudget = remaining < 0;

    if (overBudget) {
      notes.push(
        `Proposals exceed the operation budget by ${Math.abs(remaining)}. ` +
          `Proposals are ranked by value, so the first ${Math.max(0, limit - alreadySaved)} saves are the highest priority.`,
      );
    } else {
      notes.push(`${remaining} operation slot(s) remain after applying the proposed saves.`);
    }

    notes.push(`Ranking uses ruleset ${config.rulesetVersion}.`);

    return { limit, alreadySaved, proposedSaves, remaining, overBudget, notes };
  }
}

/**
 * Value ranking for budget allocation. Combines decision score, evidence
 * strength and traffic so the most defensible high-impact groups sort first.
 */
export function rankValue(group: NormalizedGroup): number {
  const actionWeight = group.recommendedAction === 'save' ? 1 : group.recommendedAction === 'manual_review' ? 0.5 : 0;

  // Traffic is the main proxy for "this matters". Absolute hits are preferred,
  // but the discovery API only reports a rate, so fall back to it — otherwise
  // every live endpoint contributes zero and ranking degenerates to path order.
  const hits = totalKnownHits(group.members);
  const magnitude = hits > 0 ? hits : (totalRequestsPerHour(group.members) ?? 0);
  const trafficComponent = Math.log10(Math.max(1, magnitude)) / 8;

  return actionWeight * 2 + group.score.combined + group.confidence * 0.5 + trafficComponent;
}

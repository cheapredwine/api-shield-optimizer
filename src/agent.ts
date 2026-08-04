import type {
  BudgetReport,
  ConnectorConfig,
  DataConnector,
  Endpoint,
  NormalizedGroup,
  ProposalBundle,
} from './types.js';
import { CloudflareApiConnector } from './connectors/index.js';
import { groupEndpoints } from './normalize.js';
import {
  applySiblingPropagation,
  classifyGroup,
  computeTrafficThresholds,
  requestsPerHour,
  totalKnownHits,
  totalRequestsPerHour,
} from './classify.js';
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
   * The connector is injectable so tests can drive `run()` without HTTP. There
   * is exactly one production implementation.
   */
  constructor(private readonly connector: DataConnector = new CloudflareApiConnector()) {}

  async run(options: AgentOptions): Promise<ProposalBundle> {
    const endpoints = await this.connector.fetchEndpoints(options.connectorConfig);
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

    // Derived once from the whole zone: a traffic threshold relative to this
    // zone's own distribution keeps discriminating at any request volume.
    const traffic = computeTrafficThresholds(groups, config);

    groups = groups.map((group) => {
      const classification = classifyGroup(group, config, traffic);
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

    const analyzedGroups = groups;
    const analyzedGroupCount = groups.length;
    const analyzedEndpointCount = groups.reduce((sum, g) => sum + g.members.length, 0);

    if (options.maxGroups && options.maxGroups > 0) {
      groups = groups.slice(0, options.maxGroups);
    }

    // Budget is computed from every analysed group, not from the truncated
    // report. `maxGroups` limits what is printed, not what the zone contains, so
    // counting after truncation understates the saves and claims slots that are
    // not free.
    const budget = this.buildBudget(
      analyzedGroups,
      alreadySaved,
      options,
      config,
      analyzedGroups.length - groups.length,
    );

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

    return endpoints.filter((e) => {
      const level = observedTrafficLevel(e);
      // Endpoints without traffic data are retained: `null` means unknown, not
      // zero. Dropping them removes every managed operation.
      return level === null || level >= minHits;
    });
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
   *
   * Known quirk: `proposedSaves` counts every group classified `save`
   * regardless of whether it is already saved, so a group that is both
   * `alreadySaved` and still recommended `save` is subtracted from `limit`
   * twice (once via `alreadySaved`, once via `proposedSaves`) even though it
   * occupies one real slot. A zone sitting exactly at capacity, where every
   * saved operation still correctly scores `save`, reports `overBudget: true`
   * when it should not. See `src/__tests__/engine.test.ts`'s "budget and
   * ranking" tests for the exact numbers this produces.
   */
  private buildBudget(
    groups: NormalizedGroup[],
    alreadySaved: number,
    options: AgentOptions,
    config: CompiledScoringConfig,
    omittedGroups = 0,
  ): BudgetReport {
    const proposedSaves = groups.filter((g) => g.recommendedAction === 'save').length;
    const limit = options.operationBudget;
    const notes: string[] = [];

    if (omittedGroups > 0) {
      notes.push(
        `Budget covers all ${groups.length} analysed group(s); ${omittedGroups} are omitted from this ` +
          'report by --max-groups and are still counted here.',
      );
    }

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
 * Traffic level for filtering, or `null` when nothing is known.
 *
 * Absolute hits are preferred, but the discovery API only ever reports a rate,
 * so a threshold that inspects `hits` alone is a silent no-op against a live
 * zone. `null` is preserved so unknown traffic is never treated as zero.
 */
export function observedTrafficLevel(endpoint: Endpoint): number | null {
  if (endpoint.hits !== null && endpoint.hits !== undefined) return endpoint.hits;
  return requestsPerHour(endpoint);
}

/** Tier gap between actions, wider than every tiebreaker combined. */
const ACTION_TIER_SPAN = 10;

/**
 * Value ranking for budget allocation. Combines decision score, evidence
 * strength and traffic so the most defensible high-impact groups sort first.
 *
 * The action is a strict tier rather than one term among several. Budget slots
 * are spent on saves, so a high-traffic `manual_review` must never sort above a
 * `save`: the tiebreakers together span at most ~2.6, well inside the tier gap.
 */
export function rankValue(group: NormalizedGroup): number {
  const tier = group.recommendedAction === 'save' ? 2 : group.recommendedAction === 'manual_review' ? 1 : 0;

  // Traffic is the main proxy for "this matters". Absolute hits are preferred,
  // but the discovery API only reports a rate, so fall back to it — otherwise
  // every live endpoint contributes zero and ranking degenerates to path order.
  const hits = totalKnownHits(group.members);
  const magnitude = hits > 0 ? hits : (totalRequestsPerHour(group.members) ?? 0);
  // Bounded so a very large zone cannot let traffic dominate the tiebreakers.
  const trafficComponent = Math.min(1, Math.log10(Math.max(1, magnitude)) / 8);

  return tier * ACTION_TIER_SPAN + group.score.combined + group.confidence * 0.5 + trafficComponent;
}

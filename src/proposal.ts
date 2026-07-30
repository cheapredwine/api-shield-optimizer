import type { BudgetReport, Endpoint, NormalizedGroup, Proposal, ProposalBundle } from './types.js';
import { DEFAULT_SCORING_CONFIG } from './scoring-config.js';
import { formatRate, requestsPerHour, totalKnownHits, totalRequestsPerHour } from './classify.js';

/**
 * Default cap on raw endpoints embedded per proposal. A zone can produce groups
 * with thousands of members; embedding all of them makes both the JSON bundle
 * and the text report unwieldy. Callers that need a complete audit trail can
 * raise or disable the cap via `maxEmbeddedMembers`.
 */
export const MAX_EMBEDDED_MEMBERS = 25;
const REPRESENTATIVE_MEMBERS = 5;

export interface BundleContext {
  zoneId?: string;
  accountId?: string;
  analyzedGroupCount: number;
  analyzedEndpointCount: number;
  alreadyDecided: ProposalBundle['alreadyDecided'];
  budget: BudgetReport;
  rulesetVersion?: string;
  /** Members embedded per proposal. `0` or negative embeds every member. */
  maxEmbeddedMembers?: number;
}

/** Picks a spread of members rather than the first N, so samples are varied. */
function sampleMembers(members: Endpoint[], limit: number): Endpoint[] {
  if (limit <= 0 || members.length <= limit) return members;
  const step = members.length / limit;
  const out: Endpoint[] = [];
  for (let i = 0; i < limit; i++) {
    out.push(members[Math.floor(i * step)]);
  }
  return out;
}

export function generateProposal(group: NormalizedGroup, maxEmbeddedMembers = MAX_EMBEDDED_MEMBERS): Proposal {
  const canonicalPattern = `${group.normalizedHostPattern}${group.normalizedPathPattern}`;
  const representative = sampleMembers(group.members, REPRESENTATIVE_MEMBERS);
  const embedded = sampleMembers(group.members, maxEmbeddedMembers);

  const safeReasons: string[] = [];
  if (group.normalizedPathPattern.includes('{var')) {
    safeReasons.push('Variable segments normalized using ID/UUID/date/entropy heuristics.');
  }
  if (group.normalizedHostPattern.includes('{hostVar')) {
    safeReasons.push('Hostname variable covers a complete label and never touches the registrable domain.');
  }
  if (group.members.every((m) => m.method.toUpperCase() === group.method.toUpperCase())) {
    safeReasons.push('All members share the same HTTP method.');
  }
  if (safeReasons.length === 0) {
    safeReasons.push('Exact path match with no normalization needed.');
  }

  const usefulReasons: string[] = [];
  const knownHits = totalKnownHits(group.members);
  const ratePerHour = totalRequestsPerHour(group.members);
  // A member is only genuinely unmeasured when neither an absolute count nor a
  // rate is available. In API mode `hits` is always null, so testing it alone
  // reported "no traffic data" for endpoints whose rate was known.
  const withoutTraffic = group.members.filter(
    (m) => (m.hits === null || m.hits === undefined) && requestsPerHour(m) === null,
  ).length;
  usefulReasons.push(`Consolidates ${group.members.length} discovered endpoint(s).`);
  if (knownHits > 0) {
    usefulReasons.push(`Total observed hits: ${knownHits.toLocaleString()}.`);
  }
  if (ratePerHour !== null) {
    usefulReasons.push(`Observed traffic: ${formatRate(ratePerHour)}.`);
  }
  if (withoutTraffic > 0) {
    usefulReasons.push(`${withoutTraffic} member(s) have no traffic data available.`);
  }
  if (group.members.some((m) => m.inSchema)) {
    usefulReasons.push('Covered by an uploaded API schema.');
  }
  if (group.methodsOnPath.length > 1) {
    usefulReasons.push(`Path serves ${group.methodsOnPath.length} methods: ${group.methodsOnPath.join(', ')}.`);
  }
  const labels = [...new Set(group.members.flatMap((m) => m.labels ?? []))].sort();
  if (labels.length > 0) {
    usefulReasons.push(`Cloudflare labels applied: ${labels.join(', ')}.`);
  }

  const riskReasons: string[] = [];
  if (group.flags.includes('host-consolidation')) {
    riskReasons.push('Host consolidation may mask materially different applications.');
  }
  if (group.flags.includes('path-variable')) {
    riskReasons.push('Path variables could over-generalize and miss semantic differences.');
  }
  if (group.flags.includes('low-traffic')) {
    riskReasons.push('Low traffic means limited confidence in the shape.');
  }
  if (group.flags.includes('no-traffic-data')) {
    riskReasons.push('No traffic data is available for these members.');
  }
  if (group.flags.includes('no-feature-data')) {
    riskReasons.push('No API Shield feature data (auth tokens, thresholds) was available to corroborate the score.');
  }
  if (group.flags.includes('stale-observation')) {
    riskReasons.push('Observations are stale; the endpoint may no longer be in use.');
  }
  if (group.flags.includes('borderline-score')) {
    riskReasons.push('Score sits between the save and ignore thresholds.');
  }
  if (riskReasons.length === 0) {
    riskReasons.push('Low risk — pattern is exact and well-supported by evidence.');
  }

  const followUpMap = {
    save: 'Export the save payload and apply it via the API Shield bulk endpoint or dashboard. Monitor analytics for drift.',
    ignore: 'Export the ignore payload and apply it. Re-run discovery periodically to catch false negatives.',
    manual_review: 'Run `api-shield-optimizer review` to decide interactively, or inspect representative members in the dashboard.',
  };

  return {
    proposalId: `prop-${group.groupId}`,
    groupId: group.groupId,
    action: group.recommendedAction,
    target: {
      canonicalPattern,
      membersCount: group.members.length,
      representativeMembers: representative,
    },
    before: {
      rawEndpoints: embedded,
      membersOmitted: Math.max(0, group.members.length - embedded.length),
    },
    after: {
      normalizedHostPattern: group.normalizedHostPattern,
      normalizedPathPattern: group.normalizedPathPattern,
      method: group.method,
    },
    reason: group.reasoning[0] ?? 'no signals fired',
    evidence: group.reasoning,
    score: group.score,
    signals: group.signals,
    flags: group.flags,
    risk: riskReasons.join(' '),
    requiresHumanReview: group.recommendedAction === 'manual_review',
    suggestedFollowUp: followUpMap[group.recommendedAction],
    whyThisGroupingIsSafe: safeReasons.join(' '),
    whyThisGroupingIsUseful: usefulReasons.join(' '),
    whyItMayBeWrong: riskReasons.join(' '),
    confidenceScore: group.confidence,
    operatorNotes: `Group ${group.groupId}: ${group.members.length} member(s), ${group.method} ${canonicalPattern}`,
  };
}

export function generateBundle(groups: NormalizedGroup[], context?: Partial<BundleContext>): ProposalBundle {
  const maxEmbeddedMembers = context?.maxEmbeddedMembers ?? MAX_EMBEDDED_MEMBERS;
  const proposals = groups.map((group) => generateProposal(group, maxEmbeddedMembers));

  const endpointCount = groups.reduce((s, g) => s + g.members.length, 0);
  const totalHits = groups.reduce((s, g) => s + totalKnownHits(g.members), 0);
  const rates = groups.flatMap((g) => g.members.map(requestsPerHour)).filter((r): r is number => r !== null);
  const totalRequestsPerHour = rates.length > 0 ? rates.reduce((a, b) => a + b, 0) : null;

  const endpointsWithoutTrafficData = groups.reduce(
    (s, g) =>
      s +
      g.members.filter(
        (m) => (m.hits === null || m.hits === undefined) && requestsPerHour(m) === null,
      ).length,
    0,
  );

  const analyzedGroupCount = context?.analyzedGroupCount ?? groups.length;
  const analyzedEndpointCount = context?.analyzedEndpointCount ?? endpointCount;

  return {
    generatedAt: new Date().toISOString(),
    rulesetVersion: context?.rulesetVersion ?? DEFAULT_SCORING_CONFIG.rulesetVersion,
    scope: {
      accountId: context?.accountId,
      zoneId: context?.zoneId,
      endpointCount,
      groupCount: groups.length,
      analyzedEndpointCount,
      analyzedGroupCount,
      truncated: analyzedGroupCount > groups.length,
    },
    proposals,
    summary: {
      saveCount: proposals.filter((p) => p.action === 'save').length,
      ignoreCount: proposals.filter((p) => p.action === 'ignore').length,
      manualReviewCount: proposals.filter((p) => p.action === 'manual_review').length,
      totalHits,
      totalRequestsPerHour,
      endpointsWithoutTrafficData,
    },
    alreadyDecided: context?.alreadyDecided ?? { saved: 0, ignored: 0, conflicting: [] },
    budget:
      context?.budget ??
      {
        alreadySaved: 0,
        proposedSaves: proposals.filter((p) => p.action === 'save').length,
        overBudget: false,
        notes: [],
      },
  };
}

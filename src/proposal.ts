import type { NormalizedGroup, Proposal } from './types.js';

export function generateProposal(group: NormalizedGroup): Proposal {
  const canonicalPattern = `${group.normalizedHostPattern}${group.normalizedPathPattern}`;
  const representative = group.members.slice(0, 5);

  const safeReasons: string[] = [];
  if (group.normalizedPathPattern.includes('{var')) {
    safeReasons.push('Variable segments normalized using ID/UUID/date/tenant heuristics.');
  }
  if (group.normalizedHostPattern.includes('{hostVar')) {
    safeReasons.push('Hostname variable covers complete label across observed subdomains.');
  }
  if (group.members.every((m) => m.method === group.method)) {
    safeReasons.push('All members share the same HTTP method.');
  }
  if (safeReasons.length === 0) {
    safeReasons.push('Exact path match with no normalization needed.');
  }

  const usefulReasons: string[] = [];
  const totalHits = group.members.reduce((s, m) => s + m.hits, 0);
  usefulReasons.push(`Consolidates ${group.members.length} discovered endpoints.`);
  usefulReasons.push(`Total observed hits: ${totalHits.toLocaleString()}.`);
  if (group.members.some((m) => m.labels && m.labels.length > 0)) {
    usefulReasons.push('Existing labels provide additional signal.');
  }

  const riskReasons: string[] = [];
  if (group.flags.includes('host-consolidation')) {
    riskReasons.push('Host consolidation may mask materially different applications.');
  }
  if (group.flags.includes('path-variable')) {
    riskReasons.push('Path variables could over-generalize and miss semantic differences.');
  }
  if (group.flags.includes('method-ambiguity')) {
    riskReasons.push('Mixed HTTP methods may indicate different operations under same path.');
  }
  if (group.flags.includes('low-confidence')) {
    riskReasons.push('Low traffic means limited confidence in the shape.');
  }
  if (riskReasons.length === 0) {
    riskReasons.push('Low risk — pattern is exact and well-supported by traffic.');
  }

  const followUpMap = {
    save: 'Bulk-save this group via API or dashboard. Monitor analytics for drift.',
    ignore: 'Bulk-ignore this group. Re-run discovery periodically to ensure no false negatives.',
    manual_review: 'Review representative members in dashboard. Decide per-group or per-endpoint.',
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
      rawEndpoints: group.members,
    },
    after: {
      normalizedHostPattern: group.normalizedHostPattern,
      normalizedPathPattern: group.normalizedPathPattern,
      method: group.method,
    },
    reason: group.reasoning.join('; '),
    evidence: group.reasoning,
    risk: riskReasons.join(' '),
    requiresHumanReview: group.recommendedAction === 'manual_review',
    suggestedFollowUp: followUpMap[group.recommendedAction],
    whyThisGroupingIsSafe: safeReasons.join(' '),
    whyThisGroupingIsUseful: usefulReasons.join(' '),
    whyItMayBeWrong: riskReasons.join(' '),
    confidenceScore: group.confidence,
    operatorNotes: `Group ${group.groupId}: ${group.members.length} members, ${group.method} ${canonicalPattern}`,
  };
}

export function generateBundle(groups: NormalizedGroup[]): import('./types.js').ProposalBundle {
  const proposals = groups.map(generateProposal);
  return {
    generatedAt: new Date().toISOString(),
    scope: {
      endpointCount: groups.reduce((s, g) => s + g.members.length, 0),
      groupCount: groups.length,
    },
    proposals,
    summary: {
      saveCount: proposals.filter((p) => p.action === 'save').length,
      ignoreCount: proposals.filter((p) => p.action === 'ignore').length,
      manualReviewCount: proposals.filter((p) => p.action === 'manual_review').length,
      totalHits: proposals.reduce((s, p) => s + p.before.rawEndpoints.reduce((ss, m) => ss + m.hits, 0), 0),
    },
  };
}

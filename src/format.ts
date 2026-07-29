import type { ProposalBundle, Proposal } from './types.js';

export function formatBundleAsText(bundle: ProposalBundle): string {
  const lines: string[] = [];

  lines.push('═'.repeat(60));
  lines.push('API Shield Optimizer — Proposal Report');
  lines.push('═'.repeat(60));
  lines.push(`Generated: ${bundle.generatedAt}`);
  lines.push(`Endpoints: ${bundle.scope.endpointCount}  |  Groups: ${bundle.scope.groupCount}`);
  lines.push('');

  lines.push('─'.repeat(60));
  lines.push('SUMMARY');
  lines.push('─'.repeat(60));
  lines.push(`  Save:           ${bundle.summary.saveCount}`);
  lines.push(`  Ignore:         ${bundle.summary.ignoreCount}`);
  lines.push(`  Manual Review:  ${bundle.summary.manualReviewCount}`);
  lines.push(`  Total Hits:     ${bundle.summary.totalHits}`);
  lines.push('');

  if (bundle.proposals.length === 0) {
    lines.push('No proposals generated.');
    return lines.join('\n');
  }

  for (let i = 0; i < bundle.proposals.length; i++) {
    const p = bundle.proposals[i];
    lines.push('━'.repeat(60));
    lines.push(`PROPOSAL ${i + 1} of ${bundle.proposals.length}`);
    lines.push('━'.repeat(60));
    lines.push(formatProposal(p));
    lines.push('');
  }

  return lines.join('\n');
}

function formatProposal(p: Proposal): string {
  const lines: string[] = [];

  lines.push(`Action:       ${p.action.toUpperCase()}`);
  lines.push(`Pattern:      ${p.target.canonicalPattern}`);
  lines.push(`Members:      ${p.target.membersCount}`);
  lines.push('');

  if (p.before.rawEndpoints.length > 0) {
    lines.push('Included endpoints:');
    for (const ep of p.before.rawEndpoints) {
      lines.push(`  ${ep.method} ${ep.host}${ep.path}`);
    }
    lines.push('');
  }

  lines.push(`Confidence:   ${(p.confidenceScore * 100).toFixed(0)}%`);
  lines.push(`Needs Review: ${p.requiresHumanReview ? 'YES' : 'no'}`);
  lines.push('');

  lines.push('Reason:');
  lines.push(`  ${p.reason}`);
  lines.push('');

  if (p.evidence.length > 0) {
    lines.push('Evidence:');
    for (const e of p.evidence) {
      lines.push(`  • ${e}`);
    }
    lines.push('');
  }

  lines.push('Risk:');
  lines.push(`  ${p.risk}`);
  lines.push('');

  lines.push('Why this grouping is safe:');
  lines.push(`  ${p.whyThisGroupingIsSafe}`);
  lines.push('');

  lines.push('Why this grouping is useful:');
  lines.push(`  ${p.whyThisGroupingIsUseful}`);
  lines.push('');

  lines.push('Why it may be wrong:');
  lines.push(`  ${p.whyItMayBeWrong}`);
  lines.push('');

  lines.push('Suggested follow-up:');
  lines.push(`  ${p.suggestedFollowUp}`);

  return lines.join('\n');
}

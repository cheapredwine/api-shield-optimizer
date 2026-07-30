import type { Endpoint, ProposalBundle, Proposal } from './types.js';
import { formatRate, requestsPerHour } from './classify.js';

/**
 * Traffic for one listed member. `hits` is always null in API mode, so a member
 * with a known rate must not be printed as unmeasured.
 */
function memberTraffic(endpoint: Endpoint): string {
  if (endpoint.hits !== null && endpoint.hits !== undefined) return `${endpoint.hits.toLocaleString()} hits`;
  const rate = requestsPerHour(endpoint);
  return rate === null ? 'no traffic data' : formatRate(rate);
}

/** Endpoints listed per proposal in the text report. */
const MAX_LISTED_MEMBERS = 5;

export interface FormatOptions {
  /** Include the full signal breakdown for each proposal. */
  verbose?: boolean;
  maxListedMembers?: number;
}

export function formatBundleAsText(bundle: ProposalBundle, options: FormatOptions = {}): string {
  const lines: string[] = [];
  const maxMembers = options.maxListedMembers ?? MAX_LISTED_MEMBERS;

  lines.push('═'.repeat(72));
  lines.push('API Shield Optimizer — Proposal Report');
  lines.push('═'.repeat(72));
  lines.push(`Generated:  ${bundle.generatedAt}`);
  lines.push(`Ruleset:    ${bundle.rulesetVersion}`);
  if (bundle.scope.zoneId) lines.push(`Zone:       ${bundle.scope.zoneId}`);
  if (bundle.scope.accountId) lines.push(`Account:    ${bundle.scope.accountId}`);
  lines.push(`Reported:   ${bundle.scope.groupCount} group(s) / ${bundle.scope.endpointCount} endpoint(s)`);
  if (bundle.scope.truncated) {
    lines.push(
      `Analyzed:   ${bundle.scope.analyzedGroupCount} group(s) / ${bundle.scope.analyzedEndpointCount} endpoint(s) ` +
        '(output truncated by --max-groups; summary counts describe the reported subset)',
    );
  }
  lines.push('');

  lines.push('─'.repeat(72));
  lines.push('SUMMARY');
  lines.push('─'.repeat(72));
  lines.push(`  Save:                 ${bundle.summary.saveCount}`);
  lines.push(`  Ignore:               ${bundle.summary.ignoreCount}`);
  lines.push(`  Manual Review:        ${bundle.summary.manualReviewCount}`);
  if (bundle.summary.totalHits > 0) {
    lines.push(`  Total Hits:           ${bundle.summary.totalHits.toLocaleString()}`);
  }
  if (bundle.summary.totalRequestsPerHour !== null && bundle.summary.totalRequestsPerHour !== undefined) {
    lines.push(`  Observed rate:        ${formatRate(bundle.summary.totalRequestsPerHour)}`);
  }
  if (bundle.summary.endpointsWithoutTrafficData > 0) {
    lines.push(`  No traffic data:      ${bundle.summary.endpointsWithoutTrafficData} endpoint(s)`);
  }
  lines.push('');

  lines.push('─'.repeat(72));
  lines.push('EXISTING STATE');
  lines.push('─'.repeat(72));
  lines.push(`  Already saved:        ${bundle.alreadyDecided.saved}`);
  lines.push(`  Already ignored:      ${bundle.alreadyDecided.ignored}`);
  if (bundle.alreadyDecided.conflicting.length > 0) {
    lines.push(`  Conflicting groups:   ${bundle.alreadyDecided.conflicting.join(', ')}`);
  }
  lines.push('');

  lines.push('─'.repeat(72));
  lines.push('OPERATION BUDGET');
  lines.push('─'.repeat(72));
  lines.push(`  Limit:                ${bundle.budget.limit ?? 'not configured'}`);
  lines.push(`  Already saved:        ${bundle.budget.alreadySaved}`);
  lines.push(`  Proposed saves:       ${bundle.budget.proposedSaves}`);
  if (bundle.budget.remaining !== undefined) {
    lines.push(`  Remaining:            ${bundle.budget.remaining}`);
  }
  for (const note of bundle.budget.notes) {
    lines.push(`  • ${note}`);
  }
  lines.push('');

  if (bundle.proposals.length === 0) {
    lines.push('No proposals generated.');
    return lines.join('\n');
  }

  for (let i = 0; i < bundle.proposals.length; i++) {
    const p = bundle.proposals[i];
    lines.push('━'.repeat(72));
    lines.push(`PROPOSAL ${i + 1} of ${bundle.proposals.length}`);
    lines.push('━'.repeat(72));
    lines.push(formatProposal(p, { verbose: options.verbose ?? false, maxMembers }));
    lines.push('');
  }

  return lines.join('\n');
}

function formatProposal(p: Proposal, opts: { verbose: boolean; maxMembers: number }): string {
  const lines: string[] = [];

  lines.push(`Action:       ${p.action.toUpperCase()}`);
  lines.push(`Pattern:      ${p.after.method} ${p.target.canonicalPattern}`);
  lines.push(`Members:      ${p.target.membersCount}`);
  lines.push('');

  lines.push('Scores:');
  lines.push(`  API:          ${p.score.api.toFixed(2)}`);
  lines.push(`  Sensitivity:  ${p.score.sensitivity.toFixed(2)}`);
  lines.push(`  Combined:     ${p.score.combined.toFixed(2)}`);
  lines.push(`  Confidence:   ${p.confidenceScore.toFixed(2)} (evidence strength)`);
  lines.push(`  Needs review: ${p.requiresHumanReview ? 'YES' : 'no'}`);
  lines.push('');

  // Bounded member listing. Groups can hold thousands of endpoints; printing
  // all of them made the report unusable.
  const listed = p.before.rawEndpoints.slice(0, opts.maxMembers);
  if (listed.length > 0) {
    lines.push('Sample endpoints:');
    for (const ep of listed) {
      lines.push(`  ${ep.method} ${ep.host}${ep.path}  (${memberTraffic(ep)})`);
    }
    const hidden = p.target.membersCount - listed.length;
    if (hidden > 0) {
      lines.push(`  ... and ${hidden} more member(s)`);
    }
    lines.push('');
  }

  lines.push('Reason:');
  lines.push(`  ${p.reason}`);
  lines.push('');

  const signals = opts.verbose ? p.signals : p.signals.slice(0, 6);
  if (signals.length > 0) {
    lines.push('Signals:');
    for (const s of signals) {
      const sign = s.weight >= 0 ? '+' : '';
      lines.push(`  ${sign}${s.weight.toFixed(2)}  [${s.axis}] ${s.detail}`);
    }
    if (!opts.verbose && p.signals.length > signals.length) {
      lines.push(`  ... and ${p.signals.length - signals.length} more (use --verbose)`);
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

  lines.push('Suggested follow-up:');
  lines.push(`  ${p.suggestedFollowUp}`);

  return lines.join('\n');
}

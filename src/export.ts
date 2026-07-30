import type { Action, DecisionFile, OperatorDecision, Proposal, ProposalBundle } from './types.js';

/**
 * Generates ready-to-apply Cloudflare API payloads.
 *
 * This module is deliberately write-free: it never performs a network request.
 * It produces the exact request bodies an operator can review, diff, and then
 * submit themselves. Applying changes stays a human action.
 */

export interface OperationIdentity {
  host: string;
  method: string;
  endpoint: string;
}

export interface RequestPreview {
  description: string;
  method: 'POST' | 'PATCH' | 'PUT';
  url: string;
  headers: Record<string, string>;
  body: unknown;
  /** Shell snippet the operator can inspect and run manually. */
  curl: string;
}

export interface ApplyPayload {
  generatedAt: string;
  rulesetVersion: string;
  zoneId: string;
  warning: string;
  counts: {
    save: number;
    ignore: number;
    skipped: number;
  };
  /** Operations to promote into managed API Shield operations. */
  saveOperations: OperationIdentity[];
  /** Discovery operation IDs to mark ignored, keyed by operation ID. */
  ignoreOperationStates: Record<string, { state: 'ignored' }>;
  /** Groups that could not be exported, with the reason. */
  skipped: { groupId: string; canonicalPattern: string; reason: string }[];
  requests: RequestPreview[];
}

const WARNING =
  'Generated payload only. This tool never writes to the Cloudflare API. ' +
  'Review every entry, then apply it yourself via the dashboard or your own change process.';

const ZONE_PLACEHOLDER = '{zoneId}';

function apiBase(zoneId: string): string {
  return `https://api.cloudflare.com/client/v4/zones/${zoneId}/api_gateway`;
}

/**
 * Converts a normalized pattern back into the concrete host and endpoint the
 * API expects. API Shield uses `{varN}` placeholders in operation endpoints,
 * so path variables pass through unchanged. Hostname variables cannot be
 * expressed in a single operation, so those groups are enumerated per host.
 */
function identitiesForProposal(proposal: Proposal): { identities: OperationIdentity[]; reason?: string } {
  const { normalizedHostPattern, normalizedPathPattern, method } = proposal.after;

  if (!normalizedHostPattern.includes('{hostVar')) {
    return { identities: [{ host: normalizedHostPattern, method, endpoint: normalizedPathPattern }] };
  }

  // API Shield operations require a concrete host. Expand the consolidated
  // group back into one operation per observed host.
  const hosts = [...new Set(proposal.before.rawEndpoints.map((ep) => ep.host))].filter(Boolean);

  if (hosts.length === 0) {
    return {
      identities: [],
      reason: 'hostname variable could not be expanded: no concrete hosts available in the embedded sample',
    };
  }

  if (proposal.before.membersOmitted > 0) {
    return {
      identities: hosts.map((host) => ({ host, method, endpoint: normalizedPathPattern })),
      reason:
        `hostname variable expanded from a sample of ${hosts.length} host(s); ` +
        `${proposal.before.membersOmitted} member(s) were omitted from the bundle, so the list may be incomplete`,
    };
  }

  return { identities: hosts.map((host) => ({ host, method, endpoint: normalizedPathPattern })) };
}

export interface BuildApplyPayloadOptions {
  /** Restrict export to these actions. Defaults to save and ignore. */
  actions?: Action[];
  /** Override recommendations with recorded operator decisions. */
  decisions?: DecisionFile;
  /** Only export proposals at or above this confidence. */
  minConfidence?: number;
}

function effectiveAction(proposal: Proposal, decisions?: DecisionFile): Action {
  if (!decisions) return proposal.action;
  const match = decisions.decisions.find((d) => d.groupId === proposal.groupId);
  return match ? match.decision : proposal.action;
}

export function buildApplyPayload(bundle: ProposalBundle, options: BuildApplyPayloadOptions = {}): ApplyPayload {
  const actions = options.actions ?? ['save', 'ignore'];
  // An empty string is as useless as an absent one and would silently produce
  // `zones//api_gateway`, so fall back to the visible placeholder.
  const zoneId = bundle.scope.zoneId && bundle.scope.zoneId.length > 0 ? bundle.scope.zoneId : ZONE_PLACEHOLDER;

  const saveOperations: OperationIdentity[] = [];
  const ignoreOperationStates: Record<string, { state: 'ignored' }> = {};
  const skipped: ApplyPayload['skipped'] = [];
  const seenSave = new Set<string>();

  for (const proposal of bundle.proposals) {
    const action = effectiveAction(proposal, options.decisions);

    if (!actions.includes(action)) continue;

    if (options.minConfidence !== undefined && proposal.confidenceScore < options.minConfidence) {
      skipped.push({
        groupId: proposal.groupId,
        canonicalPattern: proposal.target.canonicalPattern,
        reason: `confidence ${proposal.confidenceScore.toFixed(2)} below --min-confidence ${options.minConfidence}`,
      });
      continue;
    }

    if (action === 'save') {
      const { identities, reason } = identitiesForProposal(proposal);
      if (identities.length === 0) {
        skipped.push({
          groupId: proposal.groupId,
          canonicalPattern: proposal.target.canonicalPattern,
          reason: reason ?? 'no concrete operation could be derived',
        });
        continue;
      }
      if (reason) {
        skipped.push({ groupId: proposal.groupId, canonicalPattern: proposal.target.canonicalPattern, reason });
      }
      for (const identity of identities) {
        const key = `${identity.method} ${identity.host}${identity.endpoint}`;
        if (seenSave.has(key)) continue;
        seenSave.add(key);
        saveOperations.push(identity);
      }
      continue;
    }

    if (action === 'ignore') {
      // Ignoring works on discovery operation IDs, not on patterns, so only
      // members that came from discovery can be marked.
      const ids = proposal.before.rawEndpoints
        .map((ep) => ep.id)
        .filter((id) => id && !id.startsWith('generated-') && !id.startsWith('managed-'));

      if (ids.length === 0) {
        skipped.push({
          groupId: proposal.groupId,
          canonicalPattern: proposal.target.canonicalPattern,
          reason: 'no discovery operation IDs available to mark as ignored',
        });
        continue;
      }

      if (proposal.before.membersOmitted > 0) {
        skipped.push({
          groupId: proposal.groupId,
          canonicalPattern: proposal.target.canonicalPattern,
          reason:
            `${proposal.before.membersOmitted} member(s) omitted from the bundle sample; ` +
            're-run with --max-embedded-members to export the full ignore set',
        });
      }

      for (const id of ids) {
        ignoreOperationStates[id] = { state: 'ignored' };
      }
    }
  }

  const requests: RequestPreview[] = [];
  const headers = {
    Authorization: 'Bearer $CF_API_TOKEN',
    'Content-Type': 'application/json',
  };

  if (saveOperations.length > 0) {
    const url = `${apiBase(zoneId)}/operations`;
    requests.push({
      description: `Create ${saveOperations.length} managed API Shield operation(s)`,
      method: 'POST',
      url,
      headers,
      body: saveOperations,
      curl: buildCurl('POST', url, saveOperations),
    });
  }

  const ignoreCount = Object.keys(ignoreOperationStates).length;
  if (ignoreCount > 0) {
    const url = `${apiBase(zoneId)}/discovery/operations`;
    requests.push({
      description: `Mark ${ignoreCount} discovery operation(s) as ignored`,
      method: 'PATCH',
      url,
      headers,
      body: ignoreOperationStates,
      curl: buildCurl('PATCH', url, ignoreOperationStates),
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    rulesetVersion: bundle.rulesetVersion,
    zoneId,
    warning: WARNING,
    counts: {
      save: saveOperations.length,
      ignore: ignoreCount,
      skipped: skipped.length,
    },
    saveOperations,
    ignoreOperationStates,
    skipped,
    requests,
  };
}

function buildCurl(method: string, url: string, body: unknown): string {
  const json = JSON.stringify(body);
  const escaped = json.replace(/'/g, `'\\''`);
  return [
    `curl -X ${method} '${url}'`,
    `  -H 'Authorization: Bearer $CF_API_TOKEN'`,
    `  -H 'Content-Type: application/json'`,
    `  --data '${escaped}'`,
  ].join(' \\\n');
}

function csvEscape(value: string | number): string {
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

/** Spreadsheet-friendly export for operator sign-off. */
export function bundleToCsv(bundle: ProposalBundle): string {
  const header = [
    'groupId',
    'action',
    'method',
    'canonicalPattern',
    'members',
    'apiScore',
    'sensitivityScore',
    'combinedScore',
    'confidence',
    // Scoring contributions and triage markers are separate columns: an
    // operator filters on `flags`, not on signal ids.
    'signals',
    'flags',
    'topReason',
  ];

  const rows = bundle.proposals.map((p) =>
    [
      p.groupId,
      p.action,
      p.after.method,
      p.target.canonicalPattern,
      p.target.membersCount,
      p.score.api.toFixed(3),
      p.score.sensitivity.toFixed(3),
      p.score.combined.toFixed(3),
      p.confidenceScore.toFixed(3),
      p.signals.map((s) => s.id).join(' '),
      p.flags.join(' '),
      p.reason,
    ]
      .map(csvEscape)
      .join(','),
  );

  return [header.join(','), ...rows].join('\n') + '\n';
}

/** Builds a decision file from a set of operator choices. */
export function buildDecisionFile(
  bundle: ProposalBundle,
  decisions: OperatorDecision[],
): DecisionFile {
  return {
    zoneId: bundle.scope.zoneId,
    rulesetVersion: bundle.rulesetVersion,
    decidedAt: new Date().toISOString(),
    decisions,
  };
}

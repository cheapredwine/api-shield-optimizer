import { createInterface } from 'node:readline';
import type { Action, DecisionFile, OperatorDecision, Proposal, ProposalBundle } from './types.js';
import { buildDecisionFile } from './export.js';
import { LineReader } from './prompt.js';

/**
 * Interactive review mode.
 *
 * Walks the operator through proposals one at a time and records their
 * decisions. Nothing is ever written to the Cloudflare API; the output is a
 * decision file that feeds the payload exporter.
 */

export interface ReviewOptions {
  /** Restrict the queue to these recommended actions. */
  only?: Action[];
  /** Skip proposals below this confidence. */
  minConfidence?: number;
  /** Start from a previously saved decision file. */
  existing?: DecisionFile;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export interface ReviewResult {
  decisionFile: DecisionFile;
  reviewed: number;
  quitEarly: boolean;
}

const ACTION_LABEL: Record<Action, string> = {
  save: 'SAVE',
  ignore: 'IGNORE',
  manual_review: 'MANUAL REVIEW',
};

const HELP = `
Commands:
  s / save      record SAVE for this group
  i / ignore    record IGNORE for this group
  a / accept    accept the recommendation as-is
  d / defer     leave undecided (no entry written)
  n / note      attach a note, then decide
  e / expand    show all signals and members
  b / back      revisit the previous proposal
  q / quit      stop reviewing and write what has been decided
  ?             show this help
`.trimEnd();

function bar(width: number, value: number): string {
  const filled = Math.round(Math.max(0, Math.min(1, value)) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function renderProposal(p: Proposal, index: number, total: number, expanded: boolean): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('─'.repeat(72));
  lines.push(`[${index + 1}/${total}]  ${p.after.method} ${p.target.canonicalPattern}`);
  lines.push('─'.repeat(72));
  lines.push(`Recommendation : ${ACTION_LABEL[p.action]}`);
  lines.push(`Members        : ${p.target.membersCount}`);
  lines.push(
    `API score      : ${bar(20, p.score.api)} ${p.score.api.toFixed(2)}`,
  );
  lines.push(
    `Sensitivity    : ${bar(20, p.score.sensitivity)} ${p.score.sensitivity.toFixed(2)}`,
  );
  lines.push(
    `Combined       : ${bar(20, p.score.combined)} ${p.score.combined.toFixed(2)}`,
  );
  lines.push(
    `Confidence     : ${bar(20, p.confidenceScore)} ${p.confidenceScore.toFixed(2)}`,
  );
  lines.push('');
  lines.push(`Why           : ${p.reason}`);

  const topSignals = expanded ? p.signals : p.signals.slice(0, 5);
  if (topSignals.length > 0) {
    lines.push('');
    lines.push('Signals:');
    for (const s of topSignals) {
      const sign = s.weight >= 0 ? '+' : '';
      lines.push(`  ${sign}${s.weight.toFixed(2)}  [${s.axis}] ${s.detail}`);
    }
    if (!expanded && p.signals.length > topSignals.length) {
      lines.push(`  ... ${p.signals.length - topSignals.length} more (press 'e' to expand)`);
    }
  }

  const members = expanded ? p.before.rawEndpoints : p.before.rawEndpoints.slice(0, 3);
  if (members.length > 0) {
    lines.push('');
    lines.push('Sample members:');
    for (const ep of members) {
      const hits = ep.hits === null || ep.hits === undefined ? 'no traffic data' : `${ep.hits.toLocaleString()} hits`;
      lines.push(`  ${ep.method} ${ep.host}${ep.path}  (${hits})`);
    }
    const hidden = p.target.membersCount - members.length;
    if (hidden > 0) {
      lines.push(`  ... ${hidden} more member(s)${expanded ? '' : " (press 'e' to expand)"}`);
    }
  }

  lines.push('');
  lines.push(`Risk          : ${p.whyItMayBeWrong}`);
  lines.push('');

  return lines.join('\n');
}

function filterProposals(bundle: ProposalBundle, options: ReviewOptions): Proposal[] {
  return bundle.proposals.filter((p) => {
    if (options.only && options.only.length > 0 && !options.only.includes(p.action)) return false;
    if (options.minConfidence !== undefined && p.confidenceScore < options.minConfidence) return false;
    return true;
  });
}

export async function runInteractiveReview(
  bundle: ProposalBundle,
  options: ReviewOptions = {},
): Promise<ReviewResult> {
  const queue = filterProposals(bundle, options);
  const output = options.output ?? process.stderr;
  const write = (text: string): void => {
    output.write(`${text}\n`);
  };

  const decisions = new Map<string, OperatorDecision>();
  for (const existing of options.existing?.decisions ?? []) {
    decisions.set(existing.groupId, existing);
  }

  if (queue.length === 0) {
    write('No proposals match the review filters.');
    return { decisionFile: buildDecisionFile(bundle, [...decisions.values()]), reviewed: 0, quitEarly: false };
  }

  const rl = createInterface({
    input: options.input ?? process.stdin,
    output,
    terminal: false,
  });
  const reader = new LineReader(rl, output);

  write('');
  write(`Reviewing ${queue.length} proposal(s). Type ? for help. Nothing is sent to Cloudflare.`);

  let index = 0;
  let reviewed = 0;
  let quitEarly = false;
  let expanded = false;
  let pendingNote: string | undefined;

  try {
    while (index < queue.length) {
      const proposal = queue[index];
      write(renderProposal(proposal, index, queue.length, expanded));

      const existing = decisions.get(proposal.groupId);
      if (existing) {
        write(`Previously decided: ${ACTION_LABEL[existing.decision]}${existing.note ? ` — ${existing.note}` : ''}`);
      }

      const raw = await reader.ask('Decision [s/i/a/d/n/e/b/q/?]: ');

      // End of input. Stop and persist rather than hanging forever.
      if (raw === null) {
        write('');
        write('Input ended before every proposal was reviewed.');
        quitEarly = true;
        break;
      }

      const answer = raw.toLowerCase();

      const record = (decision: Action): void => {
        decisions.set(proposal.groupId, {
          groupId: proposal.groupId,
          canonicalPattern: proposal.target.canonicalPattern,
          method: proposal.after.method,
          decision,
          recommendedAction: proposal.action,
          decidedAt: new Date().toISOString(),
          note: pendingNote,
        });
        pendingNote = undefined;
        reviewed += 1;
        expanded = false;
        index += 1;
      };

      switch (answer) {
        case 's':
        case 'save':
          record('save');
          break;

        case 'i':
        case 'ignore':
          record('ignore');
          break;

        case 'a':
        case 'accept':
        case '':
          if (proposal.action === 'manual_review') {
            write('Recommendation is MANUAL REVIEW; choose save (s) or ignore (i) explicitly, or defer (d).');
          } else {
            record(proposal.action);
          }
          break;

        case 'd':
        case 'defer':
          decisions.delete(proposal.groupId);
          pendingNote = undefined;
          expanded = false;
          index += 1;
          break;

        case 'n':
        case 'note':
          pendingNote = (await reader.ask('Note: '))?.trim() || undefined;
          break;

        case 'e':
        case 'expand':
          expanded = true;
          break;

        case 'b':
        case 'back':
          expanded = false;
          pendingNote = undefined;
          index = Math.max(0, index - 1);
          break;

        case 'q':
        case 'quit':
          quitEarly = true;
          index = queue.length;
          break;

        case '?':
        case 'h':
        case 'help':
          write(HELP);
          break;

        default:
          write(`Unrecognised command '${answer}'. Type ? for help.`);
      }
    }
  } finally {
    rl.close();
  }

  const decisionList = [...decisions.values()];
  const saveCount = decisionList.filter((d) => d.decision === 'save').length;
  const ignoreCount = decisionList.filter((d) => d.decision === 'ignore').length;
  const overrides = decisionList.filter((d) => d.decision !== d.recommendedAction).length;

  write('');
  write('─'.repeat(72));
  write(`Reviewed ${reviewed} of ${queue.length}. Save: ${saveCount}  Ignore: ${ignoreCount}  Overrides: ${overrides}`);
  if (quitEarly) write('Stopped early; decisions made so far have been kept.');
  write('─'.repeat(72));

  return {
    decisionFile: buildDecisionFile(bundle, decisionList),
    reviewed,
    quitEarly,
  };
}

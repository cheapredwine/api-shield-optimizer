import { describe, expect, it } from 'vitest';
import { Readable, Writable } from 'node:stream';
import { runInteractiveReview } from '../review.js';
import { generateBundle } from '../proposal.js';
import { classifyGroup } from '../classify.js';
import { getDefaultCompiledConfig } from '../scoring-config.js';
import type { Endpoint, NormalizedGroup, ProposalBundle } from '../types.js';

function makeEp(overrides: Partial<Endpoint> = {}): Endpoint {
  return {
    id: 'e1',
    accountId: '',
    zoneId: '',
    host: 'api.example.com',
    method: 'GET',
    path: '/api/v1/things',
    source: 'machinelearning',
    hits: 1000,
    lastSeenAt: new Date().toISOString(),
    rawReference: {},
    ...overrides,
  };
}

function makeGroup(id: string, path: string, method = 'GET'): NormalizedGroup {
  const member = makeEp({ id: `${id}-m`, path, method });
  const group: NormalizedGroup = {
    groupId: id,
    normalizedHostPattern: 'api.example.com',
    normalizedPathPattern: path,
    method,
    members: [member],
    methodsOnPath: [method],
    recommendedAction: 'manual_review',
    confidence: 0,
    score: { api: 0, sensitivity: 0, combined: 0 },
    signals: [],
    reasoning: [],
    flags: [],
  };
  const classification = classifyGroup(group, getDefaultCompiledConfig());
  return { ...group, ...classification, recommendedAction: classification.action };
}

function bundleOf(count: number): ProposalBundle {
  const groups = Array.from({ length: count }, (_, i) => makeGroup(`g${i}`, `/api/v1/resource${i}`));
  return generateBundle(groups);
}

/** Collects everything the reviewer prints. */
function sink(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  return { stream, text: () => chunks.join('') };
}

function inputOf(lines: string[]): Readable {
  return Readable.from(lines.map((l) => `${l}\n`));
}

describe('runInteractiveReview', () => {
  it('records a decision for every answered proposal', async () => {
    const bundle = bundleOf(3);
    const out = sink();

    const result = await runInteractiveReview(bundle, {
      input: inputOf(['s', 'i', 's']),
      output: out.stream,
    });

    expect(result.reviewed).toBe(3);
    expect(result.decisionFile.decisions).toHaveLength(3);
    expect(result.decisionFile.decisions.map((d) => d.decision)).toEqual(['save', 'ignore', 'save']);
  });

  // Regression: piped input previously lost every decision. readline emitted
  // buffered lines with no listener attached and the pending promise never
  // settled, so the reviewer exited having written nothing.
  it('keeps decisions made before an explicit quit', async () => {
    const bundle = bundleOf(6);
    const out = sink();

    const result = await runInteractiveReview(bundle, {
      input: inputOf(['s', 'i', 'q']),
      output: out.stream,
    });

    expect(result.quitEarly).toBe(true);
    expect(result.reviewed).toBe(2);
    expect(result.decisionFile.decisions).toHaveLength(2);
  });

  // Regression: end of input used to hang on an unresolved promise, and the
  // process exited 0 without persisting anything.
  it('stops and persists when input ends early', async () => {
    const bundle = bundleOf(5);
    const out = sink();

    const result = await runInteractiveReview(bundle, {
      input: inputOf(['s']),
      output: out.stream,
    });

    expect(result.quitEarly).toBe(true);
    expect(result.decisionFile.decisions).toHaveLength(1);
    expect(out.text()).toContain('Input ended');
  });

  it('records an override when the operator disagrees with the recommendation', async () => {
    const bundle = bundleOf(1);
    const recommended = bundle.proposals[0].action;
    const opposite = recommended === 'save' ? 'i' : 's';

    const result = await runInteractiveReview(bundle, {
      input: inputOf([opposite]),
      output: sink().stream,
    });

    const decision = result.decisionFile.decisions[0];
    expect(decision.recommendedAction).toBe(recommended);
    expect(decision.decision).not.toBe(recommended);
  });

  it('defers without recording a decision', async () => {
    const result = await runInteractiveReview(bundleOf(2), {
      input: inputOf(['d', 'd']),
      output: sink().stream,
    });

    expect(result.decisionFile.decisions).toHaveLength(0);
  });

  it('attaches a note to the following decision', async () => {
    const result = await runInteractiveReview(bundleOf(1), {
      input: inputOf(['n', 'internal admin API', 's']),
      output: sink().stream,
    });

    expect(result.decisionFile.decisions[0].note).toBe('internal admin API');
  });

  it('revisits the previous proposal with back', async () => {
    const bundle = bundleOf(2);
    const result = await runInteractiveReview(bundle, {
      input: inputOf(['s', 'b', 'i', 's']),
      output: sink().stream,
    });

    // The first proposal is decided twice; the later answer wins.
    const first = result.decisionFile.decisions.find((d) => d.groupId === bundle.proposals[0].groupId);
    expect(first?.decision).toBe('ignore');
  });

  it('rejects an unrecognised command without advancing', async () => {
    const out = sink();
    const result = await runInteractiveReview(bundleOf(1), {
      input: inputOf(['zzz', 's']),
      output: out.stream,
    });

    expect(out.text()).toContain("Unrecognised command 'zzz'");
    expect(result.decisionFile.decisions).toHaveLength(1);
  });

  it('shows help on request', async () => {
    const out = sink();
    await runInteractiveReview(bundleOf(1), { input: inputOf(['?', 's']), output: out.stream });
    expect(out.text()).toContain('Commands:');
  });

  it('resumes from an existing decision file', async () => {
    const bundle = bundleOf(2);
    const first = await runInteractiveReview(bundle, {
      input: inputOf(['s']),
      output: sink().stream,
    });

    const out = sink();
    const second = await runInteractiveReview(bundle, {
      input: inputOf(['i', 'i']),
      output: out.stream,
      existing: first.decisionFile,
    });

    expect(out.text()).toContain('Previously decided');
    expect(second.decisionFile.decisions).toHaveLength(2);
  });

  it('reports when no proposals match the filters', async () => {
    const out = sink();
    const result = await runInteractiveReview(bundleOf(2), {
      input: inputOf([]),
      output: out.stream,
      minConfidence: 1.1,
    });

    expect(result.reviewed).toBe(0);
    expect(out.text()).toContain('No proposals match');
  });
});

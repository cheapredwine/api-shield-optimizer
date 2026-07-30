import { describe, expect, it } from 'vitest';
import { createInterface } from 'node:readline';
import { PassThrough, Readable, Writable } from 'node:stream';
import { LineReader, askOnce } from '../prompt.js';

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

function readerOver(input: Readable, output: Writable): LineReader {
  return new LineReader(createInterface({ input, output, terminal: false }), output);
}

describe('askOnce', () => {
  it('returns the trimmed answer', async () => {
    const answer = await askOnce('Select zone number: ', {
      input: Readable.from(['  2  \n']),
      output: sink().stream,
    });
    expect(answer).toBe('2');
  });

  it('writes the prompt to the output stream', async () => {
    const out = sink();
    await askOnce('Select zone number: ', { input: Readable.from(['1\n']), output: out.stream });
    expect(out.text()).toContain('Select zone number: ');
  });

  // Regression: the previous readline callback never fired on a closed stream,
  // so the caller awaited a promise that never settled and the process exited
  // silently without doing its work.
  it('returns null at end of input instead of hanging', async () => {
    const answer = await askOnce('Select zone number: ', {
      input: Readable.from([]),
      output: sink().stream,
    });
    expect(answer).toBeNull();
  });

  it('returns null when the stream closes with no trailing newline', async () => {
    const answer = await askOnce('prompt: ', { input: Readable.from(['']), output: sink().stream });
    expect(answer).toBeNull();
  });

  it('treats a bare newline as an empty answer, not as EOF', async () => {
    const answer = await askOnce('prompt: ', { input: Readable.from(['\n']), output: sink().stream });
    expect(answer).toBe('');
  });
});

describe('LineReader', () => {
  it('reads sequential answers in order', async () => {
    const reader = readerOver(Readable.from(['a\n', 'b\n', 'c\n']), sink().stream);
    expect(await reader.ask('1: ')).toBe('a');
    expect(await reader.ask('2: ')).toBe('b');
    expect(await reader.ask('3: ')).toBe('c');
  });

  // Regression: with terminal:false readline emits buffered lines immediately.
  // Lines that arrived before the next ask() used to be dropped on the floor.
  it('does not drop lines that arrive before they are requested', async () => {
    const reader = readerOver(Readable.from(['first\n', 'second\n']), sink().stream);

    // Let readline flush both lines before asking for either.
    await new Promise((resolve) => setImmediate(resolve));

    expect(await reader.ask('1: ')).toBe('first');
    expect(await reader.ask('2: ')).toBe('second');
  });

  it('returns null for every ask after the stream closes', async () => {
    const reader = readerOver(Readable.from(['only\n']), sink().stream);
    expect(await reader.ask('1: ')).toBe('only');
    expect(await reader.ask('2: ')).toBeNull();
    expect(await reader.ask('3: ')).toBeNull();
  });

  it('resolves a pending ask when the stream closes later', async () => {
    const input = new PassThrough();
    const reader = readerOver(input, sink().stream);

    const pending = reader.ask('waiting: ');
    input.end();

    expect(await pending).toBeNull();
  });

  it('resolves a pending ask when a line arrives later', async () => {
    const input = new PassThrough();
    const reader = readerOver(input, sink().stream);

    const pending = reader.ask('waiting: ');
    input.write('late\n');

    expect(await pending).toBe('late');
  });

  it('echoes buffered answers so piped sessions remain readable', async () => {
    const out = sink();
    const reader = readerOver(Readable.from(['x\n', 'y\n']), out.stream);
    await new Promise((resolve) => setImmediate(resolve));

    await reader.ask('first: ');
    expect(out.text()).toContain('first: x');
  });
});

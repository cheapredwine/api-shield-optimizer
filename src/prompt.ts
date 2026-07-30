import { createInterface, type Interface } from 'node:readline';

/**
 * Buffered line reader for interactive prompts.
 *
 * `readline`'s own `question` callback is unusable for anything non-interactive.
 * With `terminal: false` readline emits every buffered line as soon as the
 * stream is readable, so lines arriving before the next `question` call are
 * dropped; and when the stream closes, a pending `question` never fires its
 * callback, leaving the caller awaiting a promise that will never settle. Both
 * failure modes are silent.
 *
 * This queues lines as they arrive and reports end-of-input explicitly as
 * `null`, so callers can fail loudly or persist partial work instead of hanging.
 */
export class LineReader {
  private readonly pending: string[] = [];
  private waiting: ((line: string | null) => void) | null = null;
  private closed = false;

  constructor(
    private readonly rl: Interface,
    private readonly output: NodeJS.WritableStream,
  ) {
    rl.on('line', (line) => {
      if (this.waiting) {
        const resolve = this.waiting;
        this.waiting = null;
        resolve(line);
        return;
      }
      this.pending.push(line);
    });

    rl.on('close', () => {
      this.closed = true;
      if (this.waiting) {
        const resolve = this.waiting;
        this.waiting = null;
        resolve(null);
      }
    });
  }

  /** Resolves with the trimmed line, or `null` at end of input. */
  async ask(question: string): Promise<string | null> {
    this.output.write(question);

    const queued = this.pending.shift();
    if (queued !== undefined) {
      this.output.write(`${queued}\n`);
      return queued.trim();
    }

    if (this.closed) return null;

    const line = await new Promise<string | null>((resolve) => {
      this.waiting = resolve;
    });

    return line === null ? null : line.trim();
  }
}

export interface PromptStreams {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

/**
 * Asks a single question and tears down the interface afterwards.
 * Returns `null` at end of input rather than hanging.
 */
export async function askOnce(question: string, streams: PromptStreams = {}): Promise<string | null> {
  const output = streams.output ?? process.stderr;
  const rl = createInterface({
    input: streams.input ?? process.stdin,
    output,
    terminal: false,
  });

  try {
    return await new LineReader(rl, output).ask(question);
  } finally {
    rl.close();
  }
}

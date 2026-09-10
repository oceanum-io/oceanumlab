import { readSse } from '../sse';
import { describeProgress } from '../progress';

/**
 * A stand-in for the browser's ReadableStream, because jsdom has none.
 *
 * `readSse` uses exactly three things from a body -- `getReader()`, then
 * `read()` and `releaseLock()` on the reader -- so this supplies those and
 * nothing else. Building it here rather than reaching for a polyfill also
 * gives the tests what they actually need: control of where one chunk ends and
 * the next begins, which is the thing the network decides and the parser has
 * to survive.
 */
function chunkedStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return {
    getReader: () => ({
      read: async (): Promise<{ done: boolean; value?: Uint8Array }> =>
        index < chunks.length
          ? { done: false, value: chunks[index++] }
          : { done: true, value: undefined },
      releaseLock: (): void => undefined
    })
  } as unknown as ReadableStream<Uint8Array>;
}

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return chunkedStream(chunks.map(chunk => encoder.encode(chunk)));
}

async function collect(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): Promise<Array<{ event: string; data: string }>> {
  const out: Array<{ event: string; data: string }> = [];
  for await (const event of readSse(stream, signal)) {
    out.push({ event: event.event, data: event.data });
  }
  return out;
}

describe('readSse', () => {
  it('reads one event per frame', async () => {
    const events = await collect(
      streamOf(
        'event: status\ndata: {"phase":"generating"}\n\n',
        'event: done\ndata: {"message":"hi"}\n\n'
      )
    );

    expect(events).toEqual([
      { event: 'status', data: '{"phase":"generating"}' },
      { event: 'done', data: '{"message":"hi"}' }
    ]);
  });

  it('reassembles a frame split across chunks', async () => {
    // The network splits wherever it likes; a frame is not a packet.
    const events = await collect(
      streamOf('event: sta', 'tus\ndata: {"pha', 'se":"generating"}\n\n')
    );

    expect(events).toEqual([
      { event: 'status', data: '{"phase":"generating"}' }
    ]);
  });

  it('reassembles a multi-byte character split across chunks', async () => {
    // A UTF-8 sequence has no obligation to arrive whole. Decoding each chunk
    // independently mangles it, and a dataset name with an accent is what
    // finds that in production rather than in a test.
    const payload = '{"tool":"café"}';
    const bytes = new TextEncoder().encode(
      `event: status\ndata: ${payload}\n\n`
    );
    const split = bytes.indexOf(0xc3); // the first byte of "é"

    const events = await collect(
      chunkedStream([bytes.slice(0, split + 1), bytes.slice(split + 1)])
    );

    expect(events).toEqual([{ event: 'status', data: payload }]);
  });

  it('ignores keepalive comments', async () => {
    // The backend sends these during a long wait. They carry nothing, and a
    // client that treated one as an event would show a blank status.
    const events = await collect(
      streamOf(': keepalive\n\n', 'event: done\ndata: {"message":"hi"}\n\n')
    );

    expect(events).toEqual([{ event: 'done', data: '{"message":"hi"}' }]);
  });

  it('drops a frame with no data rather than yielding an empty one', async () => {
    const events = await collect(
      streamOf('event: status\n\n', 'event: done\ndata: {}\n\n')
    );

    expect(events).toEqual([{ event: 'done', data: '{}' }]);
  });

  it('stops when the signal is aborted', async () => {
    // Stop must end the read, not merely stop the caller looking at it.
    const controller = new AbortController();
    controller.abort();

    const events = await collect(
      streamOf('event: done\ndata: {"message":"hi"}\n\n'),
      controller.signal
    );

    expect(events).toEqual([]);
  });
});

describe('describeProgress', () => {
  it('names the lookup the agent stopped to do', () => {
    expect(describeProgress({ phase: 'tool', tool: 'search_catalog' })).toBe(
      'Searching the catalogue…'
    );
  });

  it('falls back to Thinking when there is no progress yet', () => {
    // A backend that does not stream, or a proxy that buffered the stream
    // away, degrades to exactly what this said before.
    expect(describeProgress(null)).toBe('Thinking…');
  });

  it('does not leak the internal name of a tool it has not been taught', () => {
    expect(
      describeProgress({ phase: 'tool', tool: 'some_new_internal_tool' })
    ).toBe('Looking something up…');
  });

  it('reads a new phase as progress rather than as a blank', () => {
    expect(describeProgress({ phase: 'something_new' })).toBe('Working…');
  });
});

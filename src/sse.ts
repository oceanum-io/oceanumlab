/**
 * Reading a Server-Sent Events body (OCE-175).
 *
 * Small and local rather than a dependency: SSE is a line format, the backend
 * emits one `data:` line per event, and a library would bring a parser for the
 * multi-line and retry-directive cases this stream does not use.
 *
 * Note it is NOT `EventSource`. That only issues GETs, and these are POSTs with
 * a body and an auth header, which is why every client of this API hand-rolls
 * the read.
 */

/** One frame off the wire. `data` is raw; the caller parses it. */
export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

/**
 * Yield each event as it arrives.
 *
 * Decodes with `stream: true` so a multi-byte character split across two
 * network chunks is reassembled rather than mangled -- a UTF-8 sequence has no
 * obligation to arrive whole, and a dataset name with an accent in it is the
 * kind of thing that finds this bug in production rather than in a test.
 */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  /** Every complete frame currently in the buffer. Events are separated by a
   * blank line; anything after the last one is partial and stays put. */
  function* drain(): Generator<SseEvent> {
    let split = buffer.indexOf('\n\n');
    while (split !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const parsed = parseFrame(frame);
      if (parsed) {
        yield parsed;
      }
      split = buffer.indexOf('\n\n');
    }
  }

  try {
    while (true) {
      if (signal?.aborted) {
        return;
      }
      const { done, value } = await reader.read();
      if (done) {
        // Flush the deferred `\r`, if any: no further chunk is coming, so it
        // cannot be half of a CRLF and IS a line ending. Without this a stream
        // using bare CR loses its final frame -- the terminator never forms.
        buffer = normaliseNewlines(buffer, true);
        yield* drain();
        break;
      }
      buffer = normaliseNewlines(
        buffer + decoder.decode(value, { stream: true })
      );
      yield* drain();
    }
  } finally {
    // Releases the underlying connection whether the consumer finished, threw,
    // or stopped early -- a `break` in a for-await runs this.
    reader.releaseLock();
  }
}

/**
 * Collapse CRLF and bare CR to LF, so the rest of the parser can look for a
 * single line ending.
 *
 * The spec allows all three, and our own backend sends LF -- but "our backend
 * sends LF" is a statement about one hop. Anything between it and the browser
 * may rewrite line endings, and the failure if it does is total rather than
 * partial: the frame separator `\n\n` never matches `\r\n\r\n`, so ZERO events
 * parse, the stream looks empty, and the caller reports the response as
 * incomplete. Measured before this existed: 0 events from a well-formed CRLF
 * stream.
 *
 * The trailing `\r` is held back, and that is the whole subtlety. A chunk may
 * end mid-CRLF, with the `\n` arriving next; converting that `\r` to `\n` now
 * and meeting its partner later would manufacture a blank line -- a frame
 * boundary that was never sent, splitting one event into two malformed ones.
 * So it waits for the next chunk, exactly as a split multi-byte character does.
 */
function normaliseNewlines(buffer: string, final = false): string {
  const held = !final && buffer.endsWith('\r') ? '\r' : '';
  const body = held ? buffer.slice(0, -1) : buffer;
  return body.replace(/\r\n/g, '\n').replace(/\r/g, '\n') + held;
}

function parseFrame(frame: string): SseEvent | null {
  let event = 'message';
  let id: string | undefined;
  const data: string[] = [];

  for (const line of frame.split('\n')) {
    // A comment. The backend sends these as keepalives during a long wait, and
    // they carry nothing.
    if (line.startsWith(':')) {
      continue;
    }
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      data.push(line.slice('data:'.length).trim());
    } else if (line.startsWith('id:')) {
      id = line.slice('id:'.length).trim();
    }
  }

  if (data.length === 0) {
    return null;
  }
  return { event, data: data.join('\n'), id };
}

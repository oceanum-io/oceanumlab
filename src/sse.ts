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

  try {
    while (true) {
      if (signal?.aborted) {
        return;
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      // Events are separated by a blank line. Anything after the last one is a
      // partial frame and stays in the buffer.
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
  } finally {
    // Releases the underlying connection whether the consumer finished, threw,
    // or stopped early -- a `break` in a for-await runs this.
    reader.releaseLock();
  }
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

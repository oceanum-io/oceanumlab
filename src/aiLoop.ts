import type { ChatMessage, OceanumResponse } from './chatRouter';
import type { ObservedRun } from './notebookRun';

/** What `inject` reports back: the chat text, and what ran if anything did. */
export interface PlacedResponse {
  message: string;
  runs: ObservedRun[];
  /**
   * A code cell could not be executed at all (no kernel, pending input, the
   * notebook closed, Stop). Its run says so; observing it would only bring
   * back more code that cannot run either.
   */
  halted?: boolean;
}

/** The pieces the loop needs, injected so it can be tested without a notebook. */
export interface LoopDeps {
  route(
    prompt: string,
    history: ChatMessage[],
    signal: AbortSignal
  ): Promise<{
    response: OceanumResponse;
    hasCodeCellSelected: boolean;
  }>;
  observe(
    prompt: string,
    history: ChatMessage[],
    runs: ObservedRun[],
    signal: AbortSignal
  ): Promise<OceanumResponse>;
  place(
    response: OceanumResponse,
    options: { replaceCodeCell: boolean; autoRun: boolean; signal: AbortSignal }
  ): Promise<PlacedResponse>;
}

export interface LoopOptions {
  /** Run code cells as they are placed. Workflow 1; required for 2. */
  autoRunCode: boolean;
  /** Send each run's output back and place what comes next. Workflow 2. */
  iterate: boolean;
  /** Safety net on observe requests; see `runChatLoop`. */
  maxRounds: number;
  signal: AbortSignal;
}

export const STOPPED = 'Stopped.';

/**
 * One prompt, start to finish, under the two switches.
 *
 * The loop lives here rather than on the server because the CLIENT owns the
 * kernel: only it can run a cell and read what came back. The server sees one
 * turn at a time through `/api/chat/observe`.
 *
 *   autoRunCode off              -> place blocks, stop.           (workflow 3)
 *   autoRunCode on, iterate off  -> place, run, stop.             (workflow 1)
 *   autoRunCode on, iterate on   -> place, run, observe, repeat.  (workflow 2)
 *
 * `iterate` without `autoRunCode` is inert: nothing ran, so there is nothing
 * to observe. That falls out of the data (no runs) rather than a guard.
 *
 * Rounds end when nothing ran (the agent answered without code, so it is
 * done), or on Stop. The server enforces its own EXECUTE_MAX_ROUNDS: at the
 * cap it still answers, explaining the last run with any code stripped, and
 * that code-free answer ends the loop here. `maxRounds` is therefore only a
 * safety net against a server that keeps sending code, checked AFTER the
 * observe so the server's explanation turn is always requested. Every round's
 * message is kept: a chain that took three steps should read as three steps,
 * not as the last one.
 */
export async function runChatLoop(
  prompt: string,
  history: ChatMessage[],
  deps: LoopDeps,
  options: LoopOptions
): Promise<string> {
  const { signal } = options;
  const messages: string[] = [];
  const runs: ObservedRun[] = [];

  let response: OceanumResponse;
  let replaceCodeCell: boolean;
  try {
    const first = await deps.route(prompt, history, signal);
    response = first.response;
    replaceCodeCell = first.hasCodeCellSelected;
  } catch (err) {
    if (signal.aborted) {
      return STOPPED;
    }
    throw err;
  }
  if (signal.aborted) {
    return STOPPED;
  }

  for (let round = 1; ; round++) {
    const placed = await deps.place(response, {
      replaceCodeCell,
      autoRun: options.autoRunCode,
      signal
    });
    messages.push(placed.message);
    runs.push(...placed.runs);
    replaceCodeCell = false;

    if (signal.aborted) {
      messages.push(STOPPED);
      break;
    }
    if (!options.iterate || placed.runs.length === 0 || placed.halted) {
      // Nothing ran this round, or nothing could, so there is nothing to
      // observe.
      break;
    }
    if (round > options.maxRounds) {
      break;
    }

    try {
      response = await deps.observe(prompt, history, runs, signal);
    } catch (err) {
      // Stop pressed while the request was in flight. What was already placed
      // and explained stays in the chat; only the next step is dropped.
      if (signal.aborted) {
        messages.push(STOPPED);
        break;
      }
      throw err;
    }
    if (signal.aborted) {
      messages.push(STOPPED);
      break;
    }
  }

  return messages.filter(m => m.trim().length > 0).join('\n\n');
}

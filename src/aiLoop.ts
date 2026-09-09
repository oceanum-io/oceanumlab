import type { Block, ChatMessage, OceanumResponse } from './chatRouter';
import type { ObservedRun } from './notebookRun';

/** What `inject` reports back: the chat text, and what ran if anything did. */
export interface PlacedResponse {
  message: string;
  runs: ObservedRun[];
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
    options: { replaceCodeCell: boolean; autoRun: boolean }
  ): Promise<PlacedResponse>;
}

export interface LoopOptions {
  /** Run code cells as they are placed. Workflow 1; required for 2. */
  autoRunCode: boolean;
  /** Send each run's output back and place what comes next. Workflow 2. */
  iterate: boolean;
  /** Client-side mirror of the server's EXECUTE_MAX_ROUNDS. */
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
 * to observe. Stated here so the settings UI can grey it out honestly.
 *
 * Rounds end when a response carries no code (the agent is done), at
 * `maxRounds` (the server strips code past its own cap, so the client mirrors
 * it rather than sending a request whose code it would never run), or on
 * Stop. Every round's message is kept: a chain that took three steps should
 * read as three steps, not as the last one.
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

  const first = await deps.route(prompt, history, signal);
  if (signal.aborted) {
    return STOPPED;
  }

  let response = first.response;
  let replaceCodeCell = first.hasCodeCellSelected;

  for (let round = 1; ; round++) {
    const placed = await deps.place(response, {
      replaceCodeCell,
      autoRun: options.autoRunCode
    });
    messages.push(placed.message);
    // The agent's explanation travels with the code it explains.
    for (const run of placed.runs) {
      runs.push({ ...run, message: response.message });
    }
    replaceCodeCell = false;

    if (signal.aborted) {
      messages.push(STOPPED);
      break;
    }
    if (!options.autoRunCode || !options.iterate) {
      break;
    }
    if (!hasCode(response.blocks) || placed.runs.length === 0) {
      // Nothing ran this round, so there is nothing to observe.
      break;
    }
    if (round >= options.maxRounds) {
      break;
    }

    response = await deps.observe(prompt, history, runs, signal);
    if (signal.aborted) {
      messages.push(STOPPED);
      break;
    }
  }

  return messages.filter(m => m.trim().length > 0).join('\n\n');
}

function hasCode(blocks: Block[]): boolean {
  return blocks.some(b => b.type === 'code');
}

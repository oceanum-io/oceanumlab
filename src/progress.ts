/**
 * What the agent is doing right now, from the extension host to the widget
 * (OCE-175).
 *
 * A channel is needed because the widget does not call the router: it issues
 * the `oceanum-ai:submit-prompt` COMMAND, and command arguments must be JSON,
 * so a callback cannot cross. The Stop button has the same constraint and
 * solves it the same way -- an AbortController held in the plugin's closure.
 *
 * A module singleton rather than a JupyterLab `Signal`, because a Signal wants
 * an owner object and there is no natural one here: the producer is a command
 * handler and the consumer is a React component that mounts and unmounts
 * independently of it.
 */

/** A phase the backend named, and the tool it is using if that is the phase. */
export interface Progress {
  phase: string;
  tool?: string;
}

type Listener = (progress: Progress | null) => void;

const listeners = new Set<Listener>();

/** Subscribe. Returns the unsubscribe, for a React effect's cleanup. */
export function onProgress(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Publish. `null` means "no longer working", which the widget uses to fall
 * back to its own wording rather than leaving the last phase on screen after
 * the answer has arrived.
 *
 * A listener that throws must not stop the others hearing, nor break the
 * request: this is decoration, and a broken indicator is not worth failing an
 * answer over.
 */
export function reportProgress(progress: Progress | null): void {
  for (const listener of listeners) {
    try {
      listener(progress);
    } catch (err) {
      console.error('Oceanum AI: a progress listener threw', err);
    }
  }
}

/**
 * What each phase is, in the user's terms.
 *
 * An unlisted phase or tool falls back to something generic rather than
 * showing its internal name: a new server-side tool should read as progress,
 * not as a leak of what the agent is made of. And no phase at all reads as
 * "Thinking…", which is what this said before there was anything better to
 * say -- so a backend that does not stream, or a proxy that buffered the
 * stream away, degrades to exactly the old behaviour rather than to a blank.
 */
const TOOL_LABELS: Record<string, string> = {
  search_catalog: 'Searching the catalogue…',
  get_datasource_info: 'Reading dataset details…',
  save_memory: 'Saving a note…'
};

const PHASE_LABELS: Record<string, string> = {
  generating: 'Thinking…',
  interpreting: 'Reading the result…'
};

export function describeProgress(progress: Progress | null): string {
  if (!progress) {
    return 'Thinking…';
  }
  if (progress.phase === 'tool') {
    return progress.tool
      ? TOOL_LABELS[progress.tool] ?? 'Looking something up…'
      : 'Looking something up…';
  }
  return PHASE_LABELS[progress.phase] ?? 'Working…';
}

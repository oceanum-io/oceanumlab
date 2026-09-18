import { Signal } from '@lumino/signaling';

/**
 * Emits after this extension creates, renames or deletes a notebook record, so the
 * Notebooks tab can list again. A plain module-level signal: the tab and the commands
 * live in different plugins, and the change is the only thing they need to share.
 */
// The sender is a throwaway object, not null: Lumino keys its receivers by sender in a
// WeakMap, which refuses null.
export const notebooksChanged = new Signal<object, void>({});

/**
 * Ask the user for a notebook file on their computer; null if they cancel.
 *
 * Kept apart from the plugin because it is browser-only: the tests replace it.
 */
export function chooseNotebookFile(): Promise<File | null> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.ipynb,application/x-ipynb+json';
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null), {
      once: true
    });
    // Browsers fire `cancel` when the picker is dismissed; without it the promise
    // would simply never settle, which is harmless.
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.click();
  });
}

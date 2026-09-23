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
    input.hidden = true;
    // Attached while the picker is open: some browsers (Safari) drop the `change`
    // event of a detached input, or collect the input before it fires.
    document.body.appendChild(input);
    const settle = (file: File | null): void => {
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => settle(input.files?.[0] ?? null), {
      once: true
    });
    // Browsers fire `cancel` when the picker is dismissed; without it the promise
    // would simply never settle, which is harmless.
    input.addEventListener('cancel', () => settle(null), { once: true });
    input.click();
  });
}

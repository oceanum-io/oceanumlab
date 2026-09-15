/**
 * The Datamesh UI panel's address, and which messages may come from it.
 *
 * The address is a setting (`datameshUiUrl`), so a deployment can point the
 * panel at another Datamesh UI -- a dev one, say. A setting is typed in by
 * hand, so anything that is not an http(s) URL falls back to the default
 * rather than ending up in an iframe's `src`.
 */
import { DATAMESH_UI_SERVICE } from './constants';
import { validHttpUrl } from './httpUrl';

/** The Datamesh UI address to use for a `datameshUiUrl` setting value. */
export function validDatameshUiUrl(url: string | null | undefined): URL {
  return validHttpUrl(url, DATAMESH_UI_SERVICE);
}

/**
 * The panel's iframe `src`: the Datamesh UI in embed mode, which hides the
 * Oceanum.io navigator. Any query the setting already has is kept.
 */
export function datameshUiSrc(url: string | null | undefined): string {
  const src = validDatameshUiUrl(url);
  src.searchParams.set('embed', '1');
  return src.toString();
}

/**
 * Whether a `message` event was posted by the Datamesh UI panel.
 *
 * Any page or frame can post to this window, so a message counts only when it
 * comes from the panel's iframe (`frame`, its `contentWindow`; `null` when the
 * panel is not open) and from the configured Datamesh UI's origin.
 */
export function isDatameshUiMessage(
  event: Pick<MessageEvent, 'origin' | 'source'>,
  url: string | null | undefined,
  frame: Window | null
): boolean {
  return (
    !!frame &&
    event.source === frame &&
    event.origin === validDatameshUiUrl(url).origin
  );
}

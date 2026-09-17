/**
 * The service addresses oceanumlab uses, per Oceanum environment: the Datamesh UI its Datamesh
 * panel shows, and the Oceanum AI backend its AI chat calls.
 *
 * oceanumlab's settings default to production. Settings overrides are the same for every host,
 * so the environment's addresses are written as the user's settings instead. Browsers keep
 * settings per site, so they never reach another environment's notebook.
 */
import { IOceanumServiceUrls } from './tokens';

/** The oceanumlab plugin whose settings hold the service addresses. */
export const OCEANUMLAB_SETTINGS = '@oceanum/oceanumlab:datamesh-connect';

/** Each oceanumlab address setting, and the environment URL it takes. */
export const URL_SETTINGS: readonly {
  readonly setting: string;
  readonly url: (urls: IOceanumServiceUrls) => string | undefined;
}[] = [
  { setting: 'datameshUiUrl', url: urls => urls.datameshUi },
  { setting: 'aiBackendUrl', url: urls => urls.ai }
];

function normalise(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim().replace(/\/+$/, '')
    : null;
}

/**
 * The address to write to an oceanumlab address setting, or `null` to leave it alone: when the
 * environment names no address, when the user has set one themselves, or when the address in
 * effect is already the environment's.
 */
export function urlSettingToWrite(
  environmentUrl: string | undefined,
  userValue: unknown,
  compositeValue: unknown
): string | null {
  const url = normalise(environmentUrl);
  if (
    url === null ||
    userValue !== undefined ||
    normalise(compositeValue) === url
  ) {
    return null;
  }
  return url;
}

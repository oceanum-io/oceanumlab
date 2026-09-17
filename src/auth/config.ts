import { IOceanumEnvironment, IOceanumServiceUrls } from './tokens';

/** The plugin id under which `jupyter-lite.json` carries `litePluginSettings`. */
export const PLUGIN_ID = '@oceanum/auth-oceanum:plugin';

const URL_KEYS: readonly (keyof IOceanumServiceUrls)[] = [
  'datamesh',
  'specs',
  'manage'
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseUrl(value: unknown): string | null {
  if (!nonEmptyString(value)) {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.href.replace(/\/+$/, '')
      : null;
  } catch {
    return null;
  }
}

function parseEnvironment(raw: unknown): IOceanumEnvironment | null {
  if (!isRecord(raw) || !isRecord(raw.urls) || !Array.isArray(raw.hosts)) {
    return null;
  }
  const { auth0Domain, clientId } = raw;
  const hosts = raw.hosts
    .filter(nonEmptyString)
    .map(host => host.toLowerCase());
  if (
    !nonEmptyString(auth0Domain) ||
    !nonEmptyString(clientId) ||
    hosts.length === 0
  ) {
    return null;
  }
  const urls: Partial<Record<keyof IOceanumServiceUrls, string>> = {};
  for (const key of URL_KEYS) {
    const url = parseUrl(raw.urls[key]);
    if (!url) {
      return null;
    }
    urls[key] = url;
  }
  return { hosts, auth0Domain, clientId, urls: urls as IOceanumServiceUrls };
}

/**
 * Read the environments from the `litePluginSettings` page option (a JSON string).
 * Malformed entries are dropped rather than failing the whole extension.
 */
export function readEnvironments(
  litePluginSettings: string | undefined
): IOceanumEnvironment[] {
  if (!litePluginSettings) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(litePluginSettings);
  } catch {
    return [];
  }
  const settings = isRecord(parsed) ? parsed[PLUGIN_ID] : undefined;
  if (!isRecord(settings) || !Array.isArray(settings.environments)) {
    return [];
  }
  const environments: IOceanumEnvironment[] = [];
  for (const raw of settings.environments) {
    const environment = parseEnvironment(raw);
    if (environment) {
      environments.push(environment);
    } else {
      console.warn(`${PLUGIN_ID}: ignoring an invalid environment`, raw);
    }
  }
  return environments;
}

/** The environment serving `hostname`, or `null` when sign-in is not configured for it. */
export function selectEnvironment(
  environments: readonly IOceanumEnvironment[],
  hostname: string
): IOceanumEnvironment | null {
  const host = hostname.toLowerCase();
  return (
    environments.find(environment => environment.hosts.includes(host)) ?? null
  );
}

import { IOceanumEnvironment, IOceanumServiceUrls } from './tokens';

/** The plugin id under which `jupyter-lite.json` carries `litePluginSettings`. */
export const PLUGIN_ID = '@oceanum/auth-oceanum:plugin';

/**
 * The page option a Jupyter server publishes its environments under, as a JSON array.
 *
 * Deliberately a page option rather than a plugin setting: which Auth0 tenant this notebook
 * signs in to, and which Datamesh its kernels are given credentials for, is the deployment's
 * decision. In the settings registry it would be user-editable, and a user could be talked
 * into pasting someone else's tenant and service URLs.
 */
export const ENVIRONMENTS_OPTION = 'oceanumEnvironments';

const URL_KEYS: readonly (keyof IOceanumServiceUrls)[] = [
  'datamesh',
  'specs',
  'manage'
];

/** Service URLs an environment may leave out; an invalid one is ignored. */
const OPTIONAL_URL_KEYS: readonly (keyof IOceanumServiceUrls)[] = [
  'datameshUi',
  'ai'
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

/**
 * A bare domain such as `oceanum.io`: URLs are built as `https://prax.${domain}/...`, so a
 * scheme, port, path or leading dot would produce broken or unintended URLs.
 */
function isDomain(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(
      value
    )
  );
}

function parseEnvironment(raw: unknown): IOceanumEnvironment | null {
  if (!isRecord(raw) || !isRecord(raw.urls) || !Array.isArray(raw.hosts)) {
    return null;
  }
  const { auth0Domain, clientId, oceanumDomain } = raw;
  const hosts = raw.hosts
    .filter(nonEmptyString)
    .map(host => host.toLowerCase());
  if (
    !nonEmptyString(auth0Domain) ||
    !nonEmptyString(clientId) ||
    !isDomain(oceanumDomain) ||
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
  for (const key of OPTIONAL_URL_KEYS) {
    if (raw.urls[key] !== undefined) {
      const url = parseUrl(raw.urls[key]);
      if (url) {
        urls[key] = url;
      } else {
        console.warn(
          `${PLUGIN_ID}: ignoring an invalid urls.${key}`,
          raw.urls[key]
        );
      }
    }
  }
  return {
    hosts,
    auth0Domain,
    clientId,
    oceanumDomain: oceanumDomain.toLowerCase(),
    urls: urls as IOceanumServiceUrls,
    signInRedirect: raw.signInRedirect === true
  };
}

/**
 * Parse an `environments` array from any source. Malformed entries are dropped rather than
 * failing the whole extension, because one bad entry should not cost a deployment its sign-in.
 */
export function parseEnvironments(raw: unknown): IOceanumEnvironment[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const environments: IOceanumEnvironment[] = [];
  for (const entry of raw) {
    const environment = parseEnvironment(entry);
    if (environment) {
      environments.push(environment);
    } else {
      console.warn(`${PLUGIN_ID}: ignoring an invalid environment`, entry);
    }
  }
  return environments;
}

/**
 * Read the environments from the `oceanumEnvironments` page option (a JSON array string),
 * which oceanumlab's Jupyter server extension publishes from its own configuration.
 */
export function readEnvironmentsOption(
  option: string | undefined
): IOceanumEnvironment[] {
  if (!option) {
    return [];
  }
  try {
    return parseEnvironments(JSON.parse(option));
  } catch {
    console.warn(`${PLUGIN_ID}: ignoring a malformed ${ENVIRONMENTS_OPTION}`);
    return [];
  }
}

/**
 * Read the environments from the `litePluginSettings` page option (a JSON string).
 *
 * This is how JupyterLite deployments are configured, through `jupyter-lite.json`. A native
 * JupyterLab has a server, so it is configured there instead and reaches the page through
 * `ENVIRONMENTS_OPTION`; its own `page_config.json` is no use, because it silently collapses a
 * nested object to its keys.
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
  return isRecord(settings) ? parseEnvironments(settings.environments) : [];
}

/**
 * Whether this deployment offers Oceanum.io sign-in at all, and so whether the top bar should
 * carry the account control.
 *
 * It turns on whether any environment is declared, not on whether one matched the page. A
 * deployment that declares environments but none for this host is misconfigured, and the
 * control says so rather than vanishing. A deployment that declares none is an ordinary
 * JupyterLab, which oceanumlab ships to: sign-in was never on offer there, so a permanent
 * "unavailable" notice would be noise on every install.
 */
export function offersSignIn(
  environments: readonly IOceanumEnvironment[]
): boolean {
  return environments.length > 0;
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

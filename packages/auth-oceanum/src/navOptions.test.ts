import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The Oceanum nav owns the Auth0 session, and two of the props it is given are security
 * requirements rather than preferences. Nothing else covers them: rendering the nav would
 * pull in React 19, Mantine and a live Auth0 client, so this reads the source instead.
 *
 * It replaces the assertion that used to live in oceanumlab's authClientOptions.spec.ts,
 * against the Auth0Client this extension configured directly before the nav owned it.
 */
const source = readFileSync(
  fileURLToPath(new URL('./nav.tsx', import.meta.url)),
  'utf8'
);

describe('the options the Oceanum nav is mounted with', () => {
  it('keeps tokens in memory, never in web storage', () => {
    // This page renders notebook output, so a refresh token at rest is one script in an
    // output cell away from exfiltration.
    expect(source).toContain('cacheLocation="memory"');
    expect(source).not.toMatch(/cacheLocation=["{]\s*["']?localstorage/i);
  });

  it('refuses an access token handed in by another page', () => {
    // The nav can take a token by postMessage without checking the sender. Here, any site
    // that opened this page could sign it in as another account, and that account's token
    // would reach the kernels.
    expect(source).toContain('acceptExternalToken={false}');
  });
});

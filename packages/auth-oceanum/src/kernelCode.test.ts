import { describe, expect, it } from 'vitest';

import {
  isValidAccessToken,
  kernelSetupCode,
  pythonString,
  settingToken,
  SNIPPET_MARKER
} from './kernelCode';

const JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJl-_';

describe('isValidAccessToken', () => {
  it('accepts JWT-shaped tokens', () => {
    expect(isValidAccessToken(JWT)).toBe(true);
  });

  it.each([
    '',
    'abc"def',
    "abc'def",
    'abc\ndef',
    'abc def',
    'abc\\def',
    'a'.repeat(16384)
  ])('rejects %j', token => {
    expect(isValidAccessToken(token)).toBe(false);
  });
});

describe('pythonString', () => {
  it('escapes quotes, backslashes and newlines', () => {
    expect(pythonString('a"b\\c\nd')).toBe('"a\\"b\\\\c\\nd"');
  });
});

describe('settingToken', () => {
  it('passes a Datamesh token as it is, for oceanum to send as a Datamesh token', () => {
    expect(settingToken('  a1b2c3d4e5  ')).toBe('a1b2c3d4e5');
  });

  it('sends a JWT, with or without the Bearer prefix, as a bearer token', () => {
    expect(settingToken(JWT)).toBe(`Bearer ${JWT}`);
    expect(settingToken(`Bearer ${JWT}`)).toBe(`Bearer ${JWT}`);
  });

  it('ignores an empty, missing or malformed setting', () => {
    expect(settingToken('')).toBeNull();
    expect(settingToken(undefined)).toBeNull();
    expect(settingToken('x")\nimport os')).toBeNull();
  });
});

describe('kernelSetupCode', () => {
  it('passes the token with the Bearer prefix and the Datamesh URL', () => {
    const code = kernelSetupCode({
      bootstrapSource: 'def install(url): pass',
      datameshUrl: 'https://datamesh.oceanum.tech',
      accessToken: JWT
    });

    expect(code).toContain(`module.set_token("Bearer ${JWT}")`);
    expect(code).toContain('module.install("https://datamesh.oceanum.tech")');
    expect(code).toContain('module.scrub_history()');
  });

  it('clears the token and leaves the service unset when signed out off-host', () => {
    const code = kernelSetupCode({
      bootstrapSource: '',
      datameshUrl: null,
      accessToken: null
    });

    expect(code).toContain('module.set_token(None)');
    expect(code).toContain('module.install(None)');
  });

  it('marks the snippet so its history entry can be scrubbed, and cleans up its name', () => {
    const code = kernelSetupCode({
      bootstrapSource: '',
      datameshUrl: null,
      accessToken: null
    });

    expect(code.startsWith(`def ${SNIPPET_MARKER}():`)).toBe(true);
    expect(code.trimEnd().endsWith(`del ${SNIPPET_MARKER}`)).toBe(true);
  });

  it("prefers the token from oceanumlab's setting to the sign-in token", () => {
    const code = kernelSetupCode({
      bootstrapSource: '',
      datameshUrl: null,
      accessToken: JWT,
      settingToken: 'datamesh-token-123'
    });

    expect(code).toContain('module.set_token("datamesh-token-123")');
  });

  it('refuses a malformed token instead of embedding it', () => {
    expect(() =>
      kernelSetupCode({
        bootstrapSource: '',
        datameshUrl: null,
        accessToken: 'x")\nimport os'
      })
    ).toThrow(/malformed/);
  });
});

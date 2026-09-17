import {
  isValidAccessToken,
  kernelSetupCode,
  pythonString,
  SNIPPET_MARKER
} from '../auth/kernelCode';

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
    expect(code.replace(/\s+$/, '').endsWith(`del ${SNIPPET_MARKER}`)).toBe(
      true
    );
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

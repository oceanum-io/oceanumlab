import { DATAMESH_UI_SERVICE } from '../constants';
import {
  datameshUiSrc,
  isDatameshUiMessage,
  validDatameshUiUrl
} from '../datameshUiUrl';

describe('validDatameshUiUrl', () => {
  it('is production when the deployment names no address', () => {
    expect(validDatameshUiUrl(undefined).href).toBe(
      new URL(DATAMESH_UI_SERVICE).href
    );
  });

  it('takes an http(s) address as it is', () => {
    expect(validDatameshUiUrl('https://ui.datamesh.oceanum.tech').href).toBe(
      'https://ui.datamesh.oceanum.tech/'
    );
    expect(validDatameshUiUrl('http://localhost:3000').href).toBe(
      'http://localhost:3000/'
    );
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['missing', undefined],
    ['null', null],
    ['not a URL', 'not a url'],
    ['a relative path', '/datamesh'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a data: URL', 'data:text/html,<script>alert(1)</script>'],
    ['a file: URL', 'file:///etc/passwd']
  ])('falls back to the default for %s', (_, url) => {
    expect(validDatameshUiUrl(url).href).toBe(`${DATAMESH_UI_SERVICE}/`);
  });
});

describe('datameshUiSrc', () => {
  it('opens the default Datamesh UI in embed mode', () => {
    expect(datameshUiSrc(DATAMESH_UI_SERVICE)).toBe(
      'https://ui.datamesh.oceanum.io/?embed=1'
    );
  });

  it('keeps the query and fragment a custom address already has', () => {
    const src = new URL(
      datameshUiSrc('https://ui.datamesh.oceanum.tech/app?workspace=abc#top')
    );

    expect(src.origin).toBe('https://ui.datamesh.oceanum.tech');
    expect(src.pathname).toBe('/app');
    expect(src.searchParams.get('workspace')).toBe('abc');
    expect(src.searchParams.get('embed')).toBe('1');
    expect(src.hash).toBe('#top');
  });

  it('does not add embed twice', () => {
    const src = new URL(
      datameshUiSrc('https://ui.datamesh.oceanum.io?embed=0')
    );

    expect(src.searchParams.getAll('embed')).toEqual(['1']);
  });

  it('opens the default for an invalid address', () => {
    expect(datameshUiSrc('not a url')).toBe(
      'https://ui.datamesh.oceanum.io/?embed=1'
    );
  });

  it('never puts a javascript: URL in the iframe', () => {
    expect(datameshUiSrc('javascript:alert(1)')).toBe(
      'https://ui.datamesh.oceanum.io/?embed=1'
    );
  });
});

describe('isDatameshUiMessage', () => {
  const frame = {} as Window;
  const other = {} as Window;

  it('accepts a message from the panel at the configured origin', () => {
    expect(
      isDatameshUiMessage(
        { origin: 'https://ui.datamesh.oceanum.io', source: frame },
        DATAMESH_UI_SERVICE,
        frame
      )
    ).toBe(true);
  });

  it('compares origins, not whole addresses', () => {
    expect(
      isDatameshUiMessage(
        { origin: 'https://ui.datamesh.oceanum.tech', source: frame },
        'https://ui.datamesh.oceanum.tech/app?workspace=abc',
        frame
      )
    ).toBe(true);
  });

  it.each([
    ['another site', 'https://evil.example'],
    ['the production UI when a dev one is configured', DATAMESH_UI_SERVICE],
    ['another port', 'https://ui.datamesh.oceanum.tech:8443'],
    ['plain http', 'http://ui.datamesh.oceanum.tech'],
    ['an opaque origin', 'null']
  ])('rejects a message from %s', (_, origin) => {
    expect(
      isDatameshUiMessage(
        { origin, source: frame },
        'https://ui.datamesh.oceanum.tech',
        frame
      )
    ).toBe(false);
  });

  it('checks the origin against the default for an invalid setting', () => {
    expect(
      isDatameshUiMessage(
        { origin: 'https://ui.datamesh.oceanum.io', source: frame },
        'javascript:alert(1)',
        frame
      )
    ).toBe(true);
    expect(
      isDatameshUiMessage(
        { origin: 'null', source: frame },
        'javascript:alert(1)',
        frame
      )
    ).toBe(false);
  });

  it('rejects the right origin from another window', () => {
    expect(
      isDatameshUiMessage(
        { origin: 'https://ui.datamesh.oceanum.io', source: other },
        DATAMESH_UI_SERVICE,
        frame
      )
    ).toBe(false);
  });

  it('rejects every message while the panel is closed', () => {
    expect(
      isDatameshUiMessage(
        { origin: 'https://ui.datamesh.oceanum.io', source: null },
        DATAMESH_UI_SERVICE,
        null
      )
    ).toBe(false);
  });
});

import {
  decodePayload,
  encodePayload,
  FRAGMENT_KEY,
  hashWithoutPayload,
  IDatameshNotebookRequest,
  MAX_DEPTH,
  MAX_ITEMS,
  notebookFromDatamesh,
  notebookName,
  payloadFromHash,
  pyIdentifier,
  pyLiteral,
  pyString,
  queryCellSource,
  queryFields
} from '../share/fromDatamesh';
import { marked } from 'marked';

const QUERY = {
  id: 'abc123',
  label: 'era5_wind10m_abc123',
  datasource: 'era5_wind10m',
  description: 'ERA5 10m wind',
  variables: ['u10', 'v10'],
  timefilter: { times: ['2024-01-01T00:00:00Z', null] },
  geofilter: { type: 'bbox', geom: [170, -45, 175, -40] }
};

function request(items: unknown[], name?: string): IDatameshNotebookRequest {
  return { v: 1, name, items } as IDatameshNotebookRequest;
}

describe('payload encoding', () => {
  it('round-trips through base64url, including non-ASCII text', () => {
    const req = request(
      [{ ...QUERY, description: 'Vent à 10 m — 風' }],
      'Ōtaki'
    );
    const encoded = encodePayload(req);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodePayload(encoded)).toEqual(req);
  });

  it('rejects text that is not a payload', () => {
    expect(() => decodePayload('!!!')).toThrow('not valid');
    expect(() => decodePayload(btoa('not json'))).toThrow('not valid');
  });

  it('rejects other versions, empty and oversized workspaces, and bad items', () => {
    const enc = (v: unknown) =>
      encodePayload(v as unknown as IDatameshNotebookRequest);
    expect(() => decodePayload(enc({ v: 2, items: [QUERY] }))).toThrow(
      'newer Datamesh UI'
    );
    expect(() => decodePayload(enc({ v: 1, items: [] }))).toThrow('no queries');
    expect(() =>
      decodePayload(enc({ v: 1, items: Array(MAX_ITEMS + 1).fill(QUERY) }))
    ).toThrow('too many');
    expect(() =>
      decodePayload(enc({ v: 1, items: [{ datasource: 3 }] }))
    ).toThrow('not valid');
    expect(() =>
      decodePayload(enc({ v: 1, items: [{ datasource: ' ' }] }))
    ).toThrow('not valid');
    expect(() => decodePayload(enc({ v: 1, name: 5, items: [QUERY] }))).toThrow(
      'not valid'
    );
  });
});

describe('fragment handling', () => {
  it('finds the payload among other hash keys and removes only it', () => {
    const hash = `#foo=1&${FRAGMENT_KEY}=abc_-`;
    expect(payloadFromHash(hash)).toBe('abc_-');
    expect(hashWithoutPayload(hash)).toBe('#foo=1');
    expect(hashWithoutPayload(`#${FRAGMENT_KEY}=x`)).toBe('');
    expect(payloadFromHash('')).toBeNull();
  });

  it('keeps every other part of the hash exactly as it was', () => {
    expect(hashWithoutPayload(`#my-heading&${FRAGMENT_KEY}=x`)).toBe(
      '#my-heading'
    );
    expect(hashWithoutPayload(`#a=b%20c&${FRAGMENT_KEY}=x&d`)).toBe(
      '#a=b%20c&d'
    );
  });
});

describe('payload limits', () => {
  const nested = (depth: number): unknown => {
    let v: unknown = 'x'.repeat(80);
    for (let i = 0; i < depth; i++) {
      v = [v];
    }
    return v;
  };

  it('rejects nesting deeper than real queries use', () => {
    const enc = (depth: number) =>
      encodePayload({
        v: 1,
        items: [{ datasource: 'abc', variables: nested(depth) }]
      } as unknown as IDatameshNotebookRequest);
    expect(() => decodePayload(enc(20))).not.toThrow();
    expect(() => decodePayload(enc(MAX_DEPTH))).toThrow('not valid');
  });

  it('renders deep values in linear time (was 2^depth)', () => {
    const started = Date.now();
    pyLiteral(nested(MAX_DEPTH));
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('pyLiteral', () => {
  it('writes Python, not JSON, constants', () => {
    expect(pyLiteral({ a: null, b: true, c: false, d: 1.5 })).toBe(
      '{"a": None, "b": True, "c": False, "d": 1.5}'
    );
  });

  it('keeps "null" and "true" inside strings as text', () => {
    expect(pyLiteral(['null', 'true'])).toBe('["null", "true"]');
  });

  it('escapes strings so they cannot end the literal', () => {
    const nasty = '"); import os; os.system("x") #\n\'\'\'\\';
    const lit = pyLiteral(nasty);
    expect(lit).toBe(JSON.stringify(nasty));
    expect(lit).not.toContain('\n');
  });

  it('wraps long values over several indented lines', () => {
    const lit = pyLiteral({
      geofilter: { type: 'feature', geom: { coordinates: Array(30).fill(1) } }
    });
    expect(lit.split('\n').length).toBeGreaterThan(3);
    expect(lit).toContain('\n    "geofilter": {');
  });
});

describe('pyIdentifier', () => {
  it('makes valid, unique names', () => {
    const taken = new Set<string>();
    expect(pyIdentifier('ERA5 wind-10m.v2', taken)).toBe('era5_wind_10m_v2');
    expect(pyIdentifier('ERA5 wind-10m.v2', taken)).toBe('era5_wind_10m_v2_2');
    expect(pyIdentifier('2024 swell', taken)).toBe('ds_2024_swell');
    expect(pyIdentifier('import', taken)).toBe('import_');
    expect(pyIdentifier('datamesh', taken)).toBe('datamesh_');
    expect(pyIdentifier('—', taken)).toBe('data');
  });
});

describe('query cells', () => {
  it('passes only fields oceanum-python Query accepts', () => {
    expect(Object.keys(queryFields(QUERY)).sort()).toEqual(
      [
        'datasource',
        'description',
        'geofilter',
        'timefilter',
        'variables'
      ].sort()
    );
  });

  it('queries a filtered selection', () => {
    const src = queryCellSource(QUERY, 'wind');
    expect(src).toContain('# ERA5 10m wind');
    expect(src).toContain('wind = datamesh.query({');
    expect(src).toContain('"times": ["2024-01-01T00:00:00Z", None]');
    expect(src).not.toContain('"label"');
    expect(src.endsWith('\nwind')).toBe(true);
  });

  it('opens an unfiltered datasource lazily', () => {
    const src = queryCellSource(
      { datasource: 'era5_wind10m', variables: [], functions: [] },
      'wind'
    );
    expect(src).toBe('wind = datamesh.load_datasource("era5_wind10m")\nwind');
  });

  it('keeps a multi-line description on one comment line', () => {
    const src = queryCellSource(
      { ...QUERY, description: 'a\nprint("pwned")' },
      'x'
    );
    expect(src.split('\n')[0]).toBe('# a print("pwned")');
  });
});

// Every character Python's str.splitlines() breaks on, which IPython uses to split
// a cell into lines (reviewer-found injection through the comment line).
const SPLITLINES = [
  0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029
].map(c => String.fromCharCode(c));

describe('line breaks cannot escape a comment or a string', () => {
  it.each(SPLITLINES.map(c => [c.charCodeAt(0).toString(16), c]))(
    'U+%s in a description or label stays inside the comment',
    (_hex, sep) => {
      for (const item of [
        { ...QUERY, description: `wind${sep}import os` },
        { ...QUERY, description: undefined, label: `wind${sep}import os` }
      ]) {
        const src = queryCellSource(item, 'x');
        const comment = src.split('\n')[0];
        expect(comment).toBe('# wind import os');
        for (const c of SPLITLINES.filter(s => s !== '\n')) {
          expect(src).not.toContain(c);
        }
      }
    }
  );

  it('escapes C1 controls and U+2028/9 inside string literals and keys', () => {
    const text = SPLITLINES.join('') + String.fromCharCode(0, 0x7f, 0x9f);
    const lit = pyLiteral({ [text]: text });
    // Only printable ASCII is left: every control and separator is a \u escape.
    expect(pyString(text)).toMatch(/^[\x20-\x7e]*$/);
    // pyLiteral's own wrapping adds plain newlines, and nothing else.
    expect(lit).toMatch(/^[\x20-\x7e\n]*$/);
    expect(lit).toContain('\\u0085');
    expect(lit).toContain('\\u2028');
    // Still the same value once parsed (JSON reads \u escapes as Python does).
    expect(JSON.parse(pyString(text))).toBe(text);
  });

  it('strips them from the Markdown heading too', () => {
    const nb = notebookFromDatamesh(
      request([QUERY], `a${SPLITLINES.join('')}b`)
    );
    expect(String(nb.cells[0].source).split('\n')[0]).toBe('# a b');
  });
});

describe('the Markdown heading, rendered as JupyterLab renders it', () => {
  it.each([
    '[x](https://e.example) ![y](https://e.example/p.png)',
    'https://2130706433/login',
    'www.evil.example',
    'me@evil.example',
    '<img src=x onerror=alert(1)>',
    '[x](javascript:alert(1))',
    '`code` **bold** _em_ ~~s~~'
  ])('%s renders as plain text', async name => {
    const nb = notebookFromDatamesh(request([QUERY], name));
    const html = await marked.parse(String(nb.cells[0].source), { gfm: true });
    const heading = html.split('\n')[0];
    expect(heading).toMatch(/^<h1>[^<]*<\/h1>$/);
  });
});

describe('optional text fields', () => {
  it('accepts null name, label and description', () => {
    const enc = encodePayload({
      v: 1,
      name: null,
      items: [{ ...QUERY, label: null, description: null }]
    } as unknown as IDatameshNotebookRequest);
    const req = decodePayload(enc);
    expect(req.name).toBeUndefined();
    const nb = notebookFromDatamesh(req);
    expect(nb.cells[2].source).toContain('era5_wind10m = datamesh.query(');
  });
});

describe('notebookFromDatamesh', () => {
  it('builds an untrusted, unlinked notebook with one cell per query', () => {
    const nb = notebookFromDatamesh(
      request([QUERY, { ...QUERY, label: undefined }], 'My <b>work</b>space')
    );
    expect(nb.nbformat).toBe(4);
    expect(nb.metadata).toEqual({ language_info: { name: 'python' } });
    expect(nb.cells).toHaveLength(4);
    expect(nb.cells[0].source).toContain('# My &lt;b&gt;work&lt;\\/b&gt;space');
    expect(nb.cells[1].source).toContain('datamesh = Connector()');
    expect(nb.cells[2].source).toContain(
      'era5_wind10m_abc123 = datamesh.query'
    );
    expect(nb.cells[3].source).toContain('era5_wind10m = datamesh.query');
    for (const cell of nb.cells) {
      expect(cell.metadata).toEqual({});
    }
  });

  it('names the notebook after the workspace, else the single query', () => {
    expect(notebookName(request([QUERY], ' Coast '))).toBe('Coast');
    expect(notebookName(request([QUERY]))).toBe('era5_wind10m_abc123');
    expect(notebookName(request([QUERY, QUERY]))).toBe('Datamesh workspace');
  });
});

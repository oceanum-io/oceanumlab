import type { INotebookContent } from '@jupyterlab/nbformat';

import {
  buildSpecBody,
  isShareableEmail,
  isSpecId,
  nameFromPath,
  notebookFromRecord,
  notebookFromUpload,
  parseNotebookDemo,
  parseShareEmails,
  parseTimestamp,
  partitionSummaries,
  readLink,
  reportForShareFailures,
  sanitizeName,
  shareLink,
  uniqueNotebookPath,
  unlinkedNotebookFromRecord,
  withoutTrust
} from '../share/notebook';

const SPECS = 'https://specs.example.com';
const ID = '6f1c1a52-4b8e-4c0f-9a57-1d2e3f4a5b6c';

function notebook(
  outputText = 'hello',
  metadata: object = {}
): INotebookContent {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { name: 'python', display_name: 'Python' },
      ...metadata
    },
    cells: [
      { cell_type: 'markdown', source: '# Title', metadata: {} },
      {
        cell_type: 'code',
        source: 'print(1)',
        metadata: {},
        execution_count: 3,
        outputs: [{ output_type: 'stream', name: 'stdout', text: outputText }]
      }
    ]
  };
}

describe('isSpecId', () => {
  it('accepts UUIDs only', () => {
    expect(isSpecId(ID)).toBe(true);
    expect(isSpecId(ID.toUpperCase())).toBe(true);
    expect(isSpecId(`${ID}/permissions`)).toBe(false);
    expect(isSpecId('../x')).toBe(false);
    expect(isSpecId('')).toBe(false);
    expect(isSpecId(42)).toBe(false);
  });
});

describe('readLink', () => {
  it('reads a link for the same spec store', () => {
    expect(
      readLink({ spec_id: ID, specs_url: SPECS, description: 'd' }, SPECS)
    ).toEqual({
      spec_id: ID,
      specs_url: SPECS,
      description: 'd'
    });
  });

  it('ignores links to another spec store or with a bad id', () => {
    expect(
      readLink({ spec_id: ID, specs_url: 'https://specs.dev' }, SPECS)
    ).toBeNull();
    expect(readLink({ spec_id: 'nope', specs_url: SPECS }, SPECS)).toBeNull();
    expect(readLink(undefined, SPECS)).toBeNull();
    expect(readLink([ID], SPECS)).toBeNull();
  });
});

describe('buildSpecBody', () => {
  it('uses the file name and drops the link from the stored notebook', () => {
    const content = notebook('hi', {
      oceanum: { spec_id: ID, specs_url: SPECS, description: 'Wave stats' }
    });
    const result = buildSpecBody(content, 'Oceanum/Waves (1).ipynb', SPECS);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.strippedOutputs).toBe(false);
    expect(result.body.name).toBe('Waves (1)');
    expect(result.body.description).toBe('Wave stats');
    expect(result.body.spec.metadata.oceanum).toBeUndefined();
    expect(result.body.spec.metadata.kernelspec).toBeDefined();
    expect(content.metadata.oceanum).toBeDefined();
  });

  it('strips code-cell outputs when the body is over the limit', () => {
    const content = notebook('x'.repeat(5000));
    const result = buildSpecBody(content, 'big.ipynb', SPECS, 2000);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.strippedOutputs).toBe(true);
    expect(result.bytes).toBeLessThanOrEqual(2000);
    const code = result.body.spec.cells[1] as { outputs: unknown[] };
    expect(code.outputs).toEqual([]);
    expect(
      (result.body.spec.cells[1] as { execution_count: unknown })
        .execution_count
    ).toBeNull();
    expect(result.body.spec.cells[0]).toEqual(content.cells[0]);
    // The input notebook is not modified.
    expect((content.cells[1] as { outputs: unknown[] }).outputs).toHaveLength(
      1
    );
  });

  it('refuses a notebook that is too large even without outputs', () => {
    const content = notebook();
    content.cells[0].source = 'y'.repeat(5000);
    const result = buildSpecBody(content, 'big.ipynb', SPECS, 2000);
    expect(result.ok).toBe(false);
    expect(result.bytes).toBeGreaterThan(2000);
  });

  it('measures UTF-8 bytes, not characters', () => {
    const content = notebook('');
    content.cells[0].source = '\u{1F30A}'.repeat(400); // 4 bytes each
    const size = JSON.stringify({
      name: 'n',
      description: null,
      spec: content
    }).length;
    const result = buildSpecBody(content, 'n.ipynb', SPECS, size + 100);
    expect(result.ok).toBe(false);
  });
});

describe('notebookFromRecord', () => {
  const base = {
    id: ID,
    name: 'Waves',
    modified: '2026-09-12T10:00:00',
    creator: null as string | null
  };

  it('sets the oceanum link', () => {
    const content = notebookFromRecord(
      { ...base, description: 'Wave stats', spec: notebook() },
      SPECS
    );
    expect(content.metadata.oceanum).toEqual({
      spec_id: ID,
      specs_url: SPECS,
      description: 'Wave stats'
    });
    expect(content.cells).toHaveLength(2);
  });

  it('replaces a stale link and omits an empty description', () => {
    const spec = notebook('', { oceanum: { spec_id: 'old', specs_url: 'x' } });
    const content = notebookFromRecord(
      { ...base, description: null, spec },
      SPECS
    );
    expect(content.metadata.oceanum).toEqual({
      spec_id: ID,
      specs_url: SPECS
    });
  });

  it('rejects records that are not notebooks', () => {
    for (const spec of [
      {},
      [],
      null,
      { nbformat: 4, cells: {} },
      { nbformat: 3 }
    ]) {
      expect(() =>
        notebookFromRecord({ ...base, description: null, spec }, SPECS)
      ).toThrow(/not a valid notebook/);
    }
  });
});

describe('unlinkedNotebookFromRecord', () => {
  const base = {
    id: ID,
    name: 'Waves',
    description: 'Wave stats',
    modified: '2026-09-12T10:00:00',
    creator: null as string | null
  };

  it('links the copy to nothing, even when the stored notebook carries a link', () => {
    const spec = notebook('', { oceanum: { spec_id: ID, specs_url: SPECS } });
    const content = unlinkedNotebookFromRecord({ ...base, spec });
    expect(content.metadata).not.toHaveProperty('oceanum');
    expect(content.metadata.kernelspec).toBeDefined();
    expect(content.cells).toHaveLength(2);
  });

  it('arrives untrusted', () => {
    const spec = notebook();
    spec.cells[1].metadata = { trusted: true, tags: ['keep'] };
    const content = unlinkedNotebookFromRecord({ ...base, spec });
    expect(content.cells[1].metadata).toEqual({ tags: ['keep'] });
  });

  it('rejects records that are not notebooks', () => {
    expect(() =>
      unlinkedNotebookFromRecord({ ...base, spec: { nbformat: 3 } })
    ).toThrow(/not a valid notebook/);
  });
});

describe('parseNotebookDemo', () => {
  const OTHER = '0b7d9f2e-1111-4a2b-8c3d-9e8f7a6b5c4d';
  const demo = (sections: unknown, extra: object = {}): unknown => ({
    kind: 'notebook-demo',
    version: 1,
    sections,
    ...extra
  });

  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it('keeps sections and items in record order', () => {
    const sections = parseNotebookDemo(
      demo(
        [
          {
            title: 'Getting started',
            items: [
              { id: ID, title: 'Query', summary: 'One line' },
              { id: OTHER, title: 'Plot', note: 'ignored' }
            ]
          },
          { title: 'Waves', items: [{ id: OTHER, title: 'Spectra' }] }
        ],
        { owner: 'ignored' }
      )
    );
    expect(sections).toEqual([
      {
        title: 'Getting started',
        items: [
          { id: ID, title: 'Query', summary: 'One line' },
          { id: OTHER, title: 'Plot' }
        ]
      },
      { title: 'Waves', items: [{ id: OTHER, title: 'Spectra' }] }
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('skips items without a record id or a title', () => {
    const sections = parseNotebookDemo(
      demo([
        {
          title: 'Mixed',
          items: [
            { id: '../eidos', title: 'Not a record id' },
            { id: ID, title: '   ' },
            { id: ID },
            'not an item',
            { id: OTHER, title: 'Kept', summary: 42 }
          ]
        }
      ])
    );
    expect(sections).toEqual([
      { title: 'Mixed', items: [{ id: OTHER, title: 'Kept' }] }
    ]);
  });

  it('drops sections with no title or nothing left to list', () => {
    const sections = parseNotebookDemo(
      demo([
        { title: 'Empty', items: [] },
        { title: 'All invalid', items: [{ id: 'x', title: 'y' }] },
        { title: '', items: [{ id: ID, title: 'Untitled section' }] },
        { title: 'No items' }
      ])
    );
    expect(sections).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads nothing from a record of another kind or version, and says so once', () => {
    for (const spec of [
      demo([], { kind: 'workspace' }),
      demo([], { version: 2 }),
      { kind: 'notebook-demo', version: 1, sections: {} },
      null,
      [],
      'notebook-demo'
    ]) {
      warn.mockClear();
      expect(parseNotebookDemo(spec)).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
    }
  });
});

describe('names and paths', () => {
  it('derives the record name from a path', () => {
    expect(nameFromPath('Oceanum/Waves.ipynb')).toBe('Waves');
    expect(nameFromPath('a/b/c.IPYNB')).toBe('c');
    expect(nameFromPath('.ipynb')).toBe('Untitled');
  });

  it('sanitizes names to one path segment', () => {
    expect(sanitizeName('a/b\\c')).toBe('a-b-c');
    expect(sanitizeName('  Waves.ipynb ')).toBe('Waves');
    expect(sanitizeName('..')).toBe('Untitled');
    expect(sanitizeName('   ')).toBe('Untitled');
  });

  it('picks a unique path in the Oceanum folder', () => {
    expect(uniqueNotebookPath('Waves', [])).toBe('Oceanum/Waves.ipynb');
    expect(uniqueNotebookPath('Waves', ['Waves.ipynb'])).toBe(
      'Oceanum/Waves (1).ipynb'
    );
    expect(
      uniqueNotebookPath('Wa/ves', [
        'Wa-ves.ipynb',
        'Wa-ves (1).ipynb',
        'Other.ipynb'
      ])
    ).toBe('Oceanum/Wa-ves (2).ipynb');
  });
});

describe('partitionSummaries', () => {
  const item = (id: string, creator: string | null, modified: string) => ({
    id,
    name: id,
    description: null as string | null,
    creator,
    modified
  });

  it('splits by creator, case-insensitively, newest first', () => {
    const { mine, shared } = partitionSummaries(
      [
        item('a', 'me@example.com', '2026-01-01T00:00:00'),
        item('b', 'other@example.com', '2026-03-01T00:00:00'),
        item('c', 'Me@Example.com', '2026-02-01T00:00:00'),
        item('d', null, '2026-01-02T00:00:00')
      ],
      'me@example.com'
    );
    expect(mine.map(i => i.id)).toEqual(['c', 'a']);
    expect(shared.map(i => i.id)).toEqual(['b', 'd']);
  });

  it('treats everything as shared when there is no email to compare', () => {
    const { mine, shared } = partitionSummaries(
      [item('a', 'me@example.com', '2026-01-01T00:00:00')],
      null
    );
    expect(mine).toEqual([]);
    expect(shared.map(i => i.id)).toEqual(['a']);
  });
});

describe('parseTimestamp', () => {
  it('treats naive timestamps as UTC', () => {
    expect(parseTimestamp('2026-09-12T10:00:00')?.toISOString()).toBe(
      '2026-09-12T10:00:00.000Z'
    );
    expect(parseTimestamp('2026-09-12T10:00:00+02:00')?.toISOString()).toBe(
      '2026-09-12T08:00:00.000Z'
    );
    expect(parseTimestamp('garbage')).toBeNull();
  });
});

describe('isShareableEmail', () => {
  it('accepts plain addresses and refuses glob characters', () => {
    expect(isShareableEmail('b@example.com')).toBe(true);
    expect(isShareableEmail('*@example.com')).toBe(false);
    expect(isShareableEmail('b@exam?le.com')).toBe(false);
    expect(isShareableEmail('b@[example].com')).toBe(false);
    expect(isShareableEmail('not an email')).toBe(false);
    expect(isShareableEmail('')).toBe(false);
  });
});

describe('shareLink', () => {
  it('keeps lab/index.html on a JupyterLite page, from an absolute or path base URL', () => {
    const expected = `https://notebook.example.com/sub/lab/index.html?oceanum-notebook=${ID}`;
    expect(
      shareLink(
        'https://notebook.example.com/sub/',
        'https://notebook.example.com/sub/lab/index.html',
        ID
      )
    ).toBe(expected);
    expect(
      shareLink(
        '/sub/',
        'https://notebook.example.com/sub/lab/index.html?x=1',
        ID
      )
    ).toBe(expected);
  });

  it('links to lab on a JupyterLab server, which serves no index.html', () => {
    expect(
      shareLink('http://localhost:8888/', 'http://localhost:8888/lab', ID)
    ).toBe(`http://localhost:8888/lab?oceanum-notebook=${ID}`);
    expect(
      shareLink(
        'https://hub.example.com/user/me/',
        'https://hub.example.com/user/me/lab/tree/Oceanum/Waves.ipynb',
        ID
      )
    ).toBe(`https://hub.example.com/user/me/lab?oceanum-notebook=${ID}`);
  });
});

describe('withoutTrust', () => {
  function trusted(): INotebookContent {
    const content = notebook();
    content.cells = content.cells.map(cell => ({
      ...cell,
      metadata: { ...cell.metadata, trusted: true, tags: ['keep'] }
    }));
    return content;
  }

  it('removes trusted from every cell and keeps other metadata', () => {
    const cells = withoutTrust(trusted()).cells;

    expect(cells.every(cell => !('trusted' in cell.metadata))).toBe(true);
    expect(
      cells.every(cell => (cell.metadata.tags as string[])[0] === 'keep')
    ).toBe(true);
  });

  it('does not mutate the input', () => {
    const content = trusted();

    withoutTrust(content);

    expect(content.cells[0].metadata.trusted).toBe(true);
  });

  it('is applied when opening a record, so shared outputs render sanitised', () => {
    const content = notebookFromRecord(
      {
        id: ID,
        name: 'n',
        description: null,
        modified: '2026-09-12T10:00:00',
        creator: null,
        spec: trusted() as never
      },
      SPECS
    );

    expect(content.cells.some(cell => 'trusted' in cell.metadata)).toBe(false);
  });

  it('is applied when saving, so other clients never receive a trust claim', () => {
    const result = buildSpecBody(trusted(), 'n.ipynb', SPECS);

    expect(
      result.ok &&
        result.body.spec.cells.some(cell => 'trusted' in cell.metadata)
    ).toBe(false);
  });
});

describe('parseShareEmails', () => {
  it('splits on commas, semicolons, spaces and new lines', () => {
    const raw =
      'a@example.com, b@example.com;c@example.com d@example.com\ne@example.com';
    expect(parseShareEmails(raw)).toEqual({
      emails: [
        'a@example.com',
        'b@example.com',
        'c@example.com',
        'd@example.com',
        'e@example.com'
      ],
      invalid: []
    });
  });

  it('lower-cases addresses, because the store matches the claim case-sensitively', () => {
    expect(parseShareEmails('Alice@Example.COM').emails).toEqual([
      'alice@example.com'
    ]);
  });

  it('removes duplicates, keeping the order first written', () => {
    expect(
      parseShareEmails('b@example.com a@example.com B@example.com').emails
    ).toEqual(['b@example.com', 'a@example.com']);
  });

  it('separates the addresses it cannot grant, reported as they were typed', () => {
    const parsed = parseShareEmails(
      'good@example.com, nope, *@example.com, No@Good'
    );
    expect(parsed.emails).toEqual(['good@example.com']);
    expect(parsed.invalid).toEqual(['nope', '*@example.com', 'No@Good']);
  });

  it('ignores surrounding and repeated separators', () => {
    expect(parseShareEmails('  ,, a@example.com ,,  ')).toEqual({
      emails: ['a@example.com'],
      invalid: []
    });
  });

  it('returns nothing for empty input', () => {
    expect(parseShareEmails('   ')).toEqual({ emails: [], invalid: [] });
  });
});

describe('reportForShareFailures', () => {
  it('keeps the original error for a failed public share, which names nobody', () => {
    // The public grant's entity is '', so a message built from entity names would read
    // "Could not share with ." and lose the real reason.
    expect(reportForShareFailures(1, [''], false)).toEqual({
      kind: 'original'
    });
  });

  it('keeps the original error when the session needs signing in again', () => {
    // Anything synthetic is not a SpecStoreError, so the reporter would not offer
    // sign-in.
    expect(
      reportForShareFailures(3, ['a@example.com', 'b@example.com'], true)
    ).toEqual({ kind: 'original' });
  });

  it('keeps the original error when every grant failed', () => {
    expect(
      reportForShareFailures(2, ['a@example.com', 'b@example.com'], false)
    ).toEqual({ kind: 'original' });
  });

  it('never builds a message that names nobody, even with grants left over', () => {
    // Isolates the unnamed-entity guard: here the all-failed condition does not apply,
    // so only that guard stops the caller describing a failure as "with ".
    expect(reportForShareFailures(2, [''], false)).toEqual({
      kind: 'original'
    });
  });

  it('names the failures when some of them worked', () => {
    expect(reportForShareFailures(3, ['b@example.com'], false)).toEqual({
      kind: 'partial',
      named: ['b@example.com']
    });
  });

  it('ignores an unnamed grant when deciding who to name', () => {
    expect(reportForShareFailures(3, ['', 'b@example.com'], false)).toEqual({
      kind: 'partial',
      named: ['b@example.com']
    });
  });
});

describe('notebookFromUpload', () => {
  const linkedAndTrusted: INotebookContent = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      oceanum: { spec_id: ID, specs_url: SPECS },
      kernelspec: { name: 'python', display_name: 'Python' }
    },
    cells: [
      { cell_type: 'markdown', source: 'hi', metadata: { trusted: true } }
    ]
  };

  it('drops the oceanum link and cell trust, and keeps everything else', () => {
    const content = notebookFromUpload(JSON.stringify(linkedAndTrusted));

    expect(content.metadata).toEqual({
      kernelspec: { name: 'python', display_name: 'Python' }
    });
    expect(content.cells).toEqual([
      { cell_type: 'markdown', source: 'hi', metadata: {} }
    ]);
  });

  it.each([
    ['text that is not JSON', '{'],
    ['a JSON array', '[]'],
    ['nbformat 3', JSON.stringify({ ...linkedAndTrusted, nbformat: 3 })],
    ['no cells', JSON.stringify({ nbformat: 4, metadata: {} })],
    ['no metadata', JSON.stringify({ nbformat: 4, cells: [] })]
  ])('refuses %s, without quoting the file', (_, text) => {
    expect(() => notebookFromUpload(text)).toThrow(/not a Jupyter notebook/);
    try {
      notebookFromUpload(text);
    } catch (error) {
      expect((error as Error).message).not.toContain(text);
    }
  });
});

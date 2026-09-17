import { ISpecSummary, listNotebooks, partitionNotebooks } from '../specStore';

function summary(overrides: Partial<ISpecSummary> = {}): ISpecSummary {
  return {
    id: 'nb-1',
    name: 'Wave analysis',
    description: null,
    modified: '2026-05-17T12:00:00',
    creator: null,
    ...overrides
  };
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as unknown as Response;
}

describe('listNotebooks', () => {
  it('asks the notebook spec type with the token as a bearer credential', async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return response([]);
    }) as unknown as typeof fetch;

    await listNotebooks('https://specs.example.com', 'jwt', fetcher);

    expect(calls[0][0]).toBe('https://specs.example.com/specs/notebook');
    expect((calls[0][1]?.headers as Record<string, string>).Authorization).toBe(
      'Bearer jwt'
    );
  });

  it('tolerates a trailing slash on the service url', async () => {
    const calls: string[] = [];
    const fetcher = (async (url: string) => {
      calls.push(url);
      return response([]);
    }) as unknown as typeof fetch;

    await listNotebooks('https://specs.example.com//', 'jwt', fetcher);

    expect(calls[0]).toBe('https://specs.example.com/specs/notebook');
  });

  it('reports the status rather than returning an empty list', async () => {
    // The store answers a bad or expired token with 400, so silently returning []
    // would look exactly like an account with no notebooks.
    const fetcher = (async () =>
      response({ detail: 'bad' }, 400)) as unknown as typeof fetch;
    await expect(
      listNotebooks('https://specs.example.com', 'jwt', fetcher)
    ).rejects.toThrow('HTTP 400');
  });

  it('rejects a body that is not a list', async () => {
    const fetcher = (async () =>
      response({ detail: 'nope' })) as unknown as typeof fetch;
    await expect(
      listNotebooks('https://specs.example.com', 'jwt', fetcher)
    ).rejects.toThrow('unexpected response');
  });

  it('drops entries that are not summaries rather than rendering undefined', async () => {
    const fetcher = (async () =>
      response([
        summary({ id: 'good' }),
        { id: 'bad' },
        null
      ])) as unknown as typeof fetch;
    const items = await listNotebooks(
      'https://specs.example.com',
      'jwt',
      fetcher
    );
    expect(items.map(item => item.id)).toEqual(['good']);
  });
});

describe('partitionNotebooks', () => {
  it('splits the caller own records from the rest', () => {
    const mine = summary({ id: 'mine', creator: 'dave@oceanum.science' });
    const theirs = summary({ id: 'theirs', creator: null });
    const { mine: own, shared } = partitionNotebooks(
      [mine, theirs],
      'dave@oceanum.science'
    );
    expect(own.map(i => i.id)).toEqual(['mine']);
    expect(shared.map(i => i.id)).toEqual(['theirs']);
  });

  it('compares addresses case-insensitively', () => {
    // The store matches entities as case-sensitive globs, so the claim and the stored
    // creator can differ in case for the same person.
    const { mine } = partitionNotebooks(
      [summary({ creator: 'Dave@Oceanum.Science' })],
      'dave@oceanum.science'
    );
    expect(mine).toHaveLength(1);
  });

  it('treats everything as shared when nobody is signed in', () => {
    const { mine, shared } = partitionNotebooks(
      [summary({ creator: null }), summary({ id: 'b', creator: 'a@b.com' })],
      null
    );
    expect(mine).toEqual([]);
    expect(shared).toHaveLength(2);
  });

  it('orders each group newest first without mutating the input', () => {
    const input = [
      summary({ id: 'old', modified: '2026-01-01T00:00:00' }),
      summary({ id: 'new', modified: '2026-05-17T00:00:00' })
    ];
    expect(partitionNotebooks(input, null).shared.map(i => i.id)).toEqual([
      'new',
      'old'
    ]);
    expect(input.map(i => i.id)).toEqual(['old', 'new']);
  });
});

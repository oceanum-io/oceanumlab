import { runChatLoop, STOPPED, LoopDeps } from '../aiLoop';
import type { OceanumResponse } from '../chatRouter';
import type { ObservedRun } from '../notebookRun';

const code = (content: string) => ({ type: 'code' as const, content });
const reply = (message: string, ...blocks: OceanumResponse['blocks']) => ({
  message,
  blocks
});

/**
 * A fake notebook: `place` records what it was asked to place and reports one
 * ok run per code block, unless a script says a given code should fail.
 */
function fakeDeps(
  first: OceanumResponse,
  observations: OceanumResponse[],
  failing: string[] = []
) {
  const placed: { blocks: string[]; autoRun: boolean; replace: boolean }[] = [];
  const observed: ObservedRun[][] = [];
  const pending = [...observations];

  const deps: LoopDeps = {
    route: async () => ({ response: first, hasCodeCellSelected: true }),
    observe: async (_p, _h, runs) => {
      observed.push(runs.map(r => ({ ...r })));
      const next = pending.shift();
      if (!next) {
        throw new Error('observe called more times than scripted');
      }
      return next;
    },
    place: async (response, opts) => {
      placed.push({
        blocks: response.blocks.map(b => b.content),
        autoRun: opts.autoRun,
        replace: opts.replaceCodeCell
      });
      const runs: ObservedRun[] = opts.autoRun
        ? response.blocks
            .filter(b => b.type === 'code')
            .map(b => ({
              code: b.content,
              status: failing.includes(b.content) ? 'error' : 'ok',
              stdout: `ran ${b.content}`,
              error: failing.includes(b.content) ? 'Boom' : null,
              message: response.message
            }))
        : [];
      return { message: response.message, runs };
    }
  };
  return { deps, placed, observed };
}

const opts = (over: Partial<Parameters<typeof runChatLoop>[3]> = {}) => ({
  autoRunCode: false,
  iterate: false,
  maxRounds: 5,
  signal: new AbortController().signal,
  ...over
});

describe('runChatLoop: the three workflows', () => {
  it('workflow 3: places blocks and does not run them', async () => {
    const { deps, placed, observed } = fakeDeps(
      reply('Here.', code('a()')),
      []
    );

    const text = await runChatLoop('q', [], deps, opts());

    expect(text).toBe('Here.');
    expect(placed).toEqual([
      { blocks: ['a()'], autoRun: false, replace: true }
    ]);
    expect(observed).toEqual([]);
  });

  it('workflow 1: places and runs, but never observes', async () => {
    const { deps, placed, observed } = fakeDeps(
      reply('Here.', code('a()')),
      []
    );

    await runChatLoop('q', [], deps, opts({ autoRunCode: true }));

    expect(placed[0].autoRun).toBe(true);
    expect(observed).toEqual([]);
  });

  it('workflow 2: runs, observes, places the follow-up, and stops when no code comes back', async () => {
    const { deps, placed, observed } = fakeDeps(
      reply('Step one.', code('a()')),
      [reply('Step two.', code('b()')), reply('Done: the peak is in January.')]
    );

    const text = await runChatLoop(
      'q',
      [],
      deps,
      opts({ autoRunCode: true, iterate: true })
    );

    expect(placed.map(p => p.blocks)).toEqual([['a()'], ['b()'], []]);
    // Every observation carries EVERY run so far, with the agent's message
    // attached to the code it explained.
    expect(observed.map(o => o.map(r => r.code))).toEqual([
      ['a()'],
      ['a()', 'b()']
    ]);
    expect(observed[1][0].message).toBe('Step one.');
    expect(observed[1][1].message).toBe('Step two.');
    // The chain reads as its steps, not just the last one.
    expect(text).toBe(
      'Step one.\n\nStep two.\n\nDone: the peak is in January.'
    );
  });

  it('iterate without autoRun is inert', async () => {
    const { deps, observed } = fakeDeps(reply('Here.', code('a()')), []);

    await runChatLoop('q', [], deps, opts({ iterate: true }));

    expect(observed).toEqual([]);
  });

  it('a failed run is observed so the agent can repair it', async () => {
    const { deps, observed } = fakeDeps(
      reply('Try.', code('bad()')),
      [reply('Fixed.', code('good()')), reply('Done.')],
      ['bad()']
    );

    await runChatLoop(
      'q',
      [],
      deps,
      opts({ autoRunCode: true, iterate: true })
    );

    expect(observed[0][0]).toMatchObject({
      code: 'bad()',
      status: 'error',
      error: 'Boom'
    });
    expect(observed[1][1]).toMatchObject({ code: 'good()', status: 'ok' });
  });

  it('a cell that could not run at all ends the loop without observing', async () => {
    const { deps, observed } = fakeDeps(reply('Try.', code('a()')), [
      reply('Again.', code('b()'))
    ]);
    const place = deps.place;
    deps.place = async (response, o) => ({
      ...(await place(response, o)),
      halted: true
    });

    const text = await runChatLoop(
      'q',
      [],
      deps,
      opts({ autoRunCode: true, iterate: true })
    );

    expect(observed).toEqual([]);
    expect(text).toBe('Try.');
  });
});

describe('runChatLoop: limits', () => {
  it('stops at maxRounds even if the agent keeps sending code', async () => {
    const forever = Array.from({ length: 10 }, (_, i) =>
      reply(`More ${i}.`, code(`s${i}()`))
    );
    const { deps, observed } = fakeDeps(reply('Start.', code('s()')), forever);

    await runChatLoop(
      'q',
      [],
      deps,
      opts({ autoRunCode: true, iterate: true, maxRounds: 3 })
    );

    // The cap is on observe requests, checked after each one so the server's
    // own at-cap explanation turn is always requested: 3 observes, then the
    // round they produced is placed and the loop ends.
    expect(observed).toHaveLength(3);
  });

  it('a code-free answer (what the server sends at its cap) ends the loop', async () => {
    const { deps, observed } = fakeDeps(reply('Start.', code('s()')), [
      reply('Capped: here is what happened.')
    ]);

    const text = await runChatLoop(
      'q',
      [],
      deps,
      opts({ autoRunCode: true, iterate: true, maxRounds: 1 })
    );

    expect(observed).toHaveLength(1);
    expect(text).toBe('Start.\n\nCapped: here is what happened.');
  });

  it('Stop between rounds halts the loop and says so', async () => {
    const controller = new AbortController();
    const { deps, observed } = fakeDeps(reply('Start.', code('s()')), [
      reply('More.', code('t()'))
    ]);
    // Abort as soon as the first placement happens.
    const original = deps.place;
    deps.place = async (r, o) => {
      const out = await original(r, o);
      controller.abort();
      return out;
    };

    const text = await runChatLoop(
      'q',
      [],
      deps,
      opts({ autoRunCode: true, iterate: true, signal: controller.signal })
    );

    expect(observed).toEqual([]);
    expect(text).toBe(`Start.\n\n${STOPPED}`);
  });

  it('Stop while an observe request is in flight keeps what was already placed', async () => {
    const controller = new AbortController();
    const { deps, placed } = fakeDeps(reply('Step one.', code('a()')), []);
    // The real router rejects with the fetch AbortError once Stop is pressed.
    deps.observe = async () => {
      controller.abort();
      throw new DOMException('The user aborted a request.', 'AbortError');
    };

    const text = await runChatLoop(
      'q',
      [],
      deps,
      opts({ autoRunCode: true, iterate: true, signal: controller.signal })
    );

    expect(placed).toHaveLength(1);
    expect(text).toBe(`Step one.\n\n${STOPPED}`);
  });

  it('an observe failure that is not a Stop still propagates', async () => {
    const { deps } = fakeDeps(reply('Step one.', code('a()')), []);
    deps.observe = async () => {
      throw new Error('Backend error: 500');
    };

    await expect(
      runChatLoop('q', [], deps, opts({ autoRunCode: true, iterate: true }))
    ).rejects.toThrow('Backend error: 500');
  });

  it('Stop during the first request returns Stopped without placing anything', async () => {
    const controller = new AbortController();
    const { deps, placed } = fakeDeps(reply('Start.', code('s()')), []);
    deps.route = async () => {
      controller.abort();
      return {
        response: reply('Start.', code('s()')),
        hasCodeCellSelected: false
      };
    };

    const text = await runChatLoop(
      'q',
      [],
      deps,
      opts({ signal: controller.signal })
    );

    expect(text).toBe(STOPPED);
    expect(placed).toEqual([]);
  });

  it('Stop that rejects the first request returns Stopped, not an error', async () => {
    const controller = new AbortController();
    const { deps, placed } = fakeDeps(reply('Start.', code('s()')), []);
    deps.route = async () => {
      controller.abort();
      throw new DOMException('The user aborted a request.', 'AbortError');
    };

    const text = await runChatLoop(
      'q',
      [],
      deps,
      opts({ signal: controller.signal })
    );

    expect(text).toBe(STOPPED);
    expect(placed).toEqual([]);
  });
});

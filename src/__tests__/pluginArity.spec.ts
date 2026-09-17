// The kernel bootstrap is inlined by a webpack asset/source rule, which jest has no
// equivalent for; `virtual` stands in for a module jest cannot resolve.
jest.mock('../../kernel/bootstrap.py', () => 'BOOTSTRAP', { virtual: true });

import plugins from '../index';

/**
 * JupyterLab passes `requires` then `optional` to `activate`, positionally, after the
 * application. Omitting a parameter for a dependency you do not use does not skip it —
 * it shifts every later argument along by one, silently handing the wrong object to the
 * wrong parameter. TypeScript cannot see this: `activate` is typed loosely enough that
 * the mismatch compiles, and unit tests that never activate the plugin never notice.
 *
 * This bit exactly once: adding an optional IOceanumAuth to a plugin whose signature
 * had quietly omitted its IStateDB meant `auth` received the state database, and the
 * panel crashed on `auth.userChanged.connect` at application start.
 */
describe('plugin activate signatures', () => {
  it.each(plugins.map(plugin => [plugin.id, plugin] as const))(
    '%s takes one parameter per declared dependency',
    (_id, plugin) => {
      const declared =
        (plugin.requires?.length ?? 0) + (plugin.optional?.length ?? 0);
      // +1 for the JupyterFrontEnd itself.
      expect(plugin.activate.length).toBe(declared + 1);
    }
  );
});

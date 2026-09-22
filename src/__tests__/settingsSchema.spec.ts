import { readFileSync } from 'fs';
import { join } from 'path';

import { ISettingRegistry, SettingRegistry } from '@jupyterlab/settingregistry';

const ID = '@oceanum/oceanumlab:datamesh-connect';
const schema = JSON.parse(
  readFileSync(join(__dirname, '../../schema/datamesh-connect.json'), 'utf8')
) as ISettingRegistry.ISchema;

/** A registry whose stored user settings for the plugin are `user`. */
function registryWith(user: Record<string, unknown>): SettingRegistry {
  const plugin: ISettingRegistry.IPlugin = {
    id: ID,
    data: { user: {}, composite: {} },
    raw: JSON.stringify(user),
    schema,
    version: 'test'
  };
  const connector = {
    fetch: async (): Promise<ISettingRegistry.IPlugin> => plugin,
    list: async () => ({ ids: [ID], values: [plugin] }),
    save: async (): Promise<void> => undefined,
    remove: async (): Promise<void> => undefined
  };
  return new SettingRegistry({ connector: connector as any });
}

/**
 * `datameshUiUrl` and `aiBackendUrl` were user settings until 4.7.1. They are deployment
 * configuration now: a user-editable service address is somewhere to send the user's
 * credential.
 *
 * Taking them out of the schema is not enough on its own, and would have been a breaking
 * release. The schema is `additionalProperties: false`, the registry REJECTS a load whose
 * stored settings fail validation, and these two keys are stored for every
 * notebook.oceanum.io user: until this release that site wrote each environment's addresses
 * into oceanumlab's settings. Every one of them would have lost the whole settings load --
 * the Datamesh token with it.
 */
describe('the datamesh-connect settings schema', () => {
  it('no longer offers the two service addresses as settings', () => {
    expect(Object.keys(schema.properties ?? {})).toEqual([
      'datameshToken',
      'injectToken',
      'autoRunCode',
      'iterate',
      'showExamples'
    ]);
  });

  it('shows the examples unless the user has hidden them', async () => {
    // Settings stored before the switch existed must still load, showing examples.
    const before = await registryWith({ datameshToken: 'a-token' }).load(ID);
    expect(before.get('showExamples').composite).toBe(true);

    const hidden = await registryWith({ showExamples: false }).load(ID);
    expect(hidden.get('showExamples').composite).toBe(false);
  });

  it('still loads settings stored when they were', async () => {
    const registry = registryWith({
      datameshToken: 'a-token',
      datameshUiUrl: 'https://ui.datamesh.oceanum.tech',
      aiBackendUrl: 'https://ai.oceanum.tech'
    });

    const settings = await registry.load(ID);

    expect(settings.get('datameshToken').composite).toBe('a-token');
  });

  it('stays strict about everything else', async () => {
    // Tolerating those two must not turn into tolerating typos.
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const registry = registryWith({ datameshTokn: 'a-typo' });

    await expect(registry.load(ID)).rejects.toBeDefined();
    warn.mockRestore();
  });
});

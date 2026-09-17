import { describe, expect, it } from 'vitest';

import { URL_SETTINGS, urlSettingToWrite } from './oceanumlabUrls';

const PROD = 'https://ui.datamesh.oceanum.io';
const DEV = 'https://ui.datamesh.oceanum.tech';

describe('urlSettingToWrite', () => {
  it("writes the environment's address over oceanumlab's default", () => {
    expect(urlSettingToWrite(DEV, undefined, PROD)).toBe(DEV);
  });

  it('writes nothing when the default is already the environment address', () => {
    expect(urlSettingToWrite(PROD, undefined, PROD)).toBeNull();
    expect(urlSettingToWrite(PROD, undefined, `${PROD}/`)).toBeNull();
  });

  it('keeps an address the user has set, even the default', () => {
    expect(
      urlSettingToWrite(DEV, 'https://ui.example.com', 'https://ui.example.com')
    ).toBeNull();
    expect(urlSettingToWrite(DEV, PROD, PROD)).toBeNull();
    expect(urlSettingToWrite(DEV, '', PROD)).toBeNull();
  });

  it('writes nothing when the environment names no address', () => {
    expect(urlSettingToWrite(undefined, undefined, PROD)).toBeNull();
    expect(urlSettingToWrite('  ', undefined, PROD)).toBeNull();
  });
});

describe('URL_SETTINGS', () => {
  it('maps the Datamesh UI and Oceanum AI addresses to their oceanumlab settings', () => {
    const urls = {
      datamesh: 'https://datamesh.oceanum.tech',
      specs: 'https://specs.oceanum.tech',
      manage: 'https://manage.oceanum.tech',
      datameshUi: DEV,
      ai: 'https://ai.oceanum.tech'
    };
    expect(
      URL_SETTINGS.map(({ setting, url }) => [setting, url(urls)])
    ).toEqual([
      ['datameshUiUrl', DEV],
      ['aiBackendUrl', 'https://ai.oceanum.tech']
    ]);
  });
});

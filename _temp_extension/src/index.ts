import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import { ISettingRegistry } from '@jupyterlab/settingregistry';

import { requestAPI } from './handler';

/**
 * Initialization data for the @oceanum/oceanumlab extension.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: '@oceanum/oceanumlab:plugin',
  description: 'A Jupyterlab extension to interact with the Oceanum.io platform',
  autoStart: true,
  optional: [ISettingRegistry],
  activate: (app: JupyterFrontEnd, settingRegistry: ISettingRegistry | null) => {
    console.log('JupyterLab extension @oceanum/oceanumlab is activated!');

    if (settingRegistry) {
      settingRegistry
        .load(plugin.id)
        .then(settings => {
          console.log('@oceanum/oceanumlab settings loaded:', settings.composite);
        })
        .catch(reason => {
          console.error('Failed to load settings for @oceanum/oceanumlab.', reason);
        });
    }

    requestAPI<any>('get-example')
      .then(data => {
        console.log(data);
      })
      .catch(reason => {
        console.error(
          `The oceanumlab server extension appears to be missing.\n${reason}`
        );
      });
  }
};

export default plugin;

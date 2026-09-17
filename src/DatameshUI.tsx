import React from 'react';
import { ReactWidget } from '@jupyterlab/apputils';
import { datameshUiSrc } from './datameshUiUrl';

export class DatameshUI extends ReactWidget {
  /** `url` is the deployment's Datamesh UI address (the sign-in environment's). */
  constructor(private _url: string) {
    super();
  }

  /** The iframe's window, for telling its messages apart; `null` if none. */
  get frame(): Window | null {
    return this.node.querySelector('iframe')?.contentWindow ?? null;
  }

  render(): React.ReactElement {
    return (
      <iframe
        src={datameshUiSrc(this._url)}
        className="datamesh-iframe"
      ></iframe>
    );
  }
}

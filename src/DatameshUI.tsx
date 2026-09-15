import React from 'react';
import { ReactWidget } from '@jupyterlab/apputils';
import { datameshUiSrc } from './datameshUiUrl';

export class DatameshUI extends ReactWidget {
  /** `url` is the `datameshUiUrl` setting. */
  constructor(private _url: string) {
    super();
  }

  /**
   * Point the panel at the `datameshUiUrl` setting's new value. The iframe
   * reloads only if its address actually changes.
   */
  set url(url: string) {
    this._url = url;
    this.update();
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

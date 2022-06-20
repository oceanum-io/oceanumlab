import React from 'react';
import { ReactWidget } from '@jupyterlab/apputils';

declare const DATAMESH_UI_SERVICE: string;

export class DatameshUI extends ReactWidget {
  render(): React.ReactElement {
    return (
      <iframe
        src={`${DATAMESH_UI_SERVICE}`}
        className="datamesh-iframe"
      ></iframe>
    );
  }
}

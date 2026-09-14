import React from 'react';
import { ReactWidget } from '@jupyterlab/apputils';
import { DATAMESH_UI_SERVICE } from './constants';

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

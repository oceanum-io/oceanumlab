import React, { useState } from 'react';
import { caretDownIcon, caretRightIcon } from '@jupyterlab/ui-components';
import { ArrowBendDownRight } from 'phosphor-react';

import '../style/index.css';
import { IDatasource } from './DatameshWidget';

export interface IDatasourceItemProps {
  datasource: IDatasource;
  insertDatasource: (datasource: IDatasource) => void;
  onMouseDown: (
    e: React.MouseEvent<HTMLSpanElement, MouseEvent>,
    datasource: IDatasource
  ) => void;
}

/**
 * A React component for expandable containers.
 */

export const DatasourceItem: React.FC<IDatasourceItemProps> = ({
  datasource,
  insertDatasource,
  onMouseDown
}) => {
  const [expanded, setExpandedValue] = useState(false);

  const handleToggleExpand = (): void => {
    setExpandedValue(!expanded);
  };

  return (
    <div className={expanded && 'expanded'}>
      <div key={datasource.id} className="datasource-item-title">
        <button
          title={expanded ? 'Hide Details' : 'Show Details'}
          onClick={handleToggleExpand}
          className="datasource-item-expand"
        >
          {expanded ? (
            <caretDownIcon.react
              tag="span"
              elementPosition="center"
              width="20px"
            />
          ) : (
            <caretRightIcon.react
              tag="span"
              elementPosition="center"
              width="20px"
            />
          )}
        </button>
        <span
          title={datasource.description}
          className={
            onMouseDown
              ? 'datasource-item-name'
              : 'datasource-item-name draggable'
          }
          onClick={handleToggleExpand}
          onMouseDown={e => onMouseDown(e, datasource)}
        >
          {datasource.description}
        </span>

        <button
          title="Insert code to load datasource"
          onClick={handleToggleExpand}
          className="datasource-item-action"
        >
          <ArrowBendDownRight
            size={18}
            onClick={e => insertDatasource(datasource)}
          />
        </button>
      </div>
      {expanded && (
        <div className={'datasource-item-details'}>
          <div className="datasource-query-field">
            Datasource id: <span>{datasource.datasource}</span>
          </div>
          {datasource.geofilter && (
            <div className="datasource-query-field">
              Geofilter type:<span>{datasource.geofilter.type}</span>
            </div>
          )}
          {datasource.variables && (
            <div className="datasource-query-field">
              Variables:<span>{datasource.variables.join(',')}</span>
            </div>
          )}
          {datasource.timefilter && (
            <div className="datasource-query-field">
              Timefilter:<span>{datasource.timefilter.times[0]}</span>
              <span>to</span>
              <span>{datasource.timefilter.times[1]}</span>
            </div>
          )}
          {datasource.spatialref && (
            <div className="datasource-query-field">
              Spatial ref:<span>{datasource.spatialref}</span>
            </div>
          )}
          <div>
            <a
              href={`https://oceanum.io/datasets/${datasource.datasource}`}
              target="_blank"
            >
              Datasource details
            </a>
          </div>
        </div>
      )}
    </div>
  );
};

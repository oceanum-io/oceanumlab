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
    <div>
      <div key={datasource.id} className="datasource-title">
        <button
          title={expanded ? 'Hide Details' : 'Show Details'}
          onClick={handleToggleExpand}
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
            onMouseDown ? 'datasource-name' : 'datasource-name draggable'
          }
          onClick={handleToggleExpand}
          onMouseDown={e => onMouseDown(e, datasource)}
        >
          {datasource.description}
        </span>

        <div>
          <ArrowBendDownRight
            size={18}
            onClick={e => insertDatasource(datasource)}
          />
        </div>
      </div>
      {expanded && (
        <div className={'datasource-details'}>
          <div>Datasource id: {datasource.datasource}</div>
          {datasource.geofilter && (
            <div>Geofilter type:{datasource.geofilter.type}</div>
          )}
          {datasource.variables && (
            <div>Variables: {datasource.variables.join(',')}</div>
          )}
          {datasource.timefilter && (
            <div>
              Timefilter:{datasource.timefilter[0]} to{' '}
              {datasource.timefilter[0]}
            </div>
          )}
          {datasource.spatialref && (
            <div>Spatialref:{datasource.spatialref}</div>
          )}
          <div>
            <a
              href={`https://oceanum.io/datasets/${datasource.datasource}`}
              target="_blank"
            >
              Details
            </a>
          </div>
        </div>
      )}
    </div>
  );
};

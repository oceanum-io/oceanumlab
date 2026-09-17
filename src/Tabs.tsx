import * as React from 'react';

export interface ITab {
  /** Stable key, also used as the restored selection value. */
  id: string;
  label: string;
  render: () => React.ReactElement;
}

export interface ITabsProps {
  tabs: readonly ITab[];
  /** Selected tab id. Falls back to the first tab when it names no tab. */
  selected: string;
  onSelect: (id: string) => void;
}

/**
 * A tab strip over a single visible pane.
 *
 * JupyterLab users work from the keyboard, so the strip follows the WAI-ARIA tabs
 * pattern: one tab stop for the whole strip, arrows to move between tabs, Home and End
 * to reach the ends.
 *
 * Every pane stays mounted and the inactive ones are hidden. Unmounting would be
 * cheaper, but the AI pane holds the conversation in component state and the Datamesh
 * pane holds a workspace subscription, so switching tabs would silently discard a chat
 * the user is in the middle of.
 */
export function Tabs({
  tabs,
  selected,
  onSelect
}: ITabsProps): React.ReactElement {
  const index = Math.max(
    0,
    tabs.findIndex(tab => tab.id === selected)
  );
  const active = tabs[index];

  const onKeyDown = (event: React.KeyboardEvent): void => {
    const last = tabs.length - 1;
    let next: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      next = index === last ? 0 : index + 1;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      next = index === 0 ? last : index - 1;
    } else if (event.key === 'Home') {
      next = 0;
    } else if (event.key === 'End') {
      next = last;
    }
    if (next === null) {
      return;
    }
    // Otherwise the arrow keys also scroll the panel.
    event.preventDefault();
    onSelect(tabs[next].id);
  };

  return (
    <div className="oceanum-tabs">
      <div
        className="oceanum-tabs-strip"
        role="tablist"
        aria-label="Oceanum.io"
      >
        {tabs.map((tab, i) => (
          <button
            key={tab.id}
            id={`oceanum-tab-${tab.id}`}
            className={
              i === index ? 'oceanum-tab oceanum-tab-selected' : 'oceanum-tab'
            }
            role="tab"
            type="button"
            aria-selected={i === index}
            aria-controls={`oceanum-tabpanel-${tab.id}`}
            // Only the selected tab is in the tab order, so Tab moves past the strip
            // rather than through every tab in it.
            tabIndex={i === index ? 0 : -1}
            onClick={() => onSelect(tab.id)}
            onKeyDown={onKeyDown}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map(tab => (
        <div
          key={tab.id}
          className="oceanum-tabpanel"
          id={`oceanum-tabpanel-${tab.id}`}
          role="tabpanel"
          aria-labelledby={`oceanum-tab-${tab.id}`}
          hidden={tab.id !== active.id}
        >
          {tab.render()}
        </div>
      ))}
    </div>
  );
}

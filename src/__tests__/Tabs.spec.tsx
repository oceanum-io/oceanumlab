import { ReactWidget } from '@jupyterlab/ui-components';
import { Widget } from '@lumino/widgets';
import { readFileSync } from 'fs';
import { join } from 'path';
import React from 'react';

import { ITab, Tabs } from '../Tabs';

/** A widget whose sole job is to render the tab strip so the DOM can be inspected. */
class Harness extends ReactWidget {
  selected = 'one';
  readonly selections: string[] = [];

  constructor(private readonly _tabs: ITab[]) {
    super();
  }

  render(): React.ReactElement {
    return (
      <Tabs
        tabs={this._tabs}
        selected={this.selected}
        onSelect={id => {
          this.selections.push(id);
          this.selected = id;
          this.update();
        }}
      />
    );
  }
}

const TABS: ITab[] = [
  { id: 'one', label: 'One', render: () => <p>first pane</p> },
  { id: 'two', label: 'Two', render: () => <p>second pane</p> },
  { id: 'three', label: 'Three', render: () => <p>third pane</p> }
];

async function mount(): Promise<Harness> {
  const widget = new Harness(TABS);
  Widget.attach(widget, document.body);
  // ReactWidget renders on an animation frame.
  await new Promise(resolve => setTimeout(resolve, 50));
  return widget;
}

function strip(widget: Harness): HTMLElement[] {
  return Array.from(widget.node.querySelectorAll<HTMLElement>('[role="tab"]'));
}

function panels(widget: Harness): HTMLElement[] {
  return Array.from(
    widget.node.querySelectorAll<HTMLElement>('[role="tabpanel"]')
  );
}

describe('Tabs', () => {
  it('marks only the selected tab, and puts only it in the tab order', async () => {
    const widget = await mount();
    const tabs = strip(widget);

    expect(tabs.map(t => t.textContent)).toEqual(['One', 'Two', 'Three']);
    expect(tabs.map(t => t.getAttribute('aria-selected'))).toEqual([
      'true',
      'false',
      'false'
    ]);
    // A single tab stop for the strip: Tab moves past it, arrows move within it.
    expect(tabs.map(t => t.tabIndex)).toEqual([0, -1, -1]);

    widget.dispose();
  });

  it('keeps every pane mounted and hides the inactive ones', async () => {
    // Unmounting would discard the AI conversation whenever the user switches away.
    const widget = await mount();
    const rendered = panels(widget);

    expect(rendered).toHaveLength(3);
    expect(rendered.map(p => p.hidden)).toEqual([false, true, true]);
    expect(widget.node.textContent).toContain('second pane');

    widget.dispose();
  });

  it('the stylesheet actually hides them', async () => {
    // `hidden` is only a hint: an author `display` on .oceanum-tabpanel overrides the
    // user agent's `[hidden] { display: none }`, and asserting the IDL property above
    // cannot see that. This renders the real stylesheet and asks for the computed value.
    const css = readFileSync(
      join(__dirname, '..', '..', 'style', 'index.css'),
      'utf8'
    );
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    const widget = await mount();
    const [active, inactive] = panels(widget);
    expect(getComputedStyle(active).display).not.toBe('none');
    expect(getComputedStyle(inactive).display).toBe('none');

    widget.dispose();
    style.remove();
  });

  it('moves with the arrow keys, wrapping at both ends', async () => {
    const widget = await mount();
    // ReactWidget re-renders on an animation frame, so each key has to land on the
    // render that the previous one produced.
    const settle = (): Promise<void> =>
      new Promise(resolve => setTimeout(resolve, 50));

    strip(widget)[0].dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })
    );
    expect(widget.selections.pop()).toBe('two');
    await settle();

    strip(widget)[1].dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })
    );
    expect(widget.selections.pop()).toBe('one');
    await settle();

    // Wrapping: left from the first tab reaches the last.
    strip(widget)[0].dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })
    );
    expect(widget.selections.pop()).toBe('three');

    widget.dispose();
  });

  it('jumps to the ends with Home and End', async () => {
    const widget = await mount();

    strip(widget)[0].dispatchEvent(
      new KeyboardEvent('keydown', { key: 'End', bubbles: true })
    );
    expect(widget.selections.pop()).toBe('three');

    widget.dispose();
  });

  it('falls back to the first tab when the selection names no tab', async () => {
    const widget = new Harness(TABS);
    widget.selected = 'gone';
    Widget.attach(widget, document.body);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(strip(widget)[0].getAttribute('aria-selected')).toBe('true');

    widget.dispose();
  });
});

import { Clipboard, Dialog } from '@jupyterlab/apputils';
import { Widget } from '@lumino/widgets';

import type { PermissionGrant, ShareChoice } from './client';
import { ISpecSummary, parseShareEmails, parseTimestamp } from './notebook';

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) {
    // Names and emails come from other users: always set text, never HTML.
    node.textContent = text;
  }
  return node;
}

/** Dialog body listing notebooks to open; its value is the selected record id. */
export class NotebookListBody
  extends Widget
  implements Dialog.IBodyWidget<string | null>
{
  constructor(mine: readonly ISpecSummary[], shared: readonly ISpecSummary[]) {
    super();
    this.addClass('jp-OceanumShare-body');
    this._addSection('My notebooks', mine, false);
    this._addSection('Shared with me', shared, true);
  }

  getValue(): string | null {
    return this._selected;
  }

  private _addSection(
    title: string,
    items: readonly ISpecSummary[],
    showCreator: boolean
  ): void {
    this.node.appendChild(element('h3', 'jp-OceanumShare-heading', title));
    if (items.length === 0) {
      this.node.appendChild(element('p', 'jp-OceanumShare-empty', 'None'));
      return;
    }
    const list = element('ul', 'jp-OceanumShare-list');
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', title);
    for (const item of items) {
      const option = element('li', 'jp-OceanumShare-item');
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', 'false');
      option.tabIndex = 0;
      option.appendChild(element('span', 'jp-OceanumShare-name', item.name));
      const modified = parseTimestamp(item.modified);
      const details = [
        modified ? `Modified ${modified.toLocaleDateString()}` : '',
        showCreator && item.creator ? item.creator : ''
      ].filter(Boolean);
      option.appendChild(
        element('span', 'jp-OceanumShare-meta', details.join(' · '))
      );
      const select = () => this._select(item.id, option);
      option.addEventListener('click', select);
      option.addEventListener('focus', select);
      list.appendChild(option);
    }
    this.node.appendChild(list);
  }

  private _select(id: string, option: HTMLElement): void {
    this._selected = id;
    for (const node of this.node.querySelectorAll('.jp-OceanumShare-item')) {
      const selected = node === option;
      node.classList.toggle('jp-mod-selected', selected);
      node.setAttribute('aria-selected', String(selected));
    }
  }

  private _selected: string | null = null;
}

export const EVERYONE_WARNING =
  'Anyone with the link can read this notebook, including people without an Oceanum ' +
  'account. This cannot be limited to your organisation. Its name and your email ' +
  'address also become visible to anyone who lists Oceanum notebooks.';

const PUBLIC_GRANT: PermissionGrant = {
  type: 'public',
  entity: '',
  permission: 'read'
};

/** Dialog body for sharing; its value is the change to make, or `null` if incomplete. */
export class ShareBody
  extends Widget
  implements Dialog.IBodyWidget<ShareChoice | null>
{
  constructor(link: string) {
    super();
    this.addClass('jp-OceanumShare-body');

    this.node.appendChild(element('h3', 'jp-OceanumShare-heading', 'Link'));
    const row = element('div', 'jp-OceanumShare-linkRow');
    const linkInput = element('input', 'jp-OceanumShare-link');
    linkInput.readOnly = true;
    linkInput.value = link;
    linkInput.setAttribute('aria-label', 'Notebook link');
    const copy = element(
      'button',
      'jp-mod-styled jp-OceanumShare-copy',
      'Copy link'
    );
    copy.type = 'button';
    copy.addEventListener('click', () => {
      Clipboard.copyToSystem(link);
      copy.textContent = 'Copied';
    });
    row.append(linkInput, copy);
    this.node.appendChild(row);
    this.node.appendChild(
      element(
        'p',
        'jp-OceanumShare-hint',
        'The link opens the notebook for anyone it is shared with.'
      )
    );

    this.node.appendChild(
      element('h3', 'jp-OceanumShare-heading', 'Share with')
    );
    const name = `jp-OceanumShare-who-${++ShareBody._count}`;
    this._person = this._radio(name, 'A specific person', true);
    const personRow = element('div', 'jp-OceanumShare-personRow');
    this._email = element('textarea', 'jp-OceanumShare-email');
    this._email.rows = 2;
    this._email.placeholder = 'name@example.com, another@example.com';
    this._email.setAttribute('aria-label', 'Email addresses');
    this._level = element('select', 'jp-OceanumShare-level');
    this._level.setAttribute('aria-label', 'Access');
    for (const [value, label] of [
      ['read', 'can view'],
      ['write', 'can edit']
    ]) {
      const option = element('option', '', label);
      option.value = value;
      this._level.appendChild(option);
    }
    personRow.append(this._email, this._level);
    this.node.appendChild(personRow);
    this.node.appendChild(
      element(
        'p',
        'jp-OceanumShare-hint',
        // Not "new lines": JupyterLab's dialog swallows Enter before it reaches the
        // textarea, so one cannot be typed here. Pasted ones still separate addresses.
        'Separate several addresses with commas or spaces. Everyone you add gets the access chosen here.'
      )
    );

    this._everyone = this._radio(name, 'Everyone with the link', false);
    this.node.appendChild(
      element('p', 'jp-OceanumShare-warning', EVERYONE_WARNING)
    );
    this._stopEveryone = this._radio(name, 'Stop sharing with everyone', false);

    const update = () => {
      this._email.disabled = !this._person.checked;
      this._level.disabled = !this._person.checked;
    };
    for (const radio of [this._person, this._everyone, this._stopEveryone]) {
      radio.addEventListener('change', update);
    }
  }

  getValue(): ShareChoice | null {
    if (this._everyone.checked) {
      return { action: 'grant', grants: [PUBLIC_GRANT], invalid: [] };
    }
    if (this._stopEveryone.checked) {
      return { action: 'revoke', grant: PUBLIC_GRANT };
    }
    const { emails, invalid } = parseShareEmails(this._email.value);
    if (emails.length === 0 && invalid.length === 0) {
      return null;
    }
    const permission = this._level.value === 'write' ? 'write' : 'read';
    return {
      action: 'grant',
      grants: emails.map(entity => ({ type: 'user', entity, permission })),
      invalid
    };
  }

  private _radio(
    name: string,
    text: string,
    checked: boolean
  ): HTMLInputElement {
    const label = element('label', 'jp-OceanumShare-choice');
    const input = element('input', 'jp-OceanumShare-radio');
    input.type = 'radio';
    input.name = name;
    input.checked = checked;
    label.append(input, document.createTextNode(` ${text}`));
    this.node.appendChild(label);
    return input;
  }

  private static _count = 0;
  private readonly _person: HTMLInputElement;
  private readonly _everyone: HTMLInputElement;
  private readonly _stopEveryone: HTMLInputElement;
  private readonly _email: HTMLTextAreaElement;
  private readonly _level: HTMLSelectElement;
}

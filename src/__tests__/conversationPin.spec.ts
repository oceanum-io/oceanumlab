import type { NotebookPanel } from '@jupyterlab/notebook';
import { ConversationPin } from '../conversationPin';

interface IFakePanel {
  isDisposed: boolean;
  title: { label: string };
  content: { name: string };
}

const panel = (label: string): IFakePanel => ({
  isDisposed: false,
  title: { label },
  content: { name: `${label} content` }
});

const asPanel = (p: IFakePanel | null) => p as unknown as NotebookPanel | null;

describe('ConversationPin', () => {
  let activeTab: IFakePanel | null;
  let pin: ConversationPin;

  beforeEach(() => {
    activeTab = null;
    pin = new ConversationPin(() => asPanel(activeTab));
  });

  it('pins the notebook in the active tab when a conversation starts', () => {
    activeTab = panel('a.ipynb');
    expect(pin.start()).toBe('a.ipynb');
    expect(pin.notebook).toBe(activeTab);
  });

  it('pins nothing when the active tab is not a notebook', () => {
    expect(pin.start()).toBeNull();
    expect(pin.notebook).toBeNull();
  });

  it('keeps the pin for the whole conversation, whatever tab is active', () => {
    const a = panel('a.ipynb');
    activeTab = a;
    pin.start();

    activeTab = panel('b.ipynb');
    expect(pin.ensure()).toBe('a.ipynb');
    expect(pin.notebook).toBe(a);
  });

  it('starts an unstarted conversation at its first message', () => {
    activeTab = panel('a.ipynb');
    expect(pin.ensure()).toBe('a.ipynb');
  });

  it('keeps "no notebook" for a conversation started without one', () => {
    // Opening a notebook afterwards does not change this conversation.
    pin.start();
    activeTab = panel('a.ipynb');
    expect(pin.ensure()).toBeNull();
  });

  it('re-pins on New chat', () => {
    activeTab = panel('a.ipynb');
    pin.start();
    activeTab = panel('b.ipynb');
    expect(pin.start()).toBe('b.ipynb');
  });

  it('forgets a notebook that has been closed', () => {
    const a = panel('a.ipynb');
    activeTab = a;
    pin.start();

    a.isDisposed = true;
    activeTab = panel('b.ipynb');
    expect(pin.notebook).toBeNull();
    // Still the same conversation: it does not quietly move to another one.
    expect(pin.ensure()).toBeNull();
  });

  describe('forRequest', () => {
    it('marks the pinned notebook as receiving answers only when it does', () => {
      const a = panel('a.ipynb');
      const b = panel('b.ipynb');
      activeTab = a;
      pin.start();

      expect(pin.forRequest(asPanel(a))).toEqual({
        notebook: a.content,
        receivesAnswers: true
      });
      expect(pin.forRequest(asPanel(b))).toEqual({
        notebook: a.content,
        receivesAnswers: false
      });
      expect(pin.forRequest(null)?.receivesAnswers).toBe(false);
    });

    it('is null when the conversation has no notebook', () => {
      pin.start();
      expect(pin.forRequest(asPanel(panel('a.ipynb')))).toBeNull();
    });
  });
});

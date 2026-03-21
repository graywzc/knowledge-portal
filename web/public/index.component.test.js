/** @jest-environment jsdom */

const fs = require('fs');
const path = require('path');

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeView({ empty = false, withBranch = false, withImage = false } = {}) {
  const layerA = {
    id: 'A',
    parentLayerId: null,
    branchFromMessageId: null,
    messages: empty
      ? []
      : [withImage
        ? { id: 'tg:-100:1', sender: 'self', content: '[media]', contentType: 'image', mediaPath: 'telegram/-100/55/1.jpg', timestamp: 1700000000000 }
        : { id: 'tg:-100:1', sender: 'self', content: 'root msg', timestamp: 1700000000000 }],
    children: withBranch ? [{ layerId: 'B', branchFromMessageId: 'tg:-100:1' }] : [],
  };

  const layers = { A: layerA };
  const tree = { id: 'A', messageCount: layerA.messages.length, children: [] };

  if (withBranch) {
    layers.B = {
      id: 'B',
      parentLayerId: 'A',
      branchFromMessageId: 'tg:-100:1',
      messages: [{ id: 'tg:-100:2', sender: 'other', content: 'branch msg', timestamp: 1700000001000 }],
      children: [],
    };
    tree.children.push({ id: 'B', messageCount: 1, branchFromMessageId: 'tg:-100:1', children: [] });
  }

  return { currentLayerId: 'A', tree, state: { layers } };
}

function buildFetchMock({ view = makeView(), channels = [{ id: '55', name: 'Topic 55' }] } = {}) {
  return jest.fn(async (url, opts = {}) => {
    const u = String(url);

    if (u.endsWith('/api/sources')) return { json: async () => ['telegram'] };
    if (u.endsWith('/api/sources/telegram/channels')) return { json: async () => channels };
    if (u.endsWith('/api/telegram/topics')) {
      return {
        json: async () => [{ id: '55', name: '[V1] Tennis Social Media App', messageCount: 2 }],
      };
    }
    if (u.endsWith('/api/sources/telegram/channels/55/view')) return { json: async () => view };
    if (u.endsWith('/api/telegram/send') && opts.method === 'POST') return { json: async () => ({ ok: true }) };
    if (u.endsWith('/api/telegram/topics/delete') && opts.method === 'POST') return { json: async () => ({ ok: true }) };

    throw new Error(`Unexpected fetch URL: ${u}`);
  });
}

describe('web component behavior (index.html)', () => {
  let html;
  let inlineScript;

  async function boot(opts = {}) {
    document.documentElement.innerHTML = html
      .replace(/<script[^>]*src=[\s\S]*?<\/script>/g, '')
      .replace(/<script>[\s\S]*?<\/script>/g, '');

    window.markdownit = jest.fn(() => {
      const api = {
        disable: () => api,
        set: () => api,
        render: (s) => `<p>${String(s || '')}</p>`,
      };
      return api;
    });
    window.DOMPurify = { sanitize: (s) => s };
    window.fetch = buildFetchMock(opts);

    // Needed because showLayer with back-link focus calls scrollIntoView.
    Element.prototype.scrollIntoView = jest.fn();

    jest.spyOn(window, 'setInterval').mockImplementation(() => 1);

    window.eval(inlineScript);
    await flush();
  }

  beforeAll(() => {
    html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    inlineScript = scripts[scripts.length - 1][1];
  });

  afterEach(() => {
    jest.restoreAllMocks();
    localStorage.clear();
  });

  it('loads source options on init', async () => {
    await boot();
    const sourceSelect = document.getElementById('source-select');
    const options = Array.from(sourceSelect.options).map((o) => o.value);
    expect(options).toContain('telegram');
  });

  it('loads telegram topics and renders selected topic messages', async () => {
    await boot({ view: makeView() });

    const sourceSelect = document.getElementById('source-select');
    sourceSelect.value = 'telegram';
    sourceSelect.dispatchEvent(new Event('change'));
    await flush();
    await flush();

    const topicList = document.getElementById('topic-list');
    expect(topicList.style.display).toBe('block');
    expect(topicList.textContent).toContain('[V1] Tennis Social Media App');

    topicList.querySelector('.tree-node').click();
    await flush();
    await flush();

    expect(document.getElementById('layer-header').textContent).toContain('[V1] Tennis Social Media App');
    const messages = document.querySelectorAll('#messages .msg');
    expect(messages.length).toBe(1);
    expect(messages[0].textContent).toContain('root msg');
  });

  it('loads view when selecting channel from channel dropdown', async () => {
    await boot({ view: makeView() });

    const sourceSelect = document.getElementById('source-select');
    sourceSelect.value = 'telegram';
    sourceSelect.dispatchEvent(new Event('change'));
    await flush();
    await flush();

    const channelSelect = document.getElementById('channel-select');
    channelSelect.value = '55';
    channelSelect.dispatchEvent(new Event('change'));
    await flush();
    await flush();

    expect(document.querySelectorAll('#messages .msg').length).toBe(1);
    expect(window.fetch).toHaveBeenCalledWith(expect.stringContaining('/api/sources/telegram/channels/55/view'), expect.anything());
  });

  it('navigates to child layer via branch badge and can go back via header link', async () => {
    await boot({ view: makeView({ withBranch: true }) });

    const sourceSelect = document.getElementById('source-select');
    sourceSelect.value = 'telegram';
    sourceSelect.dispatchEvent(new Event('change'));
    await flush();
    await flush();

    const channelSelect = document.getElementById('channel-select');
    channelSelect.value = '55';
    channelSelect.dispatchEvent(new Event('change'));
    await flush();
    await flush();

    const badge = document.querySelector('.branch-badge');
    expect(badge).toBeTruthy();
    badge.click();
    await flush();

    expect(document.getElementById('layer-header').textContent).toContain('branch msg');

    const backLink = document.querySelector('#layer-header .back-link');
    expect(backLink).toBeTruthy();
    backLink.click();
    await flush();

    expect(document.getElementById('layer-header').textContent).toContain('[V1] Tennis Social Media App');
  });

  it('supports tree-node click navigation to child layer', async () => {
    await boot({ view: makeView({ withBranch: true }) });

    const sourceSelect = document.getElementById('source-select');
    sourceSelect.value = 'telegram';
    sourceSelect.dispatchEvent(new Event('change'));
    await flush();
    await flush();

    const channelSelect = document.getElementById('channel-select');
    channelSelect.value = '55';
    channelSelect.dispatchEvent(new Event('change'));
    await flush();
    await flush();

    const layerNodes = Array.from(document.querySelectorAll('#tree .tree-node'));
    const bNode = layerNodes.find((n) => n.textContent.includes('branch msg'));
    expect(bNode).toBeTruthy();

    bNode.click();
    await flush();

    expect(document.getElementById('layer-header').textContent).toContain('branch msg');
    expect(document.querySelector('#tree .tree-node.active').textContent).toContain('branch msg');
  });

  it('shows empty state when selected layer has no messages', async () => {
    await boot({ view: makeView({ empty: true }) });

    const sourceSelect = document.getElementById('source-select');
    sourceSelect.value = 'telegram';
    sourceSelect.dispatchEvent(new Event('change'));
    await flush();
    await flush();

    const channelSelect = document.getElementById('channel-select');
    channelSelect.value = '55';
    channelSelect.dispatchEvent(new Event('change'));
    await flush();
    await flush();

    expect(document.getElementById('messages').textContent).toContain('No messages in this layer');
  });

  it('renders image messages when mediaPath exists', async () => {
    await boot({ view: makeView({ withImage: true }) });

    const sourceSelect = document.getElementById('source-select');
    sourceSelect.value = 'telegram';
    sourceSelect.dispatchEvent(new Event('change'));
    await flush();
    await flush();

    const channelSelect = document.getElementById('channel-select');
    channelSelect.value = '55';
    channelSelect.dispatchEvent(new Event('change'));
    await flush();
    await flush();

    const img = document.querySelector('#messages .msg img.media-image');
    expect(img).toBeTruthy();
    expect(img.getAttribute('src')).toContain('/media/telegram/-100/55/1.jpg');
  });

  it('falls back to current layer when saved layer id is stale', async () => {
    localStorage.setItem('kp:lastLayer:telegram:55', 'Z');
    await boot({ view: makeView() });

    const sourceSelect = document.getElementById('source-select');
    sourceSelect.value = 'telegram';
    sourceSelect.dispatchEvent(new Event('change'));
    await flush();
    await flush();

    const channelSelect = document.getElementById('channel-select');
    channelSelect.value = '55';
    channelSelect.dispatchEvent(new Event('change'));
    await flush();
    await flush();

    expect(document.querySelectorAll('#messages .msg').length).toBe(1);
    expect(document.getElementById('layer-header').textContent).toContain('[V1] Tennis Social Media App');
  });

  it('restores valid saved layer from localStorage', async () => {
    localStorage.setItem('kp:lastLayer:telegram:55', 'B');
    await boot({ view: makeView({ withBranch: true }) });

    const sourceSelect = document.getElementById('source-select');
    sourceSelect.value = 'telegram';
    sourceSelect.dispatchEvent(new Event('change'));
    await flush();
    await flush();

    const channelSelect = document.getElementById('channel-select');
    channelSelect.value = '55';
    channelSelect.dispatchEvent(new Event('change'));
    await flush();
    await flush();

    expect(document.getElementById('layer-header').textContent).toContain('branch msg');
    expect(document.querySelector('#tree .tree-node.active').textContent).toContain('branch msg');
  });

  it('anchors non-reply send to selected layer self message instead of topic root', async () => {
    const view = makeView({ withBranch: true });
    view.state.layers.B.messages = [
      { id: 'tg:-100:2001', sender: 'self', content: 'b-self', timestamp: 1700000001000 },
      { id: 'tg:-100:2002', sender: 'other', content: 'b-other', timestamp: 1700000002000 },
    ];

    localStorage.setItem('kp:lastLayer:telegram:55', 'B');
    await boot({ view });

    const sourceSelect = document.getElementById('source-select');
    sourceSelect.value = 'telegram';
    sourceSelect.dispatchEvent(new Event('change'));
    await flush();
    await flush();

    const channelSelect = document.getElementById('channel-select');
    channelSelect.value = '55';
    channelSelect.dispatchEvent(new Event('change'));
    await flush();
    await flush();

    const input = document.getElementById('composer-input');
    input.value = 'hello from B';
    document.getElementById('composer-send').click();
    await flush();
    await flush();

    const sendCall = window.fetch.mock.calls.find(([url, opts]) =>
      String(url).includes('/api/telegram/send') && opts?.method === 'POST');
    expect(sendCall).toBeTruthy();

    const payload = JSON.parse(sendCall[1].body);
    expect(payload.replyToId).toBe(2001);
    expect(payload.text).toBe('hello from B');
  });

  it('supports custom context-menu reply target and cancel', async () => {
    await boot({ view: makeView() });

    const sourceSelect = document.getElementById('source-select');
    sourceSelect.value = 'telegram';
    sourceSelect.dispatchEvent(new Event('change'));
    await flush();
    await flush();

    const channelSelect = document.getElementById('channel-select');
    channelSelect.value = '55';
    channelSelect.dispatchEvent(new Event('change'));
    await flush();
    await flush();

    const msg = document.querySelector('#messages .msg');
    msg.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }));
    await flush();

    document.getElementById('ctx-reply-btn').click();
    await flush();

    expect(document.getElementById('reply-banner').textContent).toContain('Replying to #1');

    const input = document.getElementById('composer-input');
    input.value = 'reply by context menu';
    document.getElementById('composer-send').click();
    await flush();
    await flush();

    const sendCall = window.fetch.mock.calls.find(([url, opts]) =>
      String(url).includes('/api/telegram/send') && opts?.method === 'POST');
    const payload = JSON.parse(sendCall[1].body);
    expect(payload.replyToId).toBe(1);

    expect(document.getElementById('reply-banner').style.display).toBe('none');
  });

  it('sends on Enter and keeps Shift+Enter for newline', async () => {
    await boot({ view: makeView() });

    const sourceSelect = document.getElementById('source-select');
    sourceSelect.value = 'telegram';
    sourceSelect.dispatchEvent(new Event('change'));
    await flush();
    await flush();

    const channelSelect = document.getElementById('channel-select');
    channelSelect.value = '55';
    channelSelect.dispatchEvent(new Event('change'));
    await flush();
    await flush();

    const input = document.getElementById('composer-input');

    input.value = 'line1';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    await flush();

    const sendCallsAfterShiftEnter = window.fetch.mock.calls.filter(([url, opts]) =>
      String(url).includes('/api/telegram/send') && opts?.method === 'POST');
    expect(sendCallsAfterShiftEnter.length).toBe(0);

    input.value = 'send by enter';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    await flush();

    const sendCalls = window.fetch.mock.calls.filter(([url, opts]) =>
      String(url).includes('/api/telegram/send') && opts?.method === 'POST');
    expect(sendCalls.length).toBe(1);
  });

  it('keeps previously expanded tree branches when navigating to another layer', async () => {
    const view = {
      currentLayerId: 'A',
      tree: {
        id: 'A',
        messageCount: 1,
        children: [
          { id: 'B', messageCount: 1, branchFromMessageId: 'tg:-100:1', children: [
            { id: 'D', messageCount: 1, branchFromMessageId: 'tg:-100:2', children: [] },
          ] },
          { id: 'C', messageCount: 1, branchFromMessageId: 'tg:-100:1', children: [] },
        ],
      },
      state: {
        layers: {
          A: { id: 'A', parentLayerId: null, branchFromMessageId: null, messages: [{ id: 'tg:-100:1', sender: 'self', content: 'root', timestamp: 1 }], children: [{ layerId: 'B', branchFromMessageId: 'tg:-100:1' }, { layerId: 'C', branchFromMessageId: 'tg:-100:1' }] },
          B: { id: 'B', parentLayerId: 'A', branchFromMessageId: 'tg:-100:1', messages: [{ id: 'tg:-100:2', sender: 'other', content: 'b', timestamp: 2 }], children: [{ layerId: 'D', branchFromMessageId: 'tg:-100:2' }] },
          C: { id: 'C', parentLayerId: 'A', branchFromMessageId: 'tg:-100:1', messages: [{ id: 'tg:-100:3', sender: 'other', content: 'c', timestamp: 3 }], children: [] },
          D: { id: 'D', parentLayerId: 'B', branchFromMessageId: 'tg:-100:2', messages: [{ id: 'tg:-100:4', sender: 'other', content: 'd', timestamp: 4 }], children: [] },
        },
      },
    };

    await boot({ view });

    const sourceSelect = document.getElementById('source-select');
    sourceSelect.value = 'telegram';
    sourceSelect.dispatchEvent(new Event('change'));
    await flush();
    await flush();

    const channelSelect = document.getElementById('channel-select');
    channelSelect.value = '55';
    channelSelect.dispatchEvent(new Event('change'));
    await flush();
    await flush();

    const bToggle = Array.from(document.querySelectorAll('#tree .tree-node')).find((n) => n.textContent.includes('b')).querySelector('.tree-toggle');
    bToggle.click();
    await flush();

    let layerNodes = Array.from(document.querySelectorAll('#tree .tree-node'));
    const cNode = layerNodes.find((n) => n.textContent.includes('c'));
    cNode.click();
    await flush();

    layerNodes = Array.from(document.querySelectorAll('#tree .tree-node')).map((n) => n.textContent);
    expect(layerNodes.some((t) => t.includes('d'))).toBe(true);
  });

  it('calls topic delete endpoint from topic right-click menu', async () => {
    jest.spyOn(window, 'confirm').mockReturnValue(true);
    await boot({ view: makeView() });

    const topicRow = document.querySelector('#topic-list .tree-node');
    expect(topicRow).toBeTruthy();
    topicRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }));
    await flush();

    document.getElementById('ctx-delete-topic-btn').click();
    await flush();

    const deleteCalls = window.fetch.mock.calls.filter(([url, opts]) =>
      String(url).includes('/api/telegram/topics/delete') && opts?.method === 'POST');
    expect(deleteCalls.length).toBe(1);
  });
});

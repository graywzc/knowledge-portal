/** @jest-environment jsdom */

const fs = require('fs');
const path = require('path');

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeView({ empty = false, withBranch = false, withImage = false } = {}) {
  const layerA = {
    id: 'A',
    parentLayerUuid: null,
    branchFromMessageId: null,
    messages: empty
      ? []
      : [withImage
        ? { id: 'tg:-100:1', sender: 'self', content: '[media]', contentType: 'image', mediaPath: 'telegram/-100/55/1.jpg', timestamp: 1700000000000 }
        : { id: 'tg:-100:1', sender: 'self', content: 'root msg', timestamp: 1700000000000 }],
    children: withBranch ? [{ layerUuid: 'B', branchFromMessageId: 'tg:-100:1' }] : [],
  };

  const layers = { A: layerA };
  const tree = { id: 'A', messageCount: layerA.messages.length, children: [] };

  if (withBranch) {
    layers.B = {
      id: 'B',
      parentLayerUuid: 'A',
      branchFromMessageId: 'tg:-100:1',
      messages: [{ id: 'tg:-100:2', sender: 'other', content: 'branch msg', timestamp: 1700000001000 }],
      children: [],
    };
    tree.children.push({ id: 'B', messageCount: 1, branchFromMessageId: 'tg:-100:1', children: [] });
  }

  return { currentLayerUuid: 'A', tree, state: { layers } };
}

function buildFetchMock({ view = makeView(), channels = [{ id: '55', name: 'Topic 55' }], searchResults = [] } = {}) {
  return jest.fn(async (url, opts = {}) => {
    const u = String(url);

    if (u.endsWith('/api/sources')) return { json: async () => ['telegram'] };
    if (u.endsWith('/api/sources/telegram/channels')) return { json: async () => channels };
    if (u.includes('/api/telegram/topics')) {
      return {
        json: async () => [{ id: '55', chatId: '-1003826585913', topicUUID: 'topic:telegram:-100:55', name: '[V1] Tennis Social Media App', messageCount: 2, deletedAt: null, archived: false }],
      };
    }
    if (u.endsWith('/api/search/topics') && opts.method === 'POST') {
      return {
        json: async () => ({
          query: 'portal',
          total: 1,
          limit: 50,
          offset: 0,
          results: [
            {
              topicUUID: 'topic:telegram:-100:55',
              source: 'telegram',
              title: 'Knowledge Portal',
              createdAt: 1700000000000,
              updatedAt: 1700000001000,
              meta: { chatId: '-1003826585913', topicId: '55' },
            },
          ],
        }),
      };
    }
    if (u.includes('/api/topics/topic%3Atelegram%3A-100%3A55/view') || u.includes('/api/topics/topic:telegram:-100:55/view')) {
      return { json: async () => ({ topic: { topicUUID: 'topic:telegram:-100:55', source: 'telegram', name: '[V1] Tennis Social Media App', locator: { chatId: '-1003826585913', topicId: '55', channel: '55' }, deletedAt: null }, tree: view.tree, currentLayerUuid: view.currentLayerUuid, state: view.state }) };
    }
    if (u.endsWith('/api/sources/telegram/channels/55/view')) return { json: async () => view };
    if (u.includes('/api/layers/status?')) return { json: async () => ({ ok: true, layers: { B: { title: 'Branch Layer', done: false, updatedAt: 1 } } }) };
    if (u.includes('/api/layers/') && u.endsWith('/done') && opts.method === 'POST') return { json: async () => ({ ok: true }) };
    if (u.includes('/api/layers/') && u.endsWith('/title') && opts.method === 'POST') return { json: async () => ({ ok: true, layerUuid: 'B', title: 'Renamed Branch', updatedAt: 2 }) };
    if (u.endsWith('/api/telegram/send') && opts.method === 'POST') return { json: async () => ({ ok: true }) };
    if (u.endsWith('/api/search/messages') && opts.method === 'POST') return { json: async () => ({ source: 'telegram', query: 'root', total: searchResults.length, limit: 50, offset: 0, results: searchResults }) };
    if (u.endsWith('/api/telegram/send-image') && opts.method === 'POST') return { json: async () => ({ ok: true }) };
    if (u.endsWith('/api/telegram/topics/delete') && opts.method === 'POST') return { json: async () => ({ ok: true }) };
    if (u.includes('/api/topics/') && u.endsWith('/delete') && opts.method === 'POST') return { json: async () => ({ ok: true }) };
    if (u.includes('/api/topics/') && u.endsWith('/archive') && opts.method === 'POST') return { json: async () => ({ ok: true }) };

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
    expect(window.fetch).toHaveBeenCalledWith(expect.stringContaining('/api/topics/topic%3Atelegram%3A-100%3A55/view'), expect.anything());
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

    expect(document.getElementById('layer-header').textContent).toContain('Branch Layer');
    expect(document.getElementById('messages').textContent).toContain('branch msg');

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

    const bNode = document.querySelector('#tree .tree-node[data-layer-id="B"]');
    expect(bNode).toBeTruthy();

    bNode.click();
    await flush();

    expect(document.getElementById('layer-header').textContent).toContain('Branch Layer');
    expect(document.querySelector('#tree .tree-node.active').getAttribute('data-layer-id')).toBe('B');
    expect(document.getElementById('messages').textContent).toContain('branch msg');
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

  it('opens lightbox when clicking an inline image', async () => {
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
    img.click();
    await flush();

    const lightbox = document.getElementById('image-lightbox');
    const lightboxImg = document.getElementById('image-lightbox-image');
    expect(lightbox.classList.contains('open')).toBe(true);
    expect(lightbox.getAttribute('aria-hidden')).toBe('false');
    expect(lightboxImg.getAttribute('src')).toContain('/media/telegram/-100/55/1.jpg');
  });

  it('closes lightbox on Escape', async () => {
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
    img.click();
    await flush();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush();

    const lightbox = document.getElementById('image-lightbox');
    const lightboxImg = document.getElementById('image-lightbox-image');
    expect(lightbox.classList.contains('open')).toBe(false);
    expect(lightbox.getAttribute('aria-hidden')).toBe('true');
    expect(lightboxImg.getAttribute('src')).toBe(null);
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

    expect(document.getElementById('layer-header').textContent).toContain('Branch Layer');
    expect(document.querySelector('#tree .tree-node.active').getAttribute('data-layer-id')).toBe('B');
    expect(document.getElementById('messages').textContent).toContain('branch msg');
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

  it('supports custom context-menu reply target, focuses composer, and cancel', async () => {
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
    jest.spyOn(input, 'focus');
    jest.spyOn(input, 'setSelectionRange');
    input.value = 'draft';

    const msg = document.querySelector('#messages .msg');
    msg.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }));
    await flush();

    document.getElementById('ctx-reply-btn').click();
    await flush();

    expect(document.getElementById('reply-banner').textContent).toContain('Replying to #1');
    expect(input.focus).toHaveBeenCalled();
    expect(input.setSelectionRange).toHaveBeenCalledWith(5, 5);

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
    const shiftEnter = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(shiftEnter);
    await flush();

    expect(shiftEnter.defaultPrevented).toBe(false);

    const sendCallsAfterShiftEnter = window.fetch.mock.calls.filter(([url, opts]) =>
      String(url).includes('/api/telegram/send') && opts?.method === 'POST');
    expect(sendCallsAfterShiftEnter.length).toBe(0);

    input.value = 'send by enter';
    const plainEnter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    input.dispatchEvent(plainEnter);
    await flush();
    await flush();

    expect(plainEnter.defaultPrevented).toBe(true);

    const sendCalls = window.fetch.mock.calls.filter(([url, opts]) =>
      String(url).includes('/api/telegram/send') && opts?.method === 'POST');
    expect(sendCalls.length).toBe(1);
  });

  it('keeps previously expanded tree branches when navigating to another layer', async () => {
    const view = {
      currentLayerUuid: 'A',
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
          A: { id: 'A', parentLayerUuid: null, branchFromMessageId: null, messages: [{ id: 'tg:-100:1', sender: 'self', content: 'root', timestamp: 1 }], children: [{ layerUuid: 'B', branchFromMessageId: 'tg:-100:1' }, { layerUuid: 'C', branchFromMessageId: 'tg:-100:1' }] },
          B: { id: 'B', parentLayerUuid: 'A', branchFromMessageId: 'tg:-100:1', messages: [{ id: 'tg:-100:2', sender: 'other', content: 'b', timestamp: 2 }], children: [{ layerUuid: 'D', branchFromMessageId: 'tg:-100:2' }] },
          C: { id: 'C', parentLayerUuid: 'A', branchFromMessageId: 'tg:-100:1', messages: [{ id: 'tg:-100:3', sender: 'other', content: 'c', timestamp: 3 }], children: [] },
          D: { id: 'D', parentLayerUuid: 'B', branchFromMessageId: 'tg:-100:2', messages: [{ id: 'tg:-100:4', sender: 'other', content: 'd', timestamp: 4 }], children: [] },
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

    const bNode = document.querySelector('#tree .tree-node[data-layer-id="B"]');
    const bToggle = bNode.querySelector('.tree-toggle');
    bToggle.click();
    await flush();

    const cNode = document.querySelector('#tree .tree-node[data-layer-id="C"]');
    cNode.click();
    await flush();

    const layerNodeIds = Array.from(document.querySelectorAll('#tree .tree-node')).map((n) => n.getAttribute('data-layer-id'));
    expect(layerNodeIds).toContain('D');
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
      String(url).includes('/api/topics/') && String(url).includes('/delete') && opts?.method === 'POST');
    expect(deleteCalls.length).toBe(1);
  });

  it('shows topic search results from backend and jumps on click', async () => {
    const view = makeView({ withBranch: true });
    await boot({
      view,
      searchResults: [
        {
          locator: { chatId: '-1003826585913', topicId: '55', messageId: '1' },
          snippet: 'older root msg',
          timestamp: 1700000000000,
        },
        {
          locator: { chatId: '-1003826585913', topicId: '55', messageId: '2' },
          snippet: 'newer branch msg',
          timestamp: 1700000001000,
        },
      ],
    });

    const topicRow = document.querySelector('#topic-list .tree-node');
    topicRow.click();
    await flush();
    await flush();

    document.getElementById('topic-search-toggle').click();
    await flush();

    const input = document.getElementById('topic-search-input');
    input.value = 'branch';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    await flush();

    const resultRows = Array.from(document.querySelectorAll('#topic-search-results .topic-search-result'));
    expect(resultRows.length).toBe(2);
    expect(resultRows[0].textContent).toContain('newer branch msg');
    expect(resultRows[1].textContent).toContain('older root msg');
    expect(resultRows[0].querySelector('mark')?.textContent.toLowerCase()).toBe('branch');

    const metaLeft = resultRows[0].querySelector('.topic-search-result-meta-left');
    const metaRight = resultRows[0].querySelector('.topic-search-result-meta-right');
    expect(metaLeft?.textContent).toContain('#2');
    expect(metaRight?.textContent).toContain('Branch Layer');

    resultRows[0].click();
    await flush();

    expect(document.getElementById('layer-header').textContent).toContain('branch msg');
    const highlightedInPage = document.querySelector('#messages .msg mark');
    expect(highlightedInPage?.textContent.toLowerCase()).toBe('branch');

    const searchCall = window.fetch.mock.calls.find(([url, opts]) =>
      String(url).includes('/api/search/messages') && opts?.method === 'POST');
    expect(searchCall).toBeTruthy();
    expect(JSON.parse(searchCall[1].body)).toEqual({
      source: 'telegram',
      query: 'branch',
      scope: {
        chatId: '-1003826585913',
        topicId: '55',
      },
    });
  });

  it('toggles message search panel with command+f when hovering right pane', async () => {
    await boot({ view: makeView() });

    const sourceSelect = document.getElementById('source-select');
    sourceSelect.value = 'telegram';
    sourceSelect.dispatchEvent(new Event('change'));
    await flush();
    await flush();

    const topicRow = document.querySelector('#topic-list .tree-node');
    topicRow.click();
    await flush();
    await flush();

    window.__kpTest.setHoveredPane('right');
    expect(document.body.dataset.hoverPane).toBe('right');

    expect(window.__kpTest.openSearchByHoveredPane()).toBe('right');
    await flush();
    expect(document.getElementById('topic-search-panel').classList.contains('open')).toBe(true);

    expect(window.__kpTest.openSearchByHoveredPane()).toBe('right');
    await flush();
    expect(document.getElementById('topic-search-panel').classList.contains('open')).toBe(false);
  });

  it('toggles topic title search with command+f when hovering left pane', async () => {
    await boot({ view: makeView() });

    document.getElementById('sidebar').dispatchEvent(new Event('mouseenter', { bubbles: true }));
    expect(document.body.dataset.hoverPane).toBe('left');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true, cancelable: true }));
    await flush();

    expect(document.getElementById('topic-title-search-input').style.display).toBe('block');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true, cancelable: true }));
    await flush();

    expect(document.getElementById('topic-title-search-input').style.display).toBe('none');
  });

  it('searches topics by title and opens result by topicUUID', async () => {
    await boot({ view: makeView() });

    document.getElementById('topic-title-search-toggle').click();
    await flush();

    const input = document.getElementById('topic-title-search-input');
    input.value = 'portal';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    await flush();

    const result = document.querySelector('#topic-list .topic-search-result-row');
    expect(result).toBeTruthy();
    expect(result.textContent).toContain('Knowledge Portal');

    result.click();
    await flush();
    await flush();

    expect(window.fetch).toHaveBeenCalledWith(expect.stringContaining('/api/search/topics'), expect.anything());
    expect(window.fetch).toHaveBeenCalledWith(expect.stringContaining('/api/topics/topic%3Atelegram%3A-100%3A55/view'), expect.anything());
  });

  it('shows topic title matches in the topic list area and opens on click', async () => {
    await boot({ view: makeView() });

    document.getElementById('topic-title-search-toggle').click();
    await flush();

    const input = document.getElementById('topic-title-search-input');
    input.value = 'portal';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    await flush();

    const topicList = document.getElementById('topic-list');
    const results = topicList.querySelectorAll('.topic-search-result-row');
    expect(results.length).toBeGreaterThan(0);
    expect(topicList.textContent).toContain('Knowledge Portal');
    expect(topicList.textContent).not.toContain('[V1] Tennis Social Media App');

    results[0].click();
    await flush();
    await flush();

    expect(window.fetch).toHaveBeenCalledWith(expect.stringContaining('/api/topics/topic%3Atelegram%3A-100%3A55/view'), expect.anything());
  });

  it('opens topic title search from the sidebar magnifier button', async () => {
    await boot({ view: makeView() });

    document.getElementById('topic-title-search-toggle').click();
    await flush();

    expect(document.getElementById('topic-title-search-input').style.display).toBe('block');
  });

  it('restores the normal topic list when topic title search is cleared', async () => {
    await boot({ view: makeView() });

    const topicList = document.getElementById('topic-list');
    expect(topicList.textContent).toContain('[V1] Tennis Social Media App');

    document.getElementById('topic-title-search-toggle').click();
    await flush();

    const input = document.getElementById('topic-title-search-input');
    input.value = 'portal';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    await flush();

    expect(topicList.textContent).toContain('Knowledge Portal');
    expect(topicList.textContent).not.toContain('[V1] Tennis Social Media App');

    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    await flush();

    expect(topicList.textContent).toContain('[V1] Tennis Social Media App');
    expect(topicList.querySelector('.topic-search-result-row')).toBeNull();
  });

  it('shows custom layer title from metadata and edits it from layer context menu', async () => {
    jest.spyOn(window, 'prompt').mockReturnValue('Renamed Branch');
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

    expect(document.querySelector('#tree').textContent).toContain('Branch Layer');

    const branchNode = Array.from(document.querySelectorAll('#tree .tree-node')).find((n) => n.textContent.includes('Branch Layer'));
    branchNode.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }));
    await flush();

    document.getElementById('ctx-edit-layer-title-btn').click();
    await flush();
    await flush();

    const titleCalls = window.fetch.mock.calls.filter(([url, opts]) =>
      String(url).includes('/api/layers/B/title') && opts?.method === 'POST');
    expect(titleCalls.length).toBe(1);
    expect(JSON.parse(titleCalls[0][1].body)).toEqual({
      source: 'telegram',
      channel: '55',
      title: 'Renamed Branch',
    });

    expect(document.querySelector('#tree').textContent).toContain('Renamed Branch');
  });

  it('preserves scroll and shows new messages indicator when current layer updates away from bottom', async () => {
    const firstView = makeView();
    const secondView = makeView();
    secondView.state.layers.A.messages.push({ id: 'tg:-100:3', sender: 'other', content: 'new msg', timestamp: 1700000002000 });
    secondView.tree.messageCount = secondView.state.layers.A.messages.length;

    const fetchMock = jest.fn()
      .mockResolvedValueOnce({ json: async () => ['telegram'] })
      .mockResolvedValueOnce({ json: async () => [{ id: '55', chatId: '-1003826585913', topicUUID: 'topic:telegram:-100:55', name: '[V1] Tennis Social Media App', messageCount: 2, deletedAt: null, archived: false }] })
      .mockResolvedValueOnce({ json: async () => firstView })
      .mockResolvedValueOnce({ json: async () => ({ ok: true, layers: {} }) })
      .mockResolvedValueOnce({ json: async () => secondView })
      .mockResolvedValueOnce({ json: async () => ({ ok: true, layers: {} }) });

    document.documentElement.innerHTML = html
      .replace(/<script[^>]*src=[\s\S]*?<\/script>/g, '')
      .replace(/<script>[\s\S]*?<\/script>/g, '');
    window.markdownit = jest.fn(() => { const api = { disable: () => api, set: () => api, render: (s) => `<p>${String(s || '')}</p>` }; return api; });
    window.DOMPurify = { sanitize: (s) => s };
    window.fetch = fetchMock;
    Element.prototype.scrollIntoView = jest.fn();
    jest.spyOn(window, 'setInterval').mockImplementation(() => 1);
    window.eval(inlineScript);
    await flush();

    const topicRow = document.querySelector('#topic-list .tree-node');
    topicRow.click();
    await flush();
    await flush();

    const messages = document.getElementById('messages');
    Object.defineProperty(messages, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(messages, 'clientHeight', { value: 200, configurable: true });
    messages.scrollTop = 100;

    await window.eval('refreshCurrentView()');
    await flush();
    await flush();

    expect(messages.scrollTop).toBe(100);
    expect(document.getElementById('new-messages-indicator').classList.contains('show')).toBe(true);
  });

  it('supports plain j/k for message pane scrolling and ignores composer typing', async () => {
    await boot({ view: makeView() });

    const topicRow = document.querySelector('#topic-list .tree-node');
    topicRow.click();
    await flush();
    await flush();

    const messages = document.getElementById('messages');
    messages.scrollBy = jest.fn();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true }));
    expect(messages.scrollBy).toHaveBeenCalledWith({ top: 120, behavior: 'smooth' });

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true, cancelable: true }));
    expect(messages.scrollBy).toHaveBeenCalledWith({ top: -120, behavior: 'smooth' });

    messages.scrollBy.mockClear();
    const composer = document.getElementById('composer-input');
    composer.focus();
    composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true }));
    expect(messages.scrollBy).not.toHaveBeenCalled();
  });

  it('supports ctrl+j and ctrl+k to move visible layer selection', async () => {
    await boot({ view: makeView({ withBranch: true }) });

    const topicRow = document.querySelector('#topic-list .tree-node');
    topicRow.click();
    await flush();
    await flush();

    expect(document.querySelector('#tree .tree-node.active').getAttribute('data-layer-id')).toBe('A');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, bubbles: true, cancelable: true }));
    await flush();
    expect(document.querySelector('#tree .tree-node.active').getAttribute('data-layer-id')).toBe('B');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
    await flush();
    expect(document.querySelector('#tree .tree-node.active').getAttribute('data-layer-id')).toBe('A');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', metaKey: true, bubbles: true, cancelable: true }));
    await flush();
    expect(document.querySelector('#tree .tree-node.active').getAttribute('data-layer-id')).toBe('A');
  });

  it('keeps ctrl/cmd+j and ctrl/cmd+k working after opening and closing the in-topic search UI', async () => {
    await boot({ view: makeView({ withBranch: true }) });

    const topicRow = document.querySelector('#topic-list .tree-node');
    topicRow.click();
    await flush();
    await flush();

    document.getElementById('topic-search-toggle').click();
    await flush();
    expect(document.getElementById('topic-search-panel').classList.contains('open')).toBe(true);

    document.getElementById('topic-search-close').click();
    await flush();
    expect(document.getElementById('topic-search-panel').classList.contains('open')).toBe(false);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, bubbles: true, cancelable: true }));
    await flush();
    expect(document.querySelector('#tree .tree-node.active').getAttribute('data-layer-id')).toBe('B');
  });

  it('keeps ctrl/cmd+j and ctrl/cmd+k working after opening and closing the sidebar topic search UI', async () => {
    await boot({ view: makeView({ withBranch: true }) });

    const topicRow = document.querySelector('#topic-list .tree-node');
    topicRow.click();
    await flush();
    await flush();

    document.getElementById('topic-title-search-toggle').click();
    await flush();
    expect(document.getElementById('topic-title-search-input').style.display).toBe('block');

    document.getElementById('topic-title-search-toggle').click();
    await flush();
    expect(document.getElementById('topic-title-search-input').style.display).toBe('none');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, bubbles: true, cancelable: true }));
    await flush();
    expect(document.querySelector('#tree .tree-node.active').getAttribute('data-layer-id')).toBe('B');
  });
});

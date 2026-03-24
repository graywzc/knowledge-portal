const assert = require('node:assert');
const { TreeNavigator } = require('./TreeNavigator');

describe('TreeNavigator', () => {
  it('appends messages to root layer when no reply', () => {
    const nav = new TreeNavigator();
    const rootId = nav.getTree().id;
    nav.addMessage({ id: '1', sender: 'self', replyToId: null, content: 'hello', timestamp: 1 });
    nav.addMessage({ id: '2', sender: 'other', replyToId: null, content: 'hi', timestamp: 2 });
    nav.addMessage({ id: '3', sender: 'self', replyToId: null, content: 'ok', timestamp: 3 });

    const layer = nav.getLayer(rootId);
    assert.strictEqual(layer.messages.length, 3);
    assert.strictEqual(nav.getCurrentLayerUuid(), rootId);
  });

  it('branches when replying to other\'s message', () => {
    const nav = new TreeNavigator();
    const rootId = nav.getTree().id;
    nav.addMessage({ id: '1', sender: 'self', replyToId: null, content: 'a1', timestamp: 1 });
    nav.addMessage({ id: '2', sender: 'other', replyToId: null, content: 'a2', timestamp: 2 });
    const result = nav.addMessage({ id: '3', sender: 'self', replyToId: '2', content: 'b1', timestamp: 3 });

    assert.strictEqual(result.action, 'branch');
    const branchId = result.layerUuid;
    assert.strictEqual(nav.getCurrentLayerUuid(), branchId);
    assert.strictEqual(nav.getLayer(branchId).messages.length, 1);
    assert.strictEqual(nav.getLayer(branchId).parentLayerUuid, rootId);
  });

  it('stays in current layer when replying to root anchor from a sub-layer', () => {
    const nav = new TreeNavigator();
    nav.addMessage({ id: '1', sender: 'self', replyToId: null, content: 'a1', timestamp: 1 });
    nav.addMessage({ id: '2', sender: 'other', replyToId: null, content: 'a2', timestamp: 2 });
    const firstBranch = nav.addMessage({ id: '3', sender: 'self', replyToId: '2', content: 'b1', timestamp: 3 });
    const branchId = firstBranch.layerUuid;
    assert.strictEqual(nav.getCurrentLayerUuid(), branchId);

    const result = nav.addMessage({ id: '4', sender: 'self', replyToId: '1', content: 'a3', timestamp: 4 });
    assert.strictEqual(result.action, 'append');
    assert.strictEqual(result.layerUuid, branchId);
    assert.strictEqual(nav.getCurrentLayerUuid(), branchId);
    assert.strictEqual(nav.getLayer(branchId).messages.length, 2);
  });

  it('supports multiple sub-layers from same parent', () => {
    const nav = new TreeNavigator();
    const rootId = nav.getTree().id;
    nav.addMessage({ id: '1', sender: 'other', replyToId: null, content: 'a1', timestamp: 1 });
    nav.addMessage({ id: '2', sender: 'other', replyToId: null, content: 'a2', timestamp: 2 });

    nav.addMessage({ id: '3', sender: 'self', replyToId: null, content: 'a3', timestamp: 3 });

    const b = nav.addMessage({ id: '4', sender: 'self', replyToId: '1', content: 'b1', timestamp: 4 });
    const bId = b.layerUuid;
    assert.strictEqual(nav.getCurrentLayerUuid(), bId);

    nav.addMessage({ id: '5', sender: 'self', replyToId: '3', content: 'a4', timestamp: 5 });
    assert.strictEqual(nav.getCurrentLayerUuid(), rootId);

    const c = nav.addMessage({ id: '6', sender: 'self', replyToId: '2', content: 'c1', timestamp: 6 });
    assert.strictEqual(c.action, 'branch');
    assert.strictEqual(nav.getCurrentLayerUuid(), c.layerUuid);

    const layerA = nav.getLayer(rootId);
    assert.strictEqual(layerA.children.length, 2);
  });

  it('exports and imports state', () => {
    const nav = new TreeNavigator();
    const rootId = nav.getTree().id;
    nav.addMessage({ id: '1', sender: 'self', replyToId: null, content: 'a1', timestamp: 1 });
    nav.addMessage({ id: '2', sender: 'other', replyToId: null, content: 'a2', timestamp: 2 });
    const branch = nav.addMessage({ id: '3', sender: 'self', replyToId: '2', content: 'b1', timestamp: 3 });

    const state = nav.exportState();
    const nav2 = TreeNavigator.fromState(state);

    assert.strictEqual(nav2.getCurrentLayerUuid(), branch.layerUuid);
    assert.strictEqual(nav2.getLayer(rootId).messages.length, 2);
    assert.strictEqual(nav2.getLayer(branch.layerUuid).messages.length, 1);
  });

  it('bot replies stay in the same layer as the replied ask', () => {
    const nav = new TreeNavigator();
    const rootId = nav.getTree().id;
    nav.addMessage({ id: '1', sender: 'self', replyToId: null, content: 'a1', timestamp: 1 });
    nav.addMessage({ id: '2', sender: 'bot', replyToId: '1', content: 'a2', timestamp: 2 });

    assert.strictEqual(nav.getCurrentLayerUuid(), rootId);
    assert.strictEqual(nav.getLayer(rootId).messages.length, 2);
    assert.strictEqual(nav.getLayer(rootId).children.length, 0);
  });

  it('getTree returns correct structure', () => {
    const nav = new TreeNavigator();
    const rootId = nav.getTree().id;
    nav.addMessage({ id: '1', sender: 'other', replyToId: null, content: 'a1', timestamp: 1 });
    const b = nav.addMessage({ id: '2', sender: 'self', replyToId: '1', content: 'b1', timestamp: 2 });

    const tree = nav.getTree();
    assert.strictEqual(tree.id, rootId);
    assert.strictEqual(tree.children.length, 1);
    assert.strictEqual(tree.children[0].id, b.layerUuid);
  });

  it('treats replies to unknown message as append', () => {
    const nav = new TreeNavigator();
    const rootId = nav.getTree().id;
    const out = nav.addMessage({ id: '1', sender: 'self', replyToId: 'missing', content: 'x', timestamp: 1 });
    assert.strictEqual(out.action, 'append');
    assert.strictEqual(out.layerUuid, rootId);
  });

  it('bot root-anchor reply in sub-layer appends in current layer', () => {
    const nav = new TreeNavigator();
    nav.addMessage({ id: 'root', sender: 'self', replyToId: null, content: 'root', timestamp: 1 });
    nav.addMessage({ id: 'other', sender: 'other', replyToId: null, content: 'other', timestamp: 2 });
    const branch = nav.addMessage({ id: 'branch', sender: 'self', replyToId: 'other', content: 'branch', timestamp: 3 });

    const out = nav.addMessage({ id: 'bot', sender: 'bot', replyToId: 'root', content: 'bot', timestamp: 4 });
    assert.strictEqual(out.action, 'append');
    assert.strictEqual(out.layerUuid, branch.layerUuid);
  });

  it('throws for unknown strategy action type', () => {
    const nav = new TreeNavigator({ strategy: { decide: () => ({ type: 'mystery' }) } });
    assert.throws(
      () => nav.addMessage({ id: '1', sender: 'self', replyToId: null, content: 'x', timestamp: 1 }),
      /Unknown action type/
    );
  });

  it('returns null for missing layer and handles missing root in getTree', () => {
    const nav = new TreeNavigator();
    const rootId = nav.getTree().id;
    assert.strictEqual(nav.getLayer('NOPE'), null);
    nav.layers.delete(rootId);
    assert.strictEqual(nav.getTree(), null);
  });
});

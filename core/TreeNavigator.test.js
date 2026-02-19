const { describe, it } = require('node:test');
const assert = require('node:assert');
const { TreeNavigator } = require('./TreeNavigator');

describe('TreeNavigator', () => {
  it('appends messages to root layer when no reply', () => {
    const nav = new TreeNavigator();
    nav.addMessage({ id: '1', sender: 'self', replyToId: null, content: 'hello', timestamp: 1 });
    nav.addMessage({ id: '2', sender: 'other', replyToId: null, content: 'hi', timestamp: 2 });
    nav.addMessage({ id: '3', sender: 'self', replyToId: null, content: 'ok', timestamp: 3 });

    const layer = nav.getLayer('A');
    assert.strictEqual(layer.messages.length, 3);
    assert.strictEqual(nav.getCurrentLayerId(), 'A');
  });

  it('branches when replying to other\'s message', () => {
    const nav = new TreeNavigator();
    // self sends in layer A
    nav.addMessage({ id: '1', sender: 'self', replyToId: null, content: 'a1', timestamp: 1 });
    // other replies in layer A
    nav.addMessage({ id: '2', sender: 'other', replyToId: null, content: 'a2', timestamp: 2 });
    // self replies to other's message → branch to B
    const result = nav.addMessage({ id: '3', sender: 'self', replyToId: '2', content: 'b1', timestamp: 3 });

    assert.strictEqual(result.action, 'branch');
    assert.strictEqual(result.layerId, 'B');
    assert.strictEqual(nav.getCurrentLayerId(), 'B');
    assert.strictEqual(nav.getLayer('B').messages.length, 1);
    assert.strictEqual(nav.getLayer('B').parentLayerId, 'A');
  });

  it('jumps back when replying to own message', () => {
    const nav = new TreeNavigator();
    nav.addMessage({ id: '1', sender: 'self', replyToId: null, content: 'a1', timestamp: 1 });
    nav.addMessage({ id: '2', sender: 'other', replyToId: null, content: 'a2', timestamp: 2 });
    // Branch to B
    nav.addMessage({ id: '3', sender: 'self', replyToId: '2', content: 'b1', timestamp: 3 });
    assert.strictEqual(nav.getCurrentLayerId(), 'B');

    // Jump back to A by replying to own message in A
    const result = nav.addMessage({ id: '4', sender: 'self', replyToId: '1', content: 'a3', timestamp: 4 });
    assert.strictEqual(result.action, 'jump');
    assert.strictEqual(result.layerId, 'A');
    assert.strictEqual(nav.getCurrentLayerId(), 'A');
    assert.strictEqual(nav.getLayer('A').messages.length, 3);
  });

  it('supports multiple sub-layers from same parent', () => {
    const nav = new TreeNavigator();
    nav.addMessage({ id: '1', sender: 'other', replyToId: null, content: 'a1', timestamp: 1 });
    nav.addMessage({ id: '2', sender: 'other', replyToId: null, content: 'a2', timestamp: 2 });

    // self sends in A
    nav.addMessage({ id: '3', sender: 'self', replyToId: null, content: 'a3', timestamp: 3 });

    // Branch from a1 (other's msg) → B
    nav.addMessage({ id: '4', sender: 'self', replyToId: '1', content: 'b1', timestamp: 4 });
    assert.strictEqual(nav.getCurrentLayerId(), 'B');

    // Jump back to A by replying to own msg a3
    nav.addMessage({ id: '5', sender: 'self', replyToId: '3', content: 'a4', timestamp: 5 });
    assert.strictEqual(nav.getCurrentLayerId(), 'A');

    // Branch from a2 (other's msg) → C
    const r2 = nav.addMessage({ id: '6', sender: 'self', replyToId: '2', content: 'c1', timestamp: 6 });
    assert.strictEqual(r2.action, 'branch');
    assert.strictEqual(nav.getCurrentLayerId(), 'C');

    const layerA = nav.getLayer('A');
    assert.strictEqual(layerA.children.length, 2);
  });

  it('exports and imports state', () => {
    const nav = new TreeNavigator();
    nav.addMessage({ id: '1', sender: 'self', replyToId: null, content: 'a1', timestamp: 1 });
    nav.addMessage({ id: '2', sender: 'other', replyToId: null, content: 'a2', timestamp: 2 });
    nav.addMessage({ id: '3', sender: 'self', replyToId: '2', content: 'b1', timestamp: 3 });

    const state = nav.exportState();
    const nav2 = TreeNavigator.fromState(state);

    assert.strictEqual(nav2.getCurrentLayerId(), 'B');
    assert.strictEqual(nav2.getLayer('A').messages.length, 2);
    assert.strictEqual(nav2.getLayer('B').messages.length, 1);
  });

  it('getTree returns correct structure', () => {
    const nav = new TreeNavigator();
    nav.addMessage({ id: '1', sender: 'other', replyToId: null, content: 'a1', timestamp: 1 });
    nav.addMessage({ id: '2', sender: 'self', replyToId: '1', content: 'b1', timestamp: 2 });

    const tree = nav.getTree();
    assert.strictEqual(tree.id, 'A');
    assert.strictEqual(tree.children.length, 1);
    assert.strictEqual(tree.children[0].id, 'B');
  });
});

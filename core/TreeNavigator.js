/**
 * TreeNavigator — core logic for organizing flat chat messages into a tree of layers.
 *
 * This module is pure logic with no UI or persistence dependencies.
 * It can be consumed by any client (web, iOS, CLI, etc.).
 *
 * Concepts:
 * - Layer: a linear sequence of messages (like a sub-conversation)
 * - The root layer is "A"
 * - Layers form a tree: each layer can have child sub-layers branching from specific messages
 *
 * Navigation rules (configurable via Strategy pattern):
 * - Send without reply → append to current layer
 * - Reply to other's message → branch into new sub-layer
 * - Reply to own message → jump back to that layer, append at end
 */

class TreeNavigator {
  /**
   * @param {object} opts
   * @param {NavigationStrategy} opts.strategy - pluggable navigation rules
   */
  constructor(opts = {}) {
    this.strategy = opts.strategy || new DefaultNavigationStrategy();
    this.layers = new Map();       // layerId -> Layer
    this.messageIndex = new Map(); // messageId -> { layerId, position }
    this.layerCounter = 0;
    this.currentLayerId = null;

    // Create root layer
    this._createLayer(null, null);
  }

  _nextLayerLabel() {
    const idx = this.layerCounter++;
    // A, B, C, ..., Z, AA, AB, ...
    let label = '';
    let n = idx;
    do {
      label = String.fromCharCode(65 + (n % 26)) + label;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return label;
  }

  _createLayer(parentLayerId, branchFromMessageId) {
    const id = this._nextLayerLabel();
    const layer = {
      id,
      parentLayerId,
      branchFromMessageId,
      messages: [],
      children: [],  // { layerId, branchFromMessageId }
    };
    this.layers.set(id, layer);
    if (this.currentLayerId === null) {
      this.currentLayerId = id;
    }
    if (parentLayerId) {
      const parent = this.layers.get(parentLayerId);
      parent.children.push({ layerId: id, branchFromMessageId });
    }
    return layer;
  }

  /**
   * Process an incoming message and place it in the correct layer.
   *
   * @param {object} msg
   * @param {string} msg.id - unique message id
   * @param {string} msg.sender - "self" | "other" | "bot"
   * @param {string|null} msg.replyToId - id of message being replied to, or null
   * @param {*} msg.content - message content (opaque to this module)
   * @param {number} msg.timestamp - epoch ms
   * @returns {{ layerId: string, action: string }} - where message was placed and what happened
   */
  addMessage(msg) {
    const action = this.strategy.decide(this, msg);
    let targetLayerId;

    switch (action.type) {
      case 'append': {
        targetLayerId = this.currentLayerId;
        break;
      }
      case 'branch': {
        const newLayer = this._createLayer(action.fromLayerId, msg.replyToId);
        targetLayerId = newLayer.id;
        this.currentLayerId = newLayer.id;
        break;
      }
      case 'jump': {
        targetLayerId = action.toLayerId;
        this.currentLayerId = action.toLayerId;
        break;
      }
      default:
        throw new Error(`Unknown action type: ${action.type}`);
    }

    const layer = this.layers.get(targetLayerId);
    const position = layer.messages.length;
    layer.messages.push({
      id: msg.id,
      sender: msg.sender,
      content: msg.content,
      timestamp: msg.timestamp,
      replyToId: msg.replyToId,
    });
    this.messageIndex.set(msg.id, { layerId: targetLayerId, position });

    return { layerId: targetLayerId, action: action.type };
  }

  /** Get a layer by id */
  getLayer(id) {
    return this.layers.get(id) || null;
  }

  /** Get all layers as a tree structure */
  getTree() {
    const root = this.layers.get('A');
    if (!root) return null;
    return this._buildSubtree(root);
  }

  _buildSubtree(layer) {
    return {
      id: layer.id,
      messageCount: layer.messages.length,
      children: layer.children.map(c => {
        const childLayer = this.layers.get(c.layerId);
        return {
          branchFromMessageId: c.branchFromMessageId,
          ...this._buildSubtree(childLayer),
        };
      }),
    };
  }

  /** Get which layer a message belongs to */
  getMessageLocation(messageId) {
    return this.messageIndex.get(messageId) || null;
  }

  /** Get current layer id */
  getCurrentLayerId() {
    return this.currentLayerId;
  }

  /** Export full state (for persistence) */
  exportState() {
    return {
      layers: Object.fromEntries(this.layers),
      currentLayerId: this.currentLayerId,
      layerCounter: this.layerCounter,
    };
  }

  /** Import state (from persistence) */
  static fromState(state, opts = {}) {
    const nav = new TreeNavigator(opts);
    nav.layers = new Map(Object.entries(state.layers));
    nav.currentLayerId = state.currentLayerId;
    nav.layerCounter = state.layerCounter;
    // Rebuild message index
    nav.messageIndex = new Map();
    for (const [layerId, layer] of nav.layers) {
      layer.messages.forEach((msg, position) => {
        nav.messageIndex.set(msg.id, { layerId, position });
      });
    }
    return nav;
  }
}

/**
 * NavigationStrategy interface:
 *   decide(navigator, msg) → { type: 'append' } | { type: 'branch', fromLayerId } | { type: 'jump', toLayerId }
 */

class DefaultNavigationStrategy {
  /**
   * Default rules:
   * 1. No reply → append to current layer
   * 2. Bot reply → stay in the same layer as the replied-to ask
   * 3. Reply to other's message → branch into new sub-layer
   * 4. Reply to own message → jump back to that layer, append
   */
  decide(navigator, msg) {
    if (!msg.replyToId) {
      return { type: 'append' };
    }

    const loc = navigator.getMessageLocation(msg.replyToId);
    if (!loc) {
      // Reply to unknown message — treat as append
      return { type: 'append' };
    }

    const repliedLayer = navigator.getLayer(loc.layerId);
    const repliedMsg = repliedLayer.messages[loc.position];

    if (msg.sender === 'bot') {
      // Bot answers should stay in the same layer as the ask they reply to.
      return { type: 'jump', toLayerId: loc.layerId };
    }

    if (repliedMsg.sender !== msg.sender) {
      // Reply to other's message → branch
      return { type: 'branch', fromLayerId: loc.layerId };
    } else {
      // Reply to own message → jump back
      return { type: 'jump', toLayerId: loc.layerId };
    }
  }
}

module.exports = { TreeNavigator, DefaultNavigationStrategy };

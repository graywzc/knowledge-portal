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

const crypto = require('crypto');

const LAYER_UUID_NAMESPACE = '6f0e1d9e-7d85-4f7f-9a4d-3f3c2b0ec001';

function uuidToBytes(uuid) {
  const hex = String(uuid).replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error('invalid UUID namespace');
  return Buffer.from(hex, 'hex');
}

function bytesToUuid(buf) {
  const h = buf.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function uuidv5(name, namespace = LAYER_UUID_NAMESPACE) {
  const ns = uuidToBytes(namespace);
  const hash = crypto.createHash('sha1').update(Buffer.concat([ns, Buffer.from(String(name), 'utf8')])).digest();
  const out = Buffer.from(hash.subarray(0, 16));
  out[6] = (out[6] & 0x0f) | 0x50; // version 5
  out[8] = (out[8] & 0x3f) | 0x80; // variant RFC4122
  return bytesToUuid(out);
}

class TreeNavigator {
  /**
   * @param {object} opts
   * @param {NavigationStrategy} opts.strategy - pluggable navigation rules
   */
  constructor(opts = {}) {
    this.strategy = opts.strategy || new DefaultNavigationStrategy();
    this.source = String(opts.source || 'unknown');
    this.channel = String(opts.channel || 'unknown');
    this.rootMessageId = String(opts.rootMessageId || `${this.source}:${this.channel}:root`);
    this.layers = new Map();       // layerUuid(uuid) -> Layer
    this.messageIndex = new Map(); // messageId -> { layerUuid(uuid), position }
    this.layerCounter = 0;         // display label counter only
    this.currentLayerUuid = null;
    this.rootLayerUuid = null;

    // Create root layer
    this.#createRootLayer();
  }

  #nextLayerLabel() {
    const idx = this.layerCounter++;
    let label = '';
    let n = idx;
    do {
      label = String.fromCharCode(65 + (n % 26)) + label;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return label;
  }

  #computeLayerUuidFromFirstMessage(firstMessageId) {
    return uuidv5(String(firstMessageId));
  }

  #createRootLayer() {
    const id = this.#computeLayerUuidFromFirstMessage(this.rootMessageId);
    const layer = {
      id,
      label: this.#nextLayerLabel(),
      firstMessageId: this.rootMessageId,
      parentLayerUuid: null,
      branchFromMessageId: null,
      messages: [],
      children: [],  // { layerUuid, branchFromMessageId }
    };
    this.layers.set(id, layer);
    this.rootLayerUuid = id;
    this.currentLayerUuid = id;
    return layer;
  }

  #createLayer(parentLayerUuid, branchFromMessageId, firstMessageId) {
    const id = this.#computeLayerUuidFromFirstMessage(firstMessageId);
    const layer = {
      id,
      label: this.#nextLayerLabel(),
      firstMessageId: String(firstMessageId),
      parentLayerUuid,
      branchFromMessageId,
      messages: [],
      children: [],  // { layerUuid, branchFromMessageId }
    };
    this.layers.set(id, layer);
    if (parentLayerUuid) {
      const parent = this.layers.get(parentLayerUuid);
      parent.children.push({ layerUuid: id, branchFromMessageId });
    }
    return layer;
  }

  /**
   * Process an incoming message and place it in the correct layer.
   *
   * @param {object} msg
   * @param {string} msg.id - unique message id
   * @param {string} msg.sender - "self" | "other" | "bot"
   * @param {string|null} [msg.parentId] - kp display parent id (preferred)
   * @param {string|null} [msg.replyToId] - legacy alias for parentId
   * @param {number|null} [msg.branched] - 1=force branch, 0=force append, null=infer via strategy
   * @param {*} msg.content - message content (opaque to this module)
   * @param {number} msg.timestamp - epoch ms
   * @returns {{ layerUuid: string, action: string }} - where message was placed and what happened
   */
  addMessage(msg) {
    // parentId is the canonical field; replyToId is the legacy alias
    const parentId = msg.parentId !== undefined ? msg.parentId : (msg.replyToId || null);
    const normalizedMsg = { ...msg, parentId, replyToId: parentId };

    let action;
    if (msg.branched === 1) {
      // Explicit branch: find the layer containing parentId
      const loc = parentId ? this.messageIndex.get(parentId) : null;
      action = { type: 'branch', fromLayerUuid: loc ? loc.layerUuid : this.currentLayerUuid };
    } else if (msg.branched === 0) {
      // Explicit append: follow parentId into its layer without branching
      const loc = parentId ? this.messageIndex.get(parentId) : null;
      if (loc) {
        this.currentLayerUuid = loc.layerUuid;
      }
      action = { type: 'append' };
    } else {
      // branched is null/undefined — fall back to strategy inference
      action = this.strategy.decide(this, normalizedMsg);
    }

    let targetLayerUuid;

    switch (action.type) {
      case 'append': {
        targetLayerUuid = this.currentLayerUuid;
        break;
      }
      case 'branch': {
        const newLayer = this.#createLayer(action.fromLayerUuid, parentId, msg.id);
        targetLayerUuid = newLayer.id;
        this.currentLayerUuid = newLayer.id;
        break;
      }
      case 'jump': {
        targetLayerUuid = action.toLayerUuid;
        this.currentLayerUuid = action.toLayerUuid;
        break;
      }
      default:
        throw new Error(`Unknown action type: ${action.type}`);
    }

    const meta = (typeof msg.meta === 'string') ? (() => { try { return JSON.parse(msg.meta); } catch { return {}; } })() : (msg.meta || {});
    const layer = this.layers.get(targetLayerUuid);
    const position = layer.messages.length;
    layer.messages.push({
      id: msg.id,
      sender: msg.sender,
      content: msg.content,
      chatContent: msg.chatContent ?? null,
      contentType: msg.contentType || 'text',
      mediaPath: msg.mediaPath || meta.media_path || null,
      mediaMime: msg.mediaMime || meta.media_mime || null,
      mediaWidth: Number.isFinite(msg.mediaWidth) ? msg.mediaWidth : (Number.isFinite(meta.media_width) ? meta.media_width : null),
      mediaHeight: Number.isFinite(msg.mediaHeight) ? msg.mediaHeight : (Number.isFinite(meta.media_height) ? meta.media_height : null),
      timestamp: msg.timestamp,
      parentId,
      replyToId: parentId,
      entities: msg.entities || meta.entities || null,
    });
    this.messageIndex.set(msg.id, { layerUuid: targetLayerUuid, position });

    return { layerUuid: targetLayerUuid, action: action.type };
  }

  /** Get a layer by id */
  getLayer(id) {
    return this.layers.get(id) || null;
  }

  /** Get all layers as a tree structure */
  getTree() {
    const root = this.layers.get(this.rootLayerUuid);
    if (!root) return null;
    return this.#buildSubtree(root);
  }

  #buildSubtree(layer) {
    return {
      id: layer.id,
      messageCount: layer.messages.length,
      children: layer.children.map(c => {
        const childLayer = this.layers.get(c.layerUuid);
        return {
          branchFromMessageId: c.branchFromMessageId,
          ...this.#buildSubtree(childLayer),
        };
      }),
    };
  }

  /** Get which layer a message belongs to */
  getMessageLocation(messageId) {
    return this.messageIndex.get(messageId) || null;
  }

  /** Get current layer id */
  getCurrentLayerUuid() {
    return this.currentLayerUuid;
  }

  /** Export full state (for persistence) */
  exportState() {
    return {
      source: this.source,
      channel: this.channel,
      rootMessageId: this.rootMessageId,
      rootLayerUuid: this.rootLayerUuid,
      layers: Object.fromEntries(this.layers),
      currentLayerUuid: this.currentLayerUuid,
      layerCounter: this.layerCounter,
    };
  }

  /** Import state (from persistence) */
  static fromState(state, opts = {}) {
    const nav = new TreeNavigator({
      source: state.source || opts.source,
      channel: state.channel || opts.channel,
      rootMessageId: state.rootMessageId || opts.rootMessageId,
      strategy: opts.strategy,
    });
    nav.layers = new Map(Object.entries(state.layers));
    nav.currentLayerUuid = state.currentLayerUuid;
    nav.layerCounter = state.layerCounter;
    nav.rootLayerUuid = state.rootLayerUuid || nav.rootLayerUuid;
    // Rebuild message index
    nav.messageIndex = new Map();
    for (const [layerUuid, layer] of nav.layers) {
      layer.messages.forEach((msg, position) => {
        nav.messageIndex.set(msg.id, { layerUuid, position });
      });
    }
    return nav;
  }
}

/**
 * NavigationStrategy interface:
 *   decide(navigator, msg) → { type: 'append' } | { type: 'branch', fromLayerUuid } | { type: 'jump', toLayerUuid }
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
    const parentId = msg.parentId !== undefined ? msg.parentId : (msg.replyToId || null);
    if (!parentId) {
      return { type: 'append' };
    }

    const loc = navigator.getMessageLocation(parentId);
    if (!loc) {
      // Reply to unknown message — treat as append
      return { type: 'append' };
    }

    const repliedLayer = navigator.getLayer(loc.layerUuid);
    const repliedMsg = repliedLayer.messages[loc.position];

    const isRootAnchorReply = (loc.layerUuid === navigator.rootLayerUuid && loc.position === 0);

    if (msg.sender === 'bot') {
      // Telegram bots in forum topics often reply to the topic starter/root message
      // even when they are contextually answering the latest message in a sub-layer.
      if (isRootAnchorReply && navigator.currentLayerUuid !== navigator.rootLayerUuid) {
        return { type: 'append' };
      }

      // Otherwise keep bot in the layer of the replied message.
      return { type: 'jump', toLayerUuid: loc.layerUuid };
    }

    if (msg.sender === 'self' && isRootAnchorReply && navigator.currentLayerUuid !== navigator.rootLayerUuid) {
      // Same forum quirk for user asks: replying to topic root is often just
      // a transport-level thread anchor, not intent to jump back to root layer.
      return { type: 'append' };
    }

    if (repliedMsg.sender !== msg.sender) {
      // Reply to other's message → branch
      return { type: 'branch', fromLayerUuid: loc.layerUuid };
    } else {
      // Reply to own message → jump back
      return { type: 'jump', toLayerUuid: loc.layerUuid };
    }
  }
}

module.exports = { TreeNavigator, DefaultNavigationStrategy };

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(path.join(HERE, '..', 'client.js'), 'utf8');

const ReactStub = {
  createElement: (...args) => ({ args }),
  useState: (value) => [value, () => {}],
  useEffect: () => {},
};

function loadPlugin(storage = new Map()) {
  let definition = null;
  const window = {
    __ModuleLoader__: {
      load(value) {
        definition = value;
      },
    },
    localStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      },
      removeItem(key) {
        storage.delete(key);
      },
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const document = {
    body: {},
    documentElement: { lang: 'zh-CN' },
    visibilityState: 'visible',
    addEventListener() {},
    removeEventListener() {},
  };
  const sandbox = {
    window,
    document,
    navigator: { language: 'zh-CN' },
    performance: { now: () => 0 },
    console,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    localStorage: window.localStorage,
  };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);
  assert.ok(definition, 'client module must call __ModuleLoader__.load');
  const module = definition.factory((name) => {
    if (name === 'react') return ReactStub;
    throw new Error(`unexpected require: ${name}`);
  });
  return { module, window, document, storage, definition };
}

function node(tag, options = {}, children = []) {
  const attrs = new Map(Object.entries(options.attrs || {}));
  const element = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    children,
    textContent: options.textContent || '',
    className: options.className || '',
    classList: null,
    disabled: Boolean(options.disabled),
    isConnected: true,
    parentElement: null,
    hasAttribute(name) {
      return attrs.has(name);
    },
    getAttribute(name) {
      return attrs.has(name) ? attrs.get(name) : null;
    },
    getClientRects() {
      return [{ width: 100, height: 20 }];
    },
    getBoundingClientRect() {
      return { top: options.top ?? 0, bottom: (options.top ?? 0) + 20, height: 20, left: 0, right: 100 };
    },
    closest() {
      return null;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  for (const child of children) {
    child.parentElement = element;
  }
  return element;
}

function button(label, options = {}) {
  return node('button', { textContent: label, ...options });
}

test('module metadata and defaults', () => {
  const { module, definition } = loadPlugin();
  const pkg = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));
  assert.equal(definition.id, 'dsh-fast-history');
  assert.equal(module.__internals.VERSION, pkg.version);
  assert.deepEqual(Array.from(module.inject), ['sessions', 'slots', 'locale']);
  assert.deepEqual({ ...module.__internals.normalizeSettings({}) }, {
    enabled: true,
    prefetchPages: 1,
    thresholdPx: 96,
    preloadScreens: 1.5,
  });
  assert.deepEqual({ ...module.__internals.normalizeSettings({
    prefetchPages: null,
    thresholdPx: null,
    preloadScreens: null,
  }) }, {
    enabled: true,
    prefetchPages: 1,
    thresholdPx: 96,
    preloadScreens: 1.5,
  });
  assert.deepEqual({ ...module.__internals.normalizeSettings({
    enabled: false,
    prefetchPages: 99,
    thresholdPx: 1,
    preloadScreens: 99,
  }) }, {
    enabled: false,
    prefetchPages: 2,
    thresholdPx: 32,
    preloadScreens: 2,
  });
  assert.equal(module.__internals.normalizeSettings({ enabled: 'false' }).enabled, false);
  assert.equal(module.__internals.normalizeSettings({ enabled: '0' }).enabled, false);
  assert.equal(module.__internals.normalizeSettings({ enabled: 'true' }).enabled, true);
  assert.equal(module.__internals.normalizeSettings({ enabled: 'garbage' }).enabled, true);
  const { autoMarginPx } = module.__internals;
  assert.equal(autoMarginPx(400, { preloadScreens: 1.5, thresholdPx: 96 }), 600);
  assert.equal(autoMarginPx(400, { preloadScreens: 2, thresholdPx: 96 }), 800);
  assert.equal(autoMarginPx(100, { preloadScreens: 1.5, thresholdPx: 96 }), 150);
  assert.equal(autoMarginPx(0, { preloadScreens: 1.5, thresholdPx: 96 }), 96);
  assert.equal(autoMarginPx(400, {}), 600);
  assert.equal(module.__internals.openWindowAllowed(400), true);
  assert.equal(module.__internals.openWindowAllowed(401), false);
  assert.equal(module.__internals.openWindowAllowed(Number.NaN), false);
});

test('pager text recognizes the official labels only', () => {
  const { module } = loadPlugin();
  const { pagerText } = module.__internals;
  assert.equal(pagerText('加载更早'), true);
  assert.equal(pagerText('加载更多'), true);
  assert.equal(pagerText('Load more'), true);
  assert.equal(pagerText('加载中'), true);
  assert.equal(pagerText('Load earlier'), true);
  assert.equal(pagerText('Loading'), true);
  assert.equal(pagerText('加载更早的消息'), true);
  assert.equal(pagerText('加载历史'), false);
  assert.equal(pagerText('Loading history'), false);
  assert.equal(pagerText('重试'), false);
  assert.equal(pagerText(''), false);
});

test('findPagerButton finds the direct-child pager button inside the flow column', () => {
  const { module } = loadPlugin();
  const { findPagerButton } = module.__internals;
  const pager = button('加载更早');
  const older = node('div', { className: 'EvIC1a_older' }, [pager]);
  const row = node('div', { attrs: { 'data-chat-flow-key': 'row-1' } }, [button('Load earlier')]);
  const flow = node('div', { attrs: { 'data-chat-flow': '' } }, [older, row]);
  assert.equal(findPagerButton(flow), pager);
});

test('findPagerButton ignores unrelated buttons and finds the loading label', () => {
  const { module } = loadPlugin();
  const { findPagerButton } = module.__internals;
  const loading = button('Loading', { disabled: true });
  const older = node('div', { className: 'EvIC1a_older' }, [loading]);
  const error = node('div', { className: 'EvIC1a_openError' }, [button('重试')]);
  const slot = node('div', { attrs: { 'data-slot': 'conversation.chat.flow' } }, [
    node('div', { attrs: { 'data-chat-flow-key': 'row-2' } }, [button('Load earlier')]),
  ]);
  const flow = node('div', { attrs: { 'data-chat-flow': '' } }, [error, older, slot]);
  assert.equal(findPagerButton(flow), loading);
});

test('findPagerButton structural fallback uses the _older wrapper', () => {
  const { module } = loadPlugin();
  const { findPagerButton } = module.__internals;
  const mystery = button('Something unrelated');
  const older = node('div', { className: 'EvIC1a_older' }, [mystery]);
  const flow = node('div', { attrs: { 'data-chat-flow': '' } }, [older]);
  assert.equal(findPagerButton(flow), mystery);
});

test('findPagerButton excludes navigation buttons', () => {
  const { module } = loadPlugin();
  const { findPagerButton } = module.__internals;
  const navButton = button('Load earlier');
  navButton.closest = (selector) => (selector.includes('navigation') ? {} : null);
  const wrapper = node('div', { className: 'EvIC1a_older' }, [navButton]);
  const flow = node('div', { attrs: { 'data-chat-flow': '' } }, [wrapper]);
  assert.equal(findPagerButton(flow), null);
});

test('topVisibleRow returns the first row whose bottom is below the viewport top', () => {
  const { module } = loadPlugin();
  const { topVisibleRow } = module.__internals;
  const above = node('div', { attrs: { 'data-chat-anchor-key': 'above' }, top: -60 });
  const visible = node('div', { attrs: { 'data-chat-anchor-key': 'visible' }, top: 10 });
  const below = node('div', { attrs: { 'data-chat-anchor-key': 'below' }, top: 100 });
  const scroller = node('div', { top: 0 });
  const flow = node('div');
  flow.querySelectorAll = () => [above, visible, below];
  const result = topVisibleRow(scroller, flow);
  assert.equal(result.key, 'visible');
  assert.equal(result.el, visible);
});

test('SettingsStore persists, clamps and notifies', () => {
  const { module, window, storage } = loadPlugin();
  const { SettingsStore } = module.__internals;
  const store = new SettingsStore();
  const seen = [];
  const unsubscribe = store.subscribe((value) => seen.push(value));
  assert.deepEqual({ ...store.get() }, { enabled: true, prefetchPages: 1, thresholdPx: 96, preloadScreens: 1.5 });
  store.update({ prefetchPages: 9, thresholdPx: 1, preloadScreens: 99 });
  assert.deepEqual({ ...store.get() }, { enabled: true, prefetchPages: 2, thresholdPx: 32, preloadScreens: 2 });
  assert.equal(seen.length, 1);
  assert.equal(
    JSON.parse(storage.get('dsh-fast-history.settings.v1')).prefetchPages,
    2,
  );
  unsubscribe();
  store.update({ enabled: false });
  assert.equal(seen.length, 1);
  storage.clear();
  store.onStorage({ key: null });
  assert.deepEqual({ ...store.get() }, {
    enabled: true,
    prefetchPages: 1,
    thresholdPx: 96,
    preloadScreens: 1.5,
  });
  store.dispose();
  assert.equal(window.localStorage.getItem('dsh-fast-history.settings.v1'), null);
});

test('settings row renders without the real slot runtime', () => {
  const { module } = loadPlugin();
  const { SettingsStore, FastHistorySettingsRow } = module.__internals;
  const store = new SettingsStore();
  const element = FastHistorySettingsRow({
    fastHistoryStore: store,
    t: (key) => key,
  });
  assert.equal(element.args[0], 'div');
  const controls = element.args[2];
  assert.ok(Array.isArray(controls));
  store.dispose();
});

test('isEditable and isMobileOverlay guards', () => {
  const { module } = loadPlugin();
  const { isEditable, isMobileOverlay, elementVisible } = module.__internals;
  assert.equal(isEditable(node('textarea')), true);
  assert.equal(isEditable(node('input')), true);
  assert.equal(isEditable(node('div')), false);
  const editable = node('div');
  editable.isContentEditable = true;
  assert.equal(isEditable(editable), true);

  const visible = node('div');
  assert.equal(elementVisible(visible), true);
  const hidden = node('div');
  hidden.closest = (selector) => (selector.includes('inert') ? {} : null);
  assert.equal(elementVisible(hidden), false);
  const ariaHidden = node('div');
  ariaHidden.closest = (selector) => (selector.includes('aria-hidden') ? {} : null);
  assert.equal(elementVisible(ariaHidden), false);
  const detached = node('div');
  detached.isConnected = false;
  assert.equal(elementVisible(detached), false);

  assert.equal(isMobileOverlay({
    documentElement: { classList: { contains: () => true } },
    querySelector: () => null,
  }), true);
  assert.equal(isMobileOverlay({
    documentElement: { classList: { contains: () => false } },
    querySelector: () => null,
  }), false);
  assert.equal(isMobileOverlay({
    documentElement: { classList: { contains: () => false } },
    querySelector: (selector) => (selector === '[data-dsh-mobile-session]' ? {} : null),
  }), true);
});

test('mutation fast-path only rescans for binding markers', () => {
  const { module } = loadPlugin();
  const { mutationMightChangeBinding } = module.__internals;
  const plain = node('div');
  assert.equal(mutationMightChangeBinding({
    type: 'childList',
    addedNodes: [plain],
    removedNodes: [],
  }), false);
  const marker = node('div');
  marker.matches = (selector) => selector.includes('data-chat-flow');
  assert.equal(mutationMightChangeBinding({
    type: 'childList',
    addedNodes: [marker],
    removedNodes: [],
  }), true);
  const wrapper = node('div');
  wrapper.matches = () => false;
  wrapper.querySelector = (selector) => (selector.includes('data-conversation-scroll') ? {} : null);
  assert.equal(mutationMightChangeBinding({
    type: 'childList',
    addedNodes: [wrapper],
    removedNodes: [],
  }), true);
  assert.equal(mutationMightChangeBinding({
    type: 'attributes',
    attributeName: 'inert',
    addedNodes: [],
    removedNodes: [],
  }), true);
});

test('isMobileContext covers phone browsers, not only the native overlay', () => {
  const { module } = loadPlugin();
  const { isMobileContext } = module.__internals;
  const plainDoc = {
    documentElement: { classList: { contains: () => false } },
    querySelector: () => null,
  };
  const plainWin = {
    matchMedia: () => ({ matches: false }),
    navigator: { maxTouchPoints: 0 },
  };
  assert.equal(isMobileContext(plainDoc, plainWin), false);

  const coarseWin = {
    matchMedia: (query) => ({ matches: query === '(pointer: coarse)' }),
    navigator: { maxTouchPoints: 0 },
  };
  assert.equal(isMobileContext(plainDoc, coarseWin), true);

  const narrowWin = {
    matchMedia: (query) => ({ matches: query === '(max-width: 768px)' }),
    navigator: { maxTouchPoints: 0 },
  };
  assert.equal(isMobileContext(plainDoc, narrowWin), true);

  const touchWin = {
    matchMedia: () => ({ matches: false }),
    navigator: { maxTouchPoints: 5 },
  };
  assert.equal(isMobileContext(plainDoc, touchWin), true);

  const overlayDoc = {
    documentElement: { classList: { contains: () => false } },
    querySelector: (selector) => (selector === '.dshm-main' ? {} : null),
  };
  assert.equal(isMobileContext(overlayDoc, plainWin), true);
});

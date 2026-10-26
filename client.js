/**
 * dsh-fast-history — Web Client half.
 *
 * Display-only history loading:
 *   1. the official Session already opens on the tail page;
 *   2. after that page settles, prefetch a small number of older pages in the
 *      background (default: 1);
 *   3. when the reader scrolls into the top zone, drive the official
 *      "Load earlier" pager (or SessionFace.loadOlder() as a fallback).
 *
 * It never sends a prompt, appends a session event, or calls a Host write.
 * The loaded window is presentation state only; the model context is built by
 * the Host from the durable log.
 */
window.__ModuleLoader__.load({
  id: 'dsh-fast-history',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const VERSION = '0.2.5';
    const NS = 'dsh-fast-history';
    const SETTINGS_KEY = 'dsh-fast-history.settings.v1';
    const DEBUG_KEY = 'dsh-fast-history.debug';

    const DEFAULTS = Object.freeze({
      enabled: true,
      prefetchPages: 1,
      thresholdPx: 96,
      preloadScreens: 1.5,
    });

    const COOLDOWN_MS = 400;
    const TAIL_SETTLE_MS = 700;
    const PAGE_TIMEOUT_MS = 8000;
    const PAGE_CALL_TIMEOUT_MS = 10000;
    const PAGE_START_GRACE_MS = 350;
    const PREFETCH_DELAY_MS = 1200;
    const PREFETCH_GAP_MS = 700;
    const FAILURE_BACKOFF_MS = 5000;
    const MAX_OPEN_ENTRIES = 400;
    const MAX_PAGE_ENTRIES = 400;
    const MAX_PREFETCH_ENTRIES = 600;
    const BIND_RETRY_MS = 250;
    const MAX_BIND_RETRIES = 20;
    const WATCHDOG_MS = 10000;
    const WATCHDOG_FALLBACK_MS = 2000;
    const PAGER_CLICK_MAX_PX = 4;
    const CHAIN_GAP_MS = 80;
    const MAX_CHAIN_PAGES = 4;
    const FAST_SCROLL_VELOCITY_PX_PER_MS = 0.75;
    const FAST_SCROLL_DELTA_PX = 20;
    const SCROLL_SETTLE_MS = 140;
    const ANCHOR_RETRY_MS = 120;
    const ANCHOR_RETRY_LIMIT = 6;

    const zh = {
      title: '历史消息加载',
      description: '向上滚动时自动加载更早的消息，并在打开会话后预读少量历史。只影响显示，不改变发送给模型的上下文。',
      prefetch: '预读页数',
      lead: '提前量',
      off: '关闭预读',
      onePage: '1 页',
      twoPages: '2 页',
      oneScreen: '1 屏',
      oneAndHalfScreens: '1.5 屏',
      twoScreens: '2 屏',
      enabled: '自动加载已开启',
      disabled: '自动加载已关闭',
      toggle: '启用历史消息自动加载',
    };

    const en = {
      title: 'History loading',
      description: 'Automatically loads older messages when you scroll up, and prefetches a little history after a session opens. Display only; the model context is unchanged.',
      prefetch: 'Prefetch pages',
      lead: 'Lead',
      off: 'Off',
      onePage: '1 page',
      twoPages: '2 pages',
      oneScreen: '1 screen',
      oneAndHalfScreens: '1.5 screens',
      twoScreens: '2 screens',
      enabled: 'Auto-load is on',
      disabled: 'Auto-load is off',
      toggle: 'Enable automatic history loading',
    };

    // ---------------------------------------------------------------------
    // Small pure helpers (also exposed for tests through __internals).
    // ---------------------------------------------------------------------

    function normalizeEnabled(value) {
      if (value === undefined || value === null) return DEFAULTS.enabled;
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') {
        const v = value.trim().toLowerCase();
        if (v === 'false' || v === '0' || v === 'off' || v === 'no' || v === '') return false;
        if (v === 'true' || v === '1' || v === 'on' || v === 'yes') return true;
        return DEFAULTS.enabled;
      }
      return Boolean(value);
    }

    function normalizeSettings(raw) {
      const src = raw && typeof raw === 'object' ? raw : {};
      const enabled = normalizeEnabled(src.enabled);
      let prefetchPages = Number(src.prefetchPages);
      if (src.prefetchPages === null || !Number.isFinite(prefetchPages)) prefetchPages = DEFAULTS.prefetchPages;
      prefetchPages = Math.max(0, Math.min(2, Math.trunc(prefetchPages)));
      let thresholdPx = Number(src.thresholdPx);
      if (src.thresholdPx === null || !Number.isFinite(thresholdPx)) thresholdPx = DEFAULTS.thresholdPx;
      thresholdPx = Math.max(32, Math.min(400, Math.trunc(thresholdPx)));
      let preloadScreens = Number(src.preloadScreens);
      if (src.preloadScreens === null || !Number.isFinite(preloadScreens)) preloadScreens = DEFAULTS.preloadScreens;
      preloadScreens = Math.round(Math.max(1, Math.min(2, preloadScreens)) * 2) / 2;
      return { enabled, prefetchPages, thresholdPx, preloadScreens };
    }

    /** Distance from the loaded head at which the next page starts loading. */
    function autoMarginPx(clientHeight, settings) {
      const src = settings && typeof settings === 'object' ? settings : {};
      const screens = Number(src.preloadScreens);
      const ratio = Number.isFinite(screens) ? Math.max(0.5, Math.min(3, screens)) : DEFAULTS.preloadScreens;
      const min = Number(src.thresholdPx);
      const minPx = Number.isFinite(min) ? Math.max(32, Math.min(400, min)) : DEFAULTS.thresholdPx;
      return Math.max(minPx, Math.max(0, Number(clientHeight) || 0) * ratio);
    }

    function openWindowAllowed(count) {
      const n = Number(count);
      return Number.isFinite(n) && n >= 0 && n <= MAX_OPEN_ENTRIES;
    }

    function readJson(key) {
      try {
        const raw = window.localStorage.getItem(key);
        if (raw === null || raw === '') return null;
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }

    function writeJson(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch {
        return false;
      }
    }

    function readDebugFlag() {
      try {
        return window.localStorage.getItem(DEBUG_KEY) === '1';
      } catch {
        return false;
      }
    }

    function now() {
      return typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
    }

    function elementVisible(el) {
      if (!el) return false;
      if (el.isConnected === false) return false;
      try {
        // A full-width right panel can leave a conversation mounted but
        // inert/aria-hidden; that must not be bound or prefetched.
        if (typeof el.closest === 'function'
          && el.closest('[hidden],[inert],[aria-hidden="true"]')) return false;
      } catch {
        /* ignore */
      }
      if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0) return false;
      return true;
    }

    /**
     * Child-list mutations from streaming/markdown rows do not change which
     * conversation is bound. Only session roots, scroll containers, chat-flow
     * columns, and observed attributes need a full document scan.
     */
    function mutationMightChangeBinding(record) {
      if (!record) return false;
      if (record.type === 'attributes') return true;
      const lists = [record.addedNodes, record.removedNodes];
      for (const list of lists) {
        if (!list || typeof list.length !== 'number') continue;
        for (const node of Array.from(list)) {
          if (!node || node.nodeType !== 1) continue;
          try {
            if (typeof node.matches === 'function'
              && node.matches('[data-conversation-session],[data-conversation-scroll],[data-chat-flow]')) return true;
            if (typeof node.querySelector === 'function'
              && node.querySelector('[data-conversation-session],[data-conversation-scroll],[data-chat-flow]')) return true;
          } catch {
            /* ignore */
          }
        }
      }
      return false;
    }

    function isEditable(el) {
      if (!el || el.nodeType !== 1) return false;
      if (el.isContentEditable) return true;
      const tag = String(el.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      try {
        return el.closest('[contenteditable="true"]') !== null;
      } catch {
        return false;
      }
    }

    function isMobileOverlay(doc) {
      try {
        if (doc && doc.documentElement && doc.documentElement.classList
          && doc.documentElement.classList.contains('dsh-native-mobile-active')) return true;
        if (doc && doc.querySelector('[data-dsh-mobile-session]')) return true;
        if (doc && doc.querySelector('.dshm-main')) return true;
        if (doc && doc.querySelector('[data-dsh-mobile-frame]')) return true;
        return false;
      } catch {
        return false;
      }
    }

    /**
     * "Mobile" for interaction purposes is broader than the dsh-mobile
     * overlay: a phone browser at a narrow viewport, or any coarse-pointer
     * device, must get the same no-scrollTop-write / longer-chain-gap policy.
     * Otherwise the protections only work inside the native mobile shell.
     */
    function isMobileContext(doc, win) {
      const d = doc || (typeof document === 'undefined' ? null : document);
      const w = win || (typeof window === 'undefined' ? null : window);
      if (isMobileOverlay(d)) return true;
      try {
        if (w && typeof w.matchMedia === 'function') {
          if (w.matchMedia('(pointer: coarse)').matches) return true;
          if (w.matchMedia('(any-pointer: coarse)').matches) return true;
          if (w.matchMedia('(max-width: 768px)').matches) return true;
        }
      } catch {
        /* matchMedia is advisory */
      }
      try {
        if (w && w.navigator && Number(w.navigator.maxTouchPoints) > 0) return true;
      } catch {
        /* navigator is advisory */
      }
      return false;
    }

    function pagerText(raw) {
      const text = String(raw === null || raw === undefined ? '' : raw)
        .replace(/\s+/g, ' ')
        .trim();
      if (text === '' || text.length > 40) return false;
      if (/(加载历史|loading history|加载失败|load failed)/i.test(text)) return false;
      return /(加载更早|加载更多|加载中|load earlier|load older|load more|loading|earlier)/i.test(text);
    }

    function directChildButton(el) {
      if (!el || !el.children) return null;
      for (const child of Array.from(el.children)) {
        if (!child || child.nodeType !== 1) continue;
        const tag = String(child.tagName || '').toUpperCase();
        if (tag === 'BUTTON') return child;
      }
      return null;
    }

    function excludedPager(el) {
      if (!el) return true;
      try {
        if (el.closest('nav,[role="navigation"],[inert],[aria-hidden="true"]')) return true;
      } catch {
        /* ignore */
      }
      return false;
    }

    function classTokens(el) {
      if (!el) return [];
      if (el.classList && typeof el.classList.length === 'number') {
        return Array.from(el.classList);
      }
      const raw = typeof el.className === 'string' ? el.className : '';
      return raw.split(/\s+/).filter(Boolean);
    }

    function findPagerButton(flow) {
      if (!flow || !flow.children) return null;
      const children = Array.from(flow.children);
      for (const child of children) {
        if (!child || child.nodeType !== 1) continue;
        if (child.hasAttribute && (child.hasAttribute('data-chat-flow-key') || child.hasAttribute('data-chat-anchor-key'))) continue;
        const button = directChildButton(child);
        if (button && !excludedPager(button) && pagerText(button.textContent)) return button;
      }
      // Structural fallback: the official pager wrapper is the only direct
      // child of the column whose class ends with "_older".
      for (const child of children) {
        if (!child || child.nodeType !== 1) continue;
        if (!classTokens(child).some((token) => /(^|_)older$/i.test(token))) continue;
        const button = directChildButton(child);
        if (button && !excludedPager(button)) return button;
      }
      return null;
    }

    function topVisibleRow(scroller, flow) {
      if (!scroller || !flow || typeof flow.querySelectorAll !== 'function') return null;
      const top = scroller.getBoundingClientRect().top;
      const rows = flow.querySelectorAll('[data-chat-anchor-key]:not([data-chat-flow-kind="turn-process"])');
      for (const row of rows) {
        if (!row || row.nodeType !== 1) continue;
        if (row.hasAttribute('hidden')) continue;
        try {
          if (row.closest('[hidden]')) continue;
        } catch {
          /* ignore */
        }
        const rect = row.getBoundingClientRect();
        if (rect.height > 0 && rect.bottom > top + 1) {
          return { el: row, key: row.getAttribute('data-chat-anchor-key'), top: rect.top };
        }
      }
      return null;
    }

    function findRowByKey(flow, key) {
      if (!flow || key === null || key === undefined) return null;
      const rows = flow.querySelectorAll('[data-chat-anchor-key]');
      for (const row of rows) {
        if (row.getAttribute('data-chat-anchor-key') === key) return row;
      }
      return null;
    }

    function nearestNestedScroller(target, boundary, win) {
      if (!target || target.nodeType !== 1 || !win || typeof win.getComputedStyle !== 'function') return false;
      let node = target;
      while (node && node !== boundary) {
        if (node.nodeType === 1) {
          try {
            const style = win.getComputedStyle(node);
            const oy = style && style.overflowY;
            if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay')
              && node.scrollHeight > node.clientHeight + 1) return true;
          } catch {
            /* ignore */
          }
        }
        node = node.parentElement;
      }
      return false;
    }

    function withTimeout(promise, ms, label) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error(label || 'timeout'));
        }, ms);
        Promise.resolve(promise).then(
          (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
          },
          (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
          },
        );
      });
    }

    function localeCopy() {
      let lang = '';
      try {
        lang = String(document.documentElement.lang || navigator.language || 'en').toLowerCase();
      } catch {
        lang = 'en';
      }
      return lang.startsWith('zh') ? zh : en;
    }

    function fallbackTranslate(key) {
      const dict = localeCopy();
      return dict[key] === undefined ? key : dict[key];
    }

    // ---------------------------------------------------------------------
    // Settings store (browser-local; no Host config).
    // ---------------------------------------------------------------------

    class SettingsStore {
      constructor() {
        this.value = normalizeSettings(readJson(SETTINGS_KEY));
        this.listeners = new Set();
        this.onStorage = (event) => {
          if (!event || (event.key !== SETTINGS_KEY && event.key !== null)) return;
          this.value = normalizeSettings(readJson(SETTINGS_KEY));
          this.emit();
        };
        try {
          window.addEventListener('storage', this.onStorage);
        } catch {
          /* ignore */
        }
      }

      get() {
        return this.value;
      }

      update(patch) {
        const next = normalizeSettings(Object.assign({}, this.value, patch || {}));
        this.value = next;
        writeJson(SETTINGS_KEY, next);
        this.emit();
        return next;
      }

      subscribe(listener) {
        this.listeners.add(listener);
        return () => {
          this.listeners.delete(listener);
        };
      }

      emit() {
        const value = this.value;
        for (const listener of Array.from(this.listeners)) {
          try {
            listener(value);
          } catch {
            /* a broken listener must not break settings */
          }
        }
      }

      dispose() {
        try {
          window.removeEventListener('storage', this.onStorage);
        } catch {
          /* ignore */
        }
        this.listeners.clear();
      }
    }

    // ---------------------------------------------------------------------
    // History controller.
    // ---------------------------------------------------------------------

    class HistoryController {
      constructor(ctx, store) {
        this.ctx = ctx;
        this.store = store;
        this.settings = store.get();
        this.debug = readDebugFlag();
        this.disposed = false;
        this.started = false;
        this.generation = 0;

        this.observer = null;
        this.rafId = null;
        this.bindRetryTimer = null;
        this.bindRetries = 0;
        this.watchdogTimer = null;
        this.prefetchTimer = null;
        this.prefetchGapTimer = null;
        this.tailCheckTimer = null;
        this.settleTimer = null;
        this.pendingResolve = null;

        this.rootEl = null;
        this.scroller = null;
        this.sessionId = null;
        this.binding = null;
        this.session = null;
        this.eventSource = null;
        this.unsubscribeSession = null;
        this.snapshot = null;

        this.inFlight = false;
        this.inFlightKind = null;
        this.armed = false;
        this.armedKind = null;
        this.lastTop = 0;
        this.lastScrollAt = 0;
        this.lastLoadAt = -COOLDOWN_MS;
        this.failureUntil = 0;
        this.touch = null;
        this.scrollVelocity = 0;
        this.fastScrolling = false;
        this.scrollSettleTimer = null;
        this.scrollSettleDeadline = 0;
        this.pendingLoadAfterSettle = false;
        this.anchorTimer = null;
        this.anchorAttempts = 0;
        this.internalScroll = false;

        this.chainActive = false;
        this.chainCount = 0;
        this.chainTimer = null;

        this.openEntries = null;
        this.prefetchedPages = 0;
        this.prefetchedEntries = 0;
        this.prefetchStopped = false;
        this.lastWindowEntries = null;
        this.wasOpen = false;
        this.carriedPrefetch = null;

        this.stats = {
          sessionId: null,
          gestures: 0,
          autoLoads: 0,
          chainLoads: 0,
          chainCount: 0,
          prefetchLoads: 0,
          failures: 0,
          lastOutcome: null,
          lastLatencyMs: null,
          lastDriftPx: null,
          lastEntriesDelta: null,
          autoMarginPx: null,
          openEntries: null,
          prefetchedPages: 0,
          prefetchedEntries: 0,
          inFlight: false,
          fastScrolling: false,
          pendingLoadAfterSettle: false,
          lastDisarm: null,
          lastDisarmAt: null,
          lastDisarmLastTop: null,
          hasMore: null,
          loadingOlder: null,
          running: null,
        };

        this.onMutate = (records) => {
          if (this.disposed || this.rafId !== null) return;
          if (this.rootEl && records && records.length
            && !records.some(mutationMightChangeBinding)) {
            this.noteTailMarker();
            return;
          }
          const raf = typeof requestAnimationFrame === 'function'
            ? requestAnimationFrame
            : (fn) => setTimeout(fn, 16);
          this.rafId = raf(() => {
            this.rafId = null;
            this.sync();
          });
        };
        this.onVisibility = () => this.handleVisibility();
        this.onStorage = () => this.refreshSettings();
        this.onSettings = () => this.refreshSettings();
        this.onScroll = () => this.handleScroll();
        this.onWheel = (event) => this.handleWheel(event);
        this.onTouchStart = (event) => this.handleTouchStart(event);
        this.onTouchMove = (event) => this.handleTouchMove(event);
        this.onTouchEnd = (event) => this.handleTouchEnd(event);
        this.onTouchCancel = () => this.handleTouchCancel();
        this.onScrollEnd = () => this.handleScrollEnd();
        this.onKeyDown = (event) => this.handleKeyDown(event);
        this.onPagerClick = (event) => this.handlePagerClick(event);
      }

      start() {
        if (this.started || this.disposed) return;
        this.started = true;
        this.settings = this.store.get();
        this.unsubscribeSettings = this.store.subscribe(this.onSettings);
        try {
          document.addEventListener('visibilitychange', this.onVisibility);
        } catch {
          /* ignore */
        }
        try {
          window.addEventListener('storage', this.onStorage);
        } catch {
          /* ignore */
        }
        if (typeof MutationObserver === 'function' && document.body) {
          this.observer = new MutationObserver(this.onMutate);
          try {
            this.observer.observe(document.body, {
              childList: true,
              subtree: true,
              attributes: true,
              attributeFilter: [
                'data-conversation-session',
                'data-chat-following-tail',
                'data-chat-flow',
                'hidden',
                'inert',
                'aria-hidden',
              ],
            });
          } catch {
            this.observer = null;
          }
        }
        this.sync();
        try {
          // The MutationObserver is the primary discovery path. The interval
          // is only a fallback for changes it cannot see (e.g. a CSS class
          // hiding the active chat); polling the whole document every 2s is
          // unnecessary when the observer is alive.
          const watchdogMs = this.observer ? WATCHDOG_MS : WATCHDOG_FALLBACK_MS;
          this.watchdogTimer = setInterval(() => {
            if (!this.disposed) this.sync();
          }, watchdogMs);
        } catch {
          this.watchdogTimer = null;
        }
        if (this.debug) this.installDebugApi();
      }

      dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.teardownBinding();
        if (this.observer) {
          try {
            this.observer.disconnect();
          } catch {
            /* ignore */
          }
          this.observer = null;
        }
        if (this.watchdogTimer !== null) {
          clearInterval(this.watchdogTimer);
          this.watchdogTimer = null;
        }
        if (this.rafId !== null) {
          const caf = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout;
          try {
            caf(this.rafId);
          } catch {
            /* ignore */
          }
          this.rafId = null;
        }
        if (this.unsubscribeSettings) {
          try {
            this.unsubscribeSettings();
          } catch {
            /* ignore */
          }
          this.unsubscribeSettings = null;
        }
        try {
          document.removeEventListener('visibilitychange', this.onVisibility);
        } catch {
          /* ignore */
        }
        try {
          window.removeEventListener('storage', this.onStorage);
        } catch {
          /* ignore */
        }
        if (this.debug && window.__DSH_FAST_HISTORY__ && window.__DSH_FAST_HISTORY__.version === VERSION) {
          try {
            delete window.__DSH_FAST_HISTORY__;
          } catch {
            window.__DSH_FAST_HISTORY__ = undefined;
          }
        }
      }

      // -- discovery / binding -------------------------------------------

      findConversation() {
        let roots;
        try {
          roots = Array.from(document.querySelectorAll('[data-conversation-session]'));
        } catch {
          return null;
        }
        const preferred = new Set();
        try {
          for (const scope of document.querySelectorAll('.dshm-main, [data-dsh-mobile-frame]')) {
            for (const root of scope.querySelectorAll('[data-conversation-session]')) preferred.add(root);
          }
        } catch {
          preferred.clear();
        }
        let best = null;
        const ordered = roots.slice();
        for (const root of preferred) {
          if (!ordered.includes(root)) ordered.unshift(root);
        }
        for (const root of ordered) {
          if (!elementVisible(root)) continue;
          const scroller = root.querySelector('[data-conversation-scroll]');
          if (!scroller || !elementVisible(scroller)) continue;
          const flow = scroller.querySelector('[data-chat-flow]');
          if (!flow || !elementVisible(flow)) continue;
          const id = root.getAttribute('data-conversation-session');
          if (!id) continue;
          const height = Number(scroller.clientHeight) || 0;
          if (!best) {
            best = { root, scroller, flow, sessionId: id, height };
            continue;
          }
          const rootPreferred = preferred.has(root);
          const bestPreferred = preferred.has(best.root);
          if (rootPreferred !== bestPreferred) {
            if (rootPreferred) best = { root, scroller, flow, sessionId: id, height };
            continue;
          }
          if (height > best.height) best = { root, scroller, flow, sessionId: id, height };
        }
        return best;
      }

      sync() {
        if (this.disposed) return;
        const found = this.findConversation();
        if (!found) {
          if (this.sessionId !== null || this.rootEl !== null) this.teardownBinding();
          return;
        }
        const same = this.sessionId === found.sessionId
          && this.rootEl === found.root
          && this.scroller === found.scroller;
        if (same) {
          const current = this.ctx.sessions.binding(found.sessionId);
          if (current) {
            if (current !== this.binding) {
              this.bind(found);
              return;
            }
            this.noteTailMarker();
            return;
          }
          if (this.binding) {
            this.teardownBinding();
            return;
          }
          // Same visible root, binding not retained yet: retry in place.
          // Calling bind() here would teardown/reinstall every watchdog tick
          // and reset the retry budget forever.
          this.resolveBinding();
          return;
        }
        this.bind(found);
      }

      bind(found) {
        this.teardownBinding();
        this.generation += 1;
        this.rootEl = found.root;
        this.scroller = found.scroller;
        this.sessionId = found.sessionId;
        this.lastTop = Number(this.scroller.scrollTop) || 0;
        this.bindRetries = 0;
        const carried = this.carriedPrefetch;
        this.carriedPrefetch = null;
        if (carried && carried.sessionId === found.sessionId) {
          // Keep the prefetch ledger across a pure visibility/remount rebind
          // of the same session; the window may still be the same. A window
          // shrink is detected in onSession and resets it.
          this.prefetchedPages = carried.prefetchedPages;
          this.prefetchedEntries = carried.prefetchedEntries;
          this.prefetchStopped = carried.prefetchStopped;
          this.openEntries = carried.openEntries;
          this.lastWindowEntries = carried.lastWindowEntries;
          this.wasOpen = true;
          this.stats.openEntries = carried.openEntries;
          this.stats.prefetchedPages = carried.prefetchedPages;
          this.stats.prefetchedEntries = carried.prefetchedEntries;
        }
        this.resolveBinding();
      }

      resolveBinding() {
        if (this.disposed || !this.sessionId) return;
        const binding = this.ctx.sessions.binding(this.sessionId);
        if (!binding) {
          this.scheduleBindRetry();
          return;
        }
        this.binding = binding;
        this.session = binding.session;
        this.eventSource = binding.eventSource;
        this.bindRetries = 0;
        this.installScrollerListeners();
        try {
          this.unsubscribeSession = this.session.subscribe(() => this.onSession());
        } catch {
          this.unsubscribeSession = null;
        }
        this.onSession();
      }

      scheduleBindRetry() {
        if (this.disposed || this.sessionId === null) return;
        if (this.bindRetryTimer !== null) return;
        if (this.bindRetries >= MAX_BIND_RETRIES) return;
        this.bindRetries += 1;
        this.bindRetryTimer = setTimeout(() => {
          this.bindRetryTimer = null;
          if (this.disposed) return;
          if (!this.sessionId) return;
          if (!this.binding) {
            this.resolveBinding();
          } else {
            this.sync();
          }
        }, BIND_RETRY_MS);
      }

      teardownBinding() {
        this.generation += 1;
        if (this.sessionId !== null && this.session) {
          this.carriedPrefetch = {
            sessionId: this.sessionId,
            prefetchedPages: this.prefetchedPages,
            prefetchedEntries: this.prefetchedEntries,
            prefetchStopped: this.prefetchStopped,
            openEntries: this.openEntries,
            lastWindowEntries: this.lastWindowEntries,
          };
        }
        if (this.unsubscribeSession) {
          try {
            this.unsubscribeSession();
          } catch {
            /* ignore */
          }
          this.unsubscribeSession = null;
        }
        this.removeScrollerListeners();
        this.clearTimers();
        this.stopChain();
        this.cancelWait({ status: 'stale' });
        this.rootEl = null;
        this.scroller = null;
        this.sessionId = null;
        this.binding = null;
        this.session = null;
        this.eventSource = null;
        this.snapshot = null;
        this.inFlight = false;
        this.inFlightKind = null;
        this.armed = false;
        this.armedKind = null;
        this.touch = null;
        this.lastLoadAt = -COOLDOWN_MS;
        this.failureUntil = 0;
        this.lastScrollAt = 0;
        this.openEntries = null;
        this.prefetchedPages = 0;
        this.prefetchedEntries = 0;
        this.prefetchStopped = false;
        this.lastWindowEntries = null;
        this.wasOpen = false;
        this.stats.openEntries = null;
        this.stats.prefetchedPages = 0;
        this.stats.prefetchedEntries = 0;
        this.stats.chainCount = 0;
        this.stats.inFlight = false;
        this.stats.hasMore = null;
        this.stats.loadingOlder = null;
        this.stats.running = null;
      }

      installScrollerListeners() {
        const scroller = this.scroller;
        if (!scroller) return;
        try {
          scroller.addEventListener('scroll', this.onScroll, { passive: true });
          scroller.addEventListener('wheel', this.onWheel, { passive: true });
          scroller.addEventListener('touchstart', this.onTouchStart, { passive: true });
          scroller.addEventListener('touchmove', this.onTouchMove, { passive: true });
          scroller.addEventListener('touchend', this.onTouchEnd, { passive: true });
          scroller.addEventListener('touchcancel', this.onTouchCancel, { passive: true });
          scroller.addEventListener('scrollend', this.onScrollEnd, { passive: true });
          scroller.addEventListener('click', this.onPagerClick, true);
          document.addEventListener('keydown', this.onKeyDown, true);
        } catch {
          /* ignore */
        }
      }

      removeScrollerListeners() {
        const scroller = this.scroller;
        if (scroller) {
          try {
            scroller.removeEventListener('scroll', this.onScroll);
            scroller.removeEventListener('wheel', this.onWheel);
            scroller.removeEventListener('touchstart', this.onTouchStart);
            scroller.removeEventListener('touchmove', this.onTouchMove);
            scroller.removeEventListener('touchend', this.onTouchEnd);
            scroller.removeEventListener('touchcancel', this.onTouchCancel);
            scroller.removeEventListener('scrollend', this.onScrollEnd);
            scroller.removeEventListener('click', this.onPagerClick, true);
          } catch {
            /* ignore */
          }
        }
        try {
          document.removeEventListener('keydown', this.onKeyDown, true);
        } catch {
          /* ignore */
        }
      }

      // -- session state -------------------------------------------------

      onSession() {
        if (this.disposed || !this.session) return;
        let snapshot;
        try {
          snapshot = this.session.getSnapshot();
        } catch {
          return;
        }
        if (!snapshot) return;
        this.snapshot = snapshot;
        this.stats.sessionId = this.sessionId;
        this.stats.hasMore = snapshot.hasMore;
        this.stats.loadingOlder = snapshot.loadingOlder;
        this.stats.running = snapshot.running;
        if (snapshot.removed) {
          this.sync();
          return;
        }
        const entries = this.entriesCount();
        const openNow = snapshot.openState === 'open';
        const reopened = openNow && !this.wasOpen;
        const shrank = this.lastWindowEntries !== null && entries < this.lastWindowEntries;
        if (reopened || shrank) this.resetPrefetchWindow(entries);
        this.lastWindowEntries = entries;
        this.wasOpen = openNow;
        if (snapshot.openState === 'open' && this.openEntries === null) {
          this.openEntries = this.entriesCount();
          this.stats.openEntries = this.openEntries;
          if (this.openEntries > MAX_OPEN_ENTRIES) {
            this.prefetchStopped = true;
            this.debugLog('skip prefetch: initial window is heavy', this.openEntries);
          }
        }
        if (snapshot.openState !== 'open' || !snapshot.hasMore || snapshot.running) {
          this.cancelPrefetch();
        }
        if (snapshot.openState === 'open') this.maybeSchedulePrefetch();
      }

      entriesCount() {
        try {
          if (!this.eventSource) return 0;
          const window = this.eventSource.getSnapshot();
          return window && Array.isArray(window.entries) ? window.entries.length : 0;
        } catch {
          return 0;
        }
      }

      eventSignature() {
        try {
          if (!this.eventSource) return '';
          const window = this.eventSource.getSnapshot();
          if (!window) return '';
          return `${window.entries.length}:${window.hasMore ? 1 : 0}:${window.revision}`;
        } catch {
          return '';
        }
      }

      bottomDistance() {
        if (!this.scroller) return 0;
        return Number(this.scroller.scrollHeight) - Number(this.scroller.clientHeight) - Number(this.scroller.scrollTop);
      }

      isAtTail() {
        if (!this.scroller) return false;
        try {
          if (this.scroller.querySelector('[data-chat-following-tail]')) return true;
        } catch {
          /* ignore */
        }
        return this.bottomDistance() <= 4;
      }

      findFlow() {
        if (!this.scroller) return null;
        let flow;
        try {
          flow = this.scroller.querySelector('[data-chat-flow]');
        } catch {
          return null;
        }
        if (!flow || !elementVisible(flow)) return null;
        return flow;
      }

      findPager() {
        const flow = this.findFlow();
        if (!flow) return null;
        const button = findPagerButton(flow);
        return button ? { button, flow } : null;
      }

      // -- settings / visibility ----------------------------------------

      refreshSettings() {
        if (this.disposed) return;
        this.settings = this.store.get();
        if (!this.settings.enabled) {
          this.cancelPrefetch();
          this.disarm('disabled');
          this.stopChain();
          return;
        }
        if (this.settings.prefetchPages <= 0) this.cancelPrefetch();
        this.maybeSchedulePrefetch();
      }

      handleVisibility() {
        if (this.disposed) return;
        if (document.visibilityState !== 'visible') {
          this.cancelPrefetch();
          this.disarm('hidden');
          this.stopChain();
          return;
        }
        this.maybeSchedulePrefetch();
      }

      isPageVisible() {
        return typeof document.visibilityState === 'undefined' || document.visibilityState === 'visible';
      }

      // -- prefetch ------------------------------------------------------

      cancelPrefetch() {
        if (this.prefetchTimer !== null) {
          clearTimeout(this.prefetchTimer);
          this.prefetchTimer = null;
        }
        if (this.prefetchGapTimer !== null) {
          clearTimeout(this.prefetchGapTimer);
          this.prefetchGapTimer = null;
        }
      }

      clearTimers() {
        if (this.bindRetryTimer !== null) {
          clearTimeout(this.bindRetryTimer);
          this.bindRetryTimer = null;
        }
        this.cancelPrefetch();
        if (this.tailCheckTimer !== null) {
          clearTimeout(this.tailCheckTimer);
          this.tailCheckTimer = null;
        }
        if (this.chainTimer !== null) {
          clearTimeout(this.chainTimer);
          this.chainTimer = null;
        }
        if (this.scrollSettleTimer !== null) {
          clearTimeout(this.scrollSettleTimer);
          this.scrollSettleTimer = null;
        }
        this.scrollSettleDeadline = 0;
        this.fastScrolling = false;
        this.scrollVelocity = 0;
        this.pendingLoadAfterSettle = false;
        if (this.anchorTimer !== null) {
          clearTimeout(this.anchorTimer);
          this.anchorTimer = null;
        }
        this.anchorAttempts = 0;
        this.internalScroll = false;
      }

      resetPrefetchWindow(entries) {
        this.cancelPrefetch();
        this.prefetchedPages = 0;
        this.prefetchedEntries = 0;
        this.prefetchStopped = !openWindowAllowed(entries);
        this.openEntries = entries;
        this.stats.openEntries = entries;
        this.stats.prefetchedPages = 0;
        this.stats.prefetchedEntries = 0;
        if (this.prefetchStopped) {
          this.debugLog('skip prefetch: initial window is heavy', entries);
        }
      }

      prefetchDue() {
        return this.settings.enabled
          && this.settings.prefetchPages > 0
          && this.prefetchedPages < this.settings.prefetchPages
          && !this.prefetchStopped;
      }

      canPrefetchNow() {
        if (!this.session || !this.snapshot || this.disposed) return false;
        if (!this.prefetchDue()) return false;
        if (this.snapshot.openState !== 'open' || !this.snapshot.hasMore || this.snapshot.running || this.snapshot.loadingOlder) return false;
        if (this.inFlight) return false;
        if (this.touch || this.fastScrolling) return false;
        const entries = this.entriesCount();
        if (this.openEntries === null || (this.openEntries === 0 && entries > 0)) {
          this.openEntries = entries;
          this.stats.openEntries = entries;
        }
        if (entries > MAX_OPEN_ENTRIES || !openWindowAllowed(entries)) {
          this.prefetchStopped = true;
          this.debugLog('skip prefetch: current window is heavy', entries);
          return false;
        }
        if (!this.isPageVisible() || !this.isAtTail()) return false;
        if (!this.findFlow()) return false;
        if (this.lastScrollAt > 0 && now() - this.lastScrollAt < 500) return false;
        if (now() < this.failureUntil) return false;
        return true;
      }

      maybeSchedulePrefetch() {
        if (this.disposed || !this.session || !this.snapshot) return;
        if (this.prefetchTimer !== null || this.prefetchGapTimer !== null) return;
        if (!this.canPrefetchNow()) return;
        this.prefetchTimer = setTimeout(() => {
          this.prefetchTimer = null;
          if (this.disposed) return;
          const gen = this.generation;
          this.prefetchOne().catch((error) => {
            if (gen !== this.generation) return;
            this.debugLog('prefetch request failed', error);
            this.inFlight = false;
            this.inFlightKind = null;
            this.stats.inFlight = false;
            this.prefetchStopped = true;
          });
        }, PREFETCH_DELAY_MS);
      }

      schedulePrefetchGap() {
        if (this.disposed || this.prefetchGapTimer !== null) return;
        this.prefetchGapTimer = setTimeout(() => {
          this.prefetchGapTimer = null;
          if (!this.canPrefetchNow()) return;
          const gen = this.generation;
          this.prefetchOne().catch((error) => {
            if (gen !== this.generation) return;
            this.debugLog('prefetch request failed', error);
            this.inFlight = false;
            this.inFlightKind = null;
            this.stats.inFlight = false;
            this.prefetchStopped = true;
          });
        }, PREFETCH_GAP_MS);
      }

      async prefetchOne() {
        if (!this.canPrefetchNow()) return;
        const gen = this.generation;
        const session = this.session;
        const before = this.entriesCount();
        const beforeSig = this.eventSignature();
        const beforeBottom = this.bottomDistance();
        const started = now();
        this.inFlight = true;
        this.inFlightKind = 'prefetch';
        this.stats.inFlight = true;
        let outcome = null;
        try {
          await withTimeout(session.loadOlder(), PAGE_CALL_TIMEOUT_MS, 'loadOlder timeout');
        } catch (error) {
          outcome = { status: 'error', error };
        }
        if (gen !== this.generation || this.disposed || !this.session) {
          this.releaseInFlight(gen);
          return;
        }
        if (!outcome) outcome = await this.waitForPage(gen, beforeSig);
        if (outcome.status === 'settled') {
          await this.nextFrame();
          await this.nextFrame();
        }
        if (gen !== this.generation || this.disposed) {
          this.releaseInFlight(gen);
          return;
        }
        this.finishLoad(gen, 'prefetch', {
          before,
          beforeSig,
          beforeBottom,
          anchor: null,
          used: 'direct',
          started,
          outcome,
        });
      }

      // -- gesture loading ----------------------------------------------

      arm(kind) {
        if (this.disposed || !this.settings.enabled) return;
        this.armed = true;
        this.armedKind = kind;
      }

      disarm(reason) {
        if (this.armed) {
          this.stats.lastDisarm = reason || 'unknown';
          this.stats.lastDisarmAt = this.scroller ? Math.round(Number(this.scroller.scrollTop) || 0) : null;
          this.stats.lastDisarmLastTop = Math.round(this.lastTop);
        }
        this.armed = false;
        this.armedKind = null;
      }

      stopChain() {
        this.chainActive = false;
        this.chainCount = 0;
        if (this.chainTimer !== null) {
          clearTimeout(this.chainTimer);
          this.chainTimer = null;
        }
      }

      autoMargin() {
        const height = this.scroller ? Number(this.scroller.clientHeight) || 0 : 0;
        const margin = autoMarginPx(height, this.settings);
        this.stats.autoMarginPx = Math.round(margin);
        return margin;
      }

      isCooldown() {
        return now() - this.lastLoadAt < COOLDOWN_MS;
      }

      canGestureLoad() {
        if (this.disposed || !this.armed) return false;
        if (!this.settings.enabled) return false;
        if (!this.session || !this.snapshot) return false;
        if (!this.isPageVisible()) return false;
        if (this.touch) return false;
        if (this.snapshot.openState !== 'open' || !this.snapshot.hasMore || this.snapshot.loadingOlder) return false;
        if (this.inFlight || this.isCooldown() || this.fastScrolling) return false;
        if (now() < this.failureUntil) return false;
        if (!this.scroller || Number(this.scroller.scrollTop) > this.autoMargin()) return false;
        if (!this.findFlow()) return false;
        return true;
      }

      canChainLoad() {
        if (this.disposed || !this.chainActive) return false;
        if (this.chainCount >= MAX_CHAIN_PAGES) return false;
        if (!this.settings.enabled) return false;
        if (!this.session || !this.snapshot) return false;
        if (!this.isPageVisible()) return false;
        if (this.snapshot.openState !== 'open' || !this.snapshot.hasMore || this.snapshot.loadingOlder) return false;
        if (this.inFlight || this.fastScrolling || this.touch) return false;
        if (now() < this.failureUntil) return false;
        if (!this.scroller || Number(this.scroller.scrollTop) > this.autoMargin()) return false;
        if (!this.findFlow()) return false;
        return true;
      }

      scheduleChain() {
        if (this.disposed || !this.chainActive || this.chainTimer !== null) return;
        this.chainTimer = setTimeout(() => {
          this.chainTimer = null;
          if (this.disposed || !this.chainActive) return;
          if (!this.canChainLoad()) {
            if (this.chainActive && (this.fastScrolling || this.touch)) {
              // Keep the chain alive while the reader is moving or the finger
              // is down. noteScrollSettled()/handleTouchEnd() resumes it.
              return;
            }
            this.chainActive = false;
            return;
          }
          this.requestLoad('chain');
        }, this.chainGap());
      }

      resumeChain() {
        if (this.disposed || !this.chainActive || this.inFlight || this.chainTimer !== null) return;
        if (this.fastScrolling || this.touch) return;
        this.scheduleChain();
      }

      chainGap() {
        return isMobileContext(document) ? 160 : CHAIN_GAP_MS;
      }

      requestLoad(kind) {
        const gen = this.generation;
        const promise = this.loadOnePage(kind);
        if (!promise || typeof promise.catch !== 'function') return;
        promise.catch((error) => {
          if (gen !== this.generation) return;
          this.debugLog('load request failed', error);
          this.inFlight = false;
          this.inFlightKind = null;
          this.stats.inFlight = false;
          this.failureUntil = now() + FAILURE_BACKOFF_MS;
          this.stopChain();
        });
      }

      async loadOnePage(kind) {
        const chain = kind === 'chain';
        if (chain ? !this.canChainLoad() : !this.canGestureLoad()) return;
        this.cancelAnchorCorrection();
        const topBefore = this.scroller ? Number(this.scroller.scrollTop) || 0 : 0;
        const startedAtTop = topBefore <= PAGER_CLICK_MAX_PX;
        // On phones, use the public face even at the true top. The official
        // pager's beginPaging anchors the first paging seat; when that seat is
        // the pager/header the viewport can land on the *next* pager. A direct
        // load + our own old-top-row correction keeps the reading position.
        const usePager = !this.touch
          && !isMobileContext(document)
          && startedAtTop;
        const pager = usePager ? this.findPager() : null;
        if (pager && (pager.button.disabled || pager.button.getAttribute('aria-disabled') === 'true')) {
          // The official pager is busy (or about to be). Do not double-load.
          return;
        }
        const gen = this.generation;
        const session = this.session;
        const before = this.entriesCount();
        const beforeSig = this.eventSignature();
        const anchor = this.captureAnchor();
        const beforeBottom = this.bottomDistance();
        const started = now();
        this.inFlight = true;
        this.inFlightKind = kind;
        this.stats.inFlight = true;
        if (chain) {
          this.stats.chainLoads += 1;
          this.stats.chainCount = this.chainCount;
        } else {
          this.stats.gestures += 1;
        }
        let used = 'direct';
        let outcome = null;
        try {
          if (pager) {
            used = 'button';
            try {
              pager.button.click();
            } catch {
              used = 'direct';
            }
            if (used === 'button') {
              await this.nextFrame();
              if (gen !== this.generation || this.disposed || !this.session) {
                this.releaseInFlight(gen);
                return;
              }
              const state = this.session.getSnapshot();
              if (!state.loadingOlder && this.eventSignature() === beforeSig) {
                // The click was a no-op (stale pager); use the public face.
                used = 'direct';
              }
            }
          }
          if (used === 'direct') {
            await withTimeout(session.loadOlder(), PAGE_CALL_TIMEOUT_MS, 'loadOlder timeout');
          }
        } catch (error) {
          outcome = { status: 'error', error };
        }
        if (gen !== this.generation || this.disposed || !this.session) {
          this.releaseInFlight(gen);
          return;
        }
        if (!outcome) outcome = await this.waitForPage(gen, beforeSig);
        if (outcome.status === 'settled') {
          await this.nextFrame();
          await this.nextFrame();
        }
        if (gen !== this.generation || this.disposed) {
          this.releaseInFlight(gen);
          return;
        }
        this.finishLoad(gen, kind, {
          before,
          beforeSig,
          beforeBottom,
          anchor,
          used,
          started,
          startedAtTop,
          outcome,
        });
      }

      captureAnchor() {
        const flow = this.findFlow();
        if (!flow) return null;
        const row = topVisibleRow(this.scroller, flow);
        if (!row) return null;
        return { key: row.key, top: row.top };
      }

      applyAnchorCorrection(anchor, gen) {
        if (gen !== this.generation || this.disposed || !this.scroller || !anchor) return false;
        if (this.touch || this.fastScrolling) return false;
        const flow = this.findFlow();
        const row = flow ? findRowByKey(flow, anchor.key) : null;
        if (!row) return false;
        const drift = row.getBoundingClientRect().top - anchor.top;
        if (Math.abs(drift) <= 2) return false;
        const max = Math.max(0, this.scroller.scrollHeight - this.scroller.clientHeight);
        // This write is ours, not a user gesture: do not let it arm, disarm
        // or look like momentum to the gate/chain.
        this.internalScroll = true;
        this.scroller.scrollTop = Math.max(0, Math.min(max, this.scroller.scrollTop + drift));
        this.lastTop = Number(this.scroller.scrollTop) || 0;
        const raf = typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame
          : (fn) => setTimeout(fn, 16);
        raf(() => {
          if (gen === this.generation) this.internalScroll = false;
        });
        this.debugLog('corrected direct-load anchor', Math.round(drift));
        return true;
      }

      scheduleAnchorCorrection(anchor, gen) {
        if (gen !== this.generation || this.disposed || !anchor) return;
        if (this.anchorTimer !== null) {
          clearTimeout(this.anchorTimer);
          this.anchorTimer = null;
        }
        this.anchorAttempts = 0;
        const tick = () => {
          this.anchorTimer = null;
          if (gen !== this.generation || this.disposed) return;
          // A finger-down or momentum state must not receive a scrollTop
          // write; wait for the next quiet tick instead.
          if (!this.touch && !this.fastScrolling && this.applyAnchorCorrection(anchor, gen)) return;
          if (this.anchorAttempts >= ANCHOR_RETRY_LIMIT) return;
          this.anchorAttempts += 1;
          this.anchorTimer = setTimeout(tick, ANCHOR_RETRY_MS);
        };
        this.anchorTimer = setTimeout(tick, ANCHOR_RETRY_MS);
      }

      cancelAnchorCorrection() {
        if (this.anchorTimer !== null) {
          clearTimeout(this.anchorTimer);
          this.anchorTimer = null;
        }
        this.anchorAttempts = 0;
      }

      // -- page settle / completion -------------------------------------

      nextFrame() {
        return new Promise((resolve) => {
          if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => resolve());
          } else {
            setTimeout(resolve, 16);
          }
        });
      }

      waitForPage(gen, beforeSig) {
        return new Promise((resolve) => {
          let done = false;
          const finish = (result) => {
            if (done) return;
            done = true;
            if (this.settleTimer !== null) {
              clearTimeout(this.settleTimer);
              this.settleTimer = null;
            }
            if (this.pendingResolve === finish) this.pendingResolve = null;
            resolve(result);
          };
          this.pendingResolve = finish;
          const startedAt = now();
          let sawBusy = false;
          const tick = () => {
            if (done) return;
            if (gen !== this.generation || this.disposed || !this.session) {
              finish({ status: 'stale' });
              return;
            }
            let state;
            try {
              state = this.session.getSnapshot();
            } catch {
              finish({ status: 'stale' });
              return;
            }
            if (!state) {
              finish({ status: 'stale' });
              return;
            }
            if (state.loadingOlder) sawBusy = true;
            const sig = this.eventSignature();
            if (!state.loadingOlder && sig !== beforeSig) {
              finish({ status: 'settled', signature: sig });
              return;
            }
            const elapsed = now() - startedAt;
            if (!state.loadingOlder && elapsed > PAGE_START_GRACE_MS && !sawBusy && sig === beforeSig) {
              finish({ status: 'noop' });
              return;
            }
            if (!state.loadingOlder && sawBusy && elapsed > 600 && sig === beforeSig) {
              finish({ status: 'noop' });
              return;
            }
            if (elapsed >= PAGE_TIMEOUT_MS) {
              finish({ status: 'timeout' });
              return;
            }
            this.settleTimer = setTimeout(tick, 50);
          };
          tick();
        });
      }

      cancelWait(result) {
        if (this.pendingResolve) {
          const resolve = this.pendingResolve;
          this.pendingResolve = null;
          if (this.settleTimer !== null) {
            clearTimeout(this.settleTimer);
            this.settleTimer = null;
          }
          try {
            resolve(result || { status: 'stale' });
          } catch {
            /* ignore */
          }
        }
      }

      releaseInFlight(gen) {
        // A stale async continuation must never clear the in-flight flag of a
        // newer binding: teardown already reset the old one, and the new
        // binding may legitimately have started its own page request.
        if (gen !== this.generation) return;
        this.inFlight = false;
        this.inFlightKind = null;
        this.stats.inFlight = false;
      }

      finishLoad(gen, kind, info) {
        if (gen !== this.generation || this.disposed) return;
        this.inFlight = false;
        this.inFlightKind = null;
        this.stats.inFlight = false;
        const outcome = info.outcome || { status: 'error' };
        const status = outcome.status || 'error';
        const after = this.entriesCount();
        const delta = Math.max(0, after - info.before);
        const end = now();
        this.stats.lastOutcome = status;
        this.stats.lastLatencyMs = Math.round(end - info.started);
        this.stats.lastEntriesDelta = delta;
        this.stats.sessionId = this.sessionId;
        if (status !== 'settled') {
          if (status === 'error' || status === 'timeout') this.stats.failures += 1;
          this.failureUntil = end + FAILURE_BACKOFF_MS;
          this.debugLog('page did not settle', status, info.used);
        }

        if (kind === 'gesture' || kind === 'chain') {
          if (status === 'settled') this.stats.autoLoads += 1;
          this.stats.lastDriftPx = null;
          if (info.anchor) {
            const flow = this.findFlow();
            const row = flow ? findRowByKey(flow, info.anchor.key) : null;
            if (row) {
              const drift = row.getBoundingClientRect().top - info.anchor.top;
              this.stats.lastDriftPx = Math.round(drift * 100) / 100;
              // A direct load has no official beginPaging owner. Keep the old
              // top row fixed ourselves, including on phones: otherwise the
              // prepended page shifts the viewport up and can land on the next
              // pager. Do not write while a finger or momentum is moving.
              if (info.used === 'direct') {
                const canWriteNow = !this.touch && !this.fastScrolling;
                let corrected = false;
                if (canWriteNow) corrected = this.applyAnchorCorrection(info.anchor, gen);
                let remaining = drift;
                if (corrected) {
                  const afterRow = flow ? findRowByKey(flow, info.anchor.key) : null;
                  if (afterRow) {
                    remaining = afterRow.getBoundingClientRect().top - info.anchor.top;
                    this.stats.lastDriftPx = Math.round(remaining * 100) / 100;
                  }
                }
                // A delayed retry is only needed when we could not write now
                // (finger down / momentum) or the immediate correction did
                // not take. A stale retry after a normal load would yank a
                // reader who has already scrolled away.
                if (!canWriteNow || Math.abs(remaining) > 2) {
                  this.scheduleAnchorCorrection(info.anchor, gen);
                }
              }
            }
          }
          this.armed = false;
          this.armedKind = null;
          this.lastLoadAt = end;
          this.chainCount = kind === 'gesture' ? 1 : this.chainCount + 1;
          this.stats.chainCount = this.chainCount;
          const margin = this.autoMargin();
          this.stats.autoMarginPx = Math.round(margin);
          const top = this.scroller ? Number(this.scroller.scrollTop) || 0 : Number.POSITIVE_INFINITY;
          const stuckAtTop = top <= PAGER_CLICK_MAX_PX;
          const canContinue = status === 'settled'
            && this.snapshot
            && this.snapshot.hasMore
            && this.chainCount < MAX_CHAIN_PAGES
            && top <= margin
            && !stuckAtTop
            && !info.startedAtTop
            && now() >= this.failureUntil;
          if (stuckAtTop) this.debugLog('page load left the viewport at the top; stop chain');
          if (info.startedAtTop) this.debugLog('explicit top pull; one page only');
          if (canContinue) {
            this.chainActive = true;
            this.scheduleChain();
          } else {
            this.chainActive = false;
            if (top > margin || status !== 'settled') this.chainCount = 0;
          }
          this.debugLog(
            kind === 'chain' ? 'chain page' : 'gesture page',
            status,
            'via',
            info.used,
            'delta',
            delta,
            'top',
            Math.round(top),
            'margin',
            Math.round(margin),
            'count',
            this.chainCount,
            'ms',
            this.stats.lastLatencyMs,
          );
        } else {
          this.prefetchedPages += 1;
          this.prefetchedEntries += delta;
          this.stats.prefetchedPages = this.prefetchedPages;
          this.stats.prefetchedEntries = this.prefetchedEntries;
          if (status === 'settled') this.stats.prefetchLoads += 1;
          if (status === 'settled'
            && info.beforeBottom !== null
            && this.lastScrollAt <= info.started
            && !this.touch
            && !this.fastScrolling
            && !isMobileContext(document)
            && this.scroller) {
            const afterBottom = this.bottomDistance();
            const drift = afterBottom - info.beforeBottom;
            if (Math.abs(drift) > 2) {
              const max = Math.max(0, this.scroller.scrollHeight - this.scroller.clientHeight);
              this.scroller.scrollTop = Math.max(0, Math.min(max, this.scroller.scrollTop + drift));
              this.debugLog('kept tail distance during prefetch', drift);
            }
          }
          if (status !== 'settled') {
            this.prefetchStopped = true;
          } else if (!this.snapshot || !this.snapshot.hasMore) {
            this.prefetchStopped = true;
          } else if (delta > MAX_PAGE_ENTRIES || this.prefetchedEntries > MAX_PREFETCH_ENTRIES) {
            this.prefetchStopped = true;
            this.debugLog('prefetch budget reached', this.prefetchedEntries, delta);
          } else if (this.prefetchedPages >= this.settings.prefetchPages) {
            // target reached; nothing to do
          } else {
            this.schedulePrefetchGap();
          }
          this.debugLog('prefetch page', status, 'delta', delta, 'pages', this.prefetchedPages);
        }

        this.maybeSchedulePrefetch();
      }

      // -- DOM events ----------------------------------------------------

      handleScroll() {
        if (!this.scroller) return;
        const top = Number(this.scroller.scrollTop) || 0;
        const t = now();
        if (this.internalScroll) {
          this.lastTop = top;
          return;
        }
        // A delayed anchor retry belongs to the load that scheduled it. Once
        // the reader moves the viewport up, that retry must not yank them back.
        if (top < this.lastTop - 0.5) this.cancelAnchorCorrection();
        const dt = Math.max(1, t - this.lastScrollAt);
        const delta = Math.abs(top - this.lastTop);
        this.scrollVelocity = delta / dt;
        if (this.scrollVelocity > FAST_SCROLL_VELOCITY_PX_PER_MS || delta > FAST_SCROLL_DELTA_PX) {
          this.fastScrolling = true;
        }
        this.scheduleScrollSettle();
        if (this.armed && !this.inFlight && top < this.lastTop - 0.5) {
          if (top <= this.autoMargin() && !this.isCooldown()) {
            // Defer any load while a finger is down, not just at the true top:
            // inserting content under a moving finger fights the browser's
            // scroll anchoring and is the source of the mobile twitch.
            if (this.fastScrolling || this.touch) {
              this.pendingLoadAfterSettle = true;
              this.scheduleScrollSettle();
            } else {
              this.requestLoad('gesture');
            }
          }
        }
        if (top > this.lastTop + 2) {
          this.disarm('scroll-down');
          this.pendingLoadAfterSettle = false;
        }
        this.lastTop = top;
        this.lastScrollAt = t;
        this.scheduleTailCheck();
      }

      scheduleScrollSettle() {
        if (this.disposed) return;
        this.scrollSettleDeadline = now() + SCROLL_SETTLE_MS;
        if (this.scrollSettleTimer !== null) return;
        const tick = () => {
          this.scrollSettleTimer = null;
          if (this.disposed) return;
          const remaining = this.scrollSettleDeadline - now();
          if (remaining > 0) {
            this.scrollSettleTimer = setTimeout(tick, Math.max(1, remaining));
            return;
          }
          this.fastScrolling = false;
          this.scrollVelocity = 0;
          this.resumeChain();
          // Keep the pending intent until the gesture ends. Loading while a
          // finger is down (or while a synthetic settle timer is still
          // waiting for touchend) competes with the browser's anchoring.
          if (this.touch) return;
          if (!this.pendingLoadAfterSettle) return;
          this.pendingLoadAfterSettle = false;
          if (!this.settings.enabled || !this.armed || this.inFlight || !this.scroller) return;
          if (Number(this.scroller.scrollTop) > this.autoMargin()) return;
          this.requestLoad('gesture');
        };
        this.scrollSettleTimer = setTimeout(tick, SCROLL_SETTLE_MS);
      }

      scheduleTailCheck() {
        if (this.disposed) return;
        if (this.tailCheckTimer !== null) clearTimeout(this.tailCheckTimer);
        this.tailCheckTimer = setTimeout(() => {
          this.tailCheckTimer = null;
          this.maybeSchedulePrefetch();
        }, TAIL_SETTLE_MS);
      }

      handleWheel(event) {
        if (!this.scroller || this.disposed) return;
        if (!this.settings.enabled) return;
        this.cancelAnchorCorrection();
        if (event.ctrlKey) return;
        if (nearestNestedScroller(event.target, this.scroller, window)) return;
        const deltaY = Number(event.deltaY);
        if (!Number.isFinite(deltaY)) return;
        if (deltaY > 0) {
          this.disarm('wheel-down');
          this.pendingLoadAfterSettle = false;
          return;
        }
        if (deltaY >= 0) return;
        this.arm('wheel');
        const top = Number(this.scroller.scrollTop) || 0;
        if (top <= this.autoMargin() && !this.inFlight) {
          if (this.fastScrolling) {
            this.pendingLoadAfterSettle = true;
            this.scheduleScrollSettle();
          } else {
            this.requestLoad('gesture');
          }
        }
      }

      handleTouchStart(event) {
        if (this.disposed || !this.scroller || !this.settings.enabled) return;
        this.cancelAnchorCorrection();
        if (event.touches && event.touches.length !== 1) return;
        if (nearestNestedScroller(event.target, this.scroller, window)) return;
        const touch = event.touches && event.touches[0];
        if (!touch) return;
        this.touch = {
          startY: touch.clientY,
          lastY: touch.clientY,
          startTop: Number(this.scroller.scrollTop) || 0,
          moved: false,
        };
        this.pendingLoadAfterSettle = false;
        this.arm('touch');
      }

      handleTouchMove(event) {
        if (!this.touch || !this.scroller) return;
        if (event.touches && event.touches.length !== 1) return;
        const touch = event.touches && event.touches[0];
        if (!touch) return;
        if (Math.abs(touch.clientY - this.touch.startY) > 4) this.touch.moved = true;
        const previousY = this.touch.lastY;
        const dy = touch.clientY - previousY;
        const top = Number(this.scroller.scrollTop) || 0;
        if (this.touch.moved && dy > 0.5 && top <= this.autoMargin() && !this.inFlight) {
          // Do not load while the finger is still down. Even a slow drag can
          // still be followed by momentum; wait for touchend and the settle
          // window, then let the anchored path or direct load take over.
          this.pendingLoadAfterSettle = true;
          this.scheduleScrollSettle();
        }
        this.touch.lastY = touch.clientY;
      }

      handleTouchEnd(event) {
        if (event && event.touches && event.touches.length > 0) return;
        const info = this.touch;
        this.touch = null;
        if (!info || this.disposed || !this.scroller || !this.settings.enabled) return;
        const top = Number(this.scroller.scrollTop) || 0;
        const wentUp = top < info.startTop - 0.5;
        const pulledDownAtTop = top <= this.autoMargin()
          && info.moved
          && info.lastY > info.startY + 4;
        if ((wentUp && top <= this.autoMargin()) || pulledDownAtTop) {
          this.pendingLoadAfterSettle = true;
          this.scheduleScrollSettle();
        }
        this.resumeChain();
      }

      handleTouchCancel() {
        this.touch = null;
        this.pendingLoadAfterSettle = false;
        if (this.scrollSettleTimer !== null) {
          clearTimeout(this.scrollSettleTimer);
          this.scrollSettleTimer = null;
        }
        this.disarm('touch-cancel');
        this.stopChain();
      }

      handleScrollEnd() {
        if (this.touch) return;
        this.fastScrolling = false;
        this.scrollVelocity = 0;
        this.resumeChain();
        if (this.armed && this.scroller && Number(this.scroller.scrollTop) <= this.autoMargin()) {
          this.pendingLoadAfterSettle = false;
          this.requestLoad('gesture');
        }
      }

      handlePagerClick(event) {
        if (this.disposed || !this.settings.enabled) return;
        if (event.isTrusted) return;
        if (!isMobileContext(document)) return;
        if (!this.scroller || !this.rootEl) return;
        const target = event.target;
        if (!(target instanceof Element)) return;
        const button = target.closest('button');
        if (!button) return;
        const pager = this.findPager();
        if (!pager || pager.button !== button) return;
        // dsh-mobile's 64 px gate (and other mobile helpers) call button.click().
        // Letting the official handler run would use beginPaging and can land on
        // the next pager. Swallow the synthetic click and take the anchored
        // direct path instead; real user clicks are trusted and stay official.
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
        if (this.inFlight || this.isCooldown()) return;
        if (!this.snapshot || this.snapshot.openState !== 'open' || !this.snapshot.hasMore) return;
        if (this.snapshot.loadingOlder) return;
        const top = Number(this.scroller.scrollTop) || 0;
        if (top > this.autoMargin()) return;
        this.armed = true;
        this.armedKind = 'pager';
        this.pendingLoadAfterSettle = false;
        this.requestLoad('gesture');
        this.debugLog('intercepted synthetic pager click; using anchored direct load');
      }

      handleKeyDown(event) {
        if (this.disposed || !this.settings.enabled) return;
        this.cancelAnchorCorrection();
        if (event.defaultPrevented) return;
        if (event.repeat) return;
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (event.key !== 'ArrowUp' && event.key !== 'PageUp' && event.key !== 'Home') return;
        if (isEditable(event.target)) return;
        if (nearestNestedScroller(event.target, this.scroller, window)) return;
        if (!this.rootEl) return;
        const inRoot = this.rootEl.contains(event.target);
        const documentTarget = event.target === document.body
          || event.target === document.documentElement
          || event.target === document;
        if (!inRoot && !documentTarget) return;
        this.arm('key');
        if (this.scroller && Number(this.scroller.scrollTop) <= this.autoMargin()) {
          this.requestLoad('gesture');
        }
      }

      noteTailMarker() {
        if (!this.scroller) return;
        try {
          if (this.scroller.querySelector('[data-chat-following-tail]')) this.maybeSchedulePrefetch();
        } catch {
          /* ignore */
        }
      }

      // -- debug ---------------------------------------------------------

      debugLog(...args) {
        if (!this.debug) return;
        try {
          console.debug('[dsh-fast-history]', ...args);
        } catch {
          /* ignore */
        }
      }

      installDebugApi() {
        const controller = this;
        const api = {
          version: VERSION,
          get settings() {
            return controller.store.get();
          },
          diagnostics() {
            let snapshot = null;
            try {
              snapshot = controller.session ? controller.session.getSnapshot() : null;
            } catch {
              snapshot = null;
            }
            return {
              settings: controller.settings,
              lastScrollAt: controller.lastScrollAt,
              atTail: controller.isAtTail(),
              pageVisible: controller.isPageVisible(),
              mobileContext: isMobileContext(document),
              flow: Boolean(controller.findFlow()),
              openState: snapshot ? snapshot.openState : null,
              hasMore: snapshot ? snapshot.hasMore : null,
              loadingOlder: snapshot ? snapshot.loadingOlder : null,
              running: snapshot ? snapshot.running : null,
              openEntries: controller.openEntries,
              prefetchedPages: controller.prefetchedPages,
              prefetchStopped: controller.prefetchStopped,
              autoMarginPx: Math.round(controller.autoMargin()),
              chainActive: controller.chainActive,
              chainCount: controller.chainCount,
              canPrefetch: controller.canPrefetchNow(),
              canChain: controller.canChainLoad(),
            };
          },
          stats() {
            return Object.assign({}, controller.stats, {
              sessionId: controller.sessionId,
              openEntries: controller.openEntries,
              prefetchedPages: controller.prefetchedPages,
              prefetchedEntries: controller.prefetchedEntries,
              prefetchStopped: controller.prefetchStopped,
              armed: controller.armed,
              inFlight: controller.inFlight,
              fastScrolling: controller.fastScrolling,
              pendingLoadAfterSettle: controller.pendingLoadAfterSettle,
              lastTop: Math.round(controller.lastTop * 100) / 100,
              armedKind: controller.armedKind,
              touchMoved: controller.touch ? controller.touch.moved : null,
              lastDisarm: controller.stats.lastDisarm,
              lastDisarmAt: controller.stats.lastDisarmAt,
              lastDisarmLastTop: controller.stats.lastDisarmLastTop,
            });
          },
          setSettings(patch) {
            return controller.store.update(patch);
          },
          refresh() {
            controller.sync();
          },
        };
        try {
          window.__DSH_FAST_HISTORY__ = api;
        } catch {
          /* ignore */
        }
      }
    }

    // ---------------------------------------------------------------------
    // Settings row (Settings -> General).
    // ---------------------------------------------------------------------

    let rowStore = null;

    const rowStyle = {
      borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '24px',
      padding: '16px 0',
    };
    const rowTextStyle = { minWidth: 0, flex: '1 1 auto' };
    const titleStyle = {
      color: 'var(--dsw-alias-label-primary)',
      fontSize: '14px',
      fontWeight: 400,
      lineHeight: '20px',
    };
    const descriptionStyle = {
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: '12px',
      lineHeight: '18px',
      marginTop: '4px',
    };
    const controlStyle = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'flex-end',
      flexWrap: 'wrap',
      gap: '12px',
      flex: '0 0 auto',
    };
    const labeledControlStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: '12px',
      whiteSpace: 'nowrap',
    };
    const selectStyle = {
      height: '28px',
      borderRadius: 'var(--dsw-radius-sm)',
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-module-platform)',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: '12px',
      padding: '0 6px',
      cursor: 'pointer',
    };

    function switchStyle(enabled) {
      return {
        width: '36px',
        height: '20px',
        borderRadius: '999px',
        border: 0,
        padding: 0,
        position: 'relative',
        cursor: 'pointer',
        background: enabled
          ? 'var(--dsw-alias-state-success-primary, #2f9e5f)'
          : 'var(--dsw-alias-bg-module-platform, #6b7280)',
        transition: 'background 120ms ease',
        flex: '0 0 auto',
      };
    }

    function knobStyle(enabled) {
      return {
        position: 'absolute',
        top: '2px',
        left: enabled ? '18px' : '2px',
        width: '16px',
        height: '16px',
        borderRadius: '50%',
        background: '#fff',
        boxShadow: '0 1px 2px rgba(0,0,0,.25)',
        transition: 'left 120ms ease',
      };
    }

    function FastHistorySettingsRow(props) {
      const store = props.fastHistoryStore || rowStore;
      if (!store) return null;
      const t = typeof props.t === 'function' ? props.t : fallbackTranslate;
      const [value, setValue] = React.useState(() => store.get());
      React.useEffect(() => store.subscribe(setValue), [store]);
      const enabled = value.enabled;
      return h('div', { style: rowStyle }, [
        h('div', { key: 'text', style: rowTextStyle }, [
          h('div', { key: 'title', style: titleStyle }, t('title')),
          h('div', { key: 'desc', style: descriptionStyle }, t('description')),
        ]),
        h('div', { key: 'controls', style: controlStyle }, [
          h('label', { key: 'lead-label', style: labeledControlStyle }, [
            t('lead'),
            h('select', {
              key: 'lead',
              value: String(value.preloadScreens),
              'aria-label': t('lead'),
              disabled: !enabled,
              style: Object.assign({}, selectStyle, { opacity: enabled ? 1 : 0.5 }),
              onChange: (event) => store.update({ preloadScreens: Number(event.target.value) }),
            }, [
              h('option', { key: '1', value: '1' }, t('oneScreen')),
              h('option', { key: '1.5', value: '1.5' }, t('oneAndHalfScreens')),
              h('option', { key: '2', value: '2' }, t('twoScreens')),
            ]),
          ]),
          h('label', { key: 'pages-label', style: labeledControlStyle }, [
            t('prefetch'),
            h('select', {
              key: 'pages',
              value: String(value.prefetchPages),
              'aria-label': t('prefetch'),
              disabled: !enabled,
              style: Object.assign({}, selectStyle, { opacity: enabled ? 1 : 0.5 }),
              onChange: (event) => store.update({ prefetchPages: Number(event.target.value) }),
            }, [
              h('option', { key: '0', value: '0' }, t('off')),
              h('option', { key: '1', value: '1' }, t('onePage')),
              h('option', { key: '2', value: '2' }, t('twoPages')),
            ]),
          ]),
          h('button', {
            key: 'switch',
            type: 'button',
            role: 'switch',
            'aria-checked': enabled,
            'aria-label': t('toggle'),
            title: enabled ? t('enabled') : t('disabled'),
            style: switchStyle(enabled),
            onClick: () => store.update({ enabled: !enabled }),
          }, h('span', { style: knobStyle(enabled) })),
        ]),
      ]);
    }

    // ---------------------------------------------------------------------
    // Plugin entry.
    // ---------------------------------------------------------------------

    function apply(ctx) {
      const store = new SettingsStore();
      rowStore = store;
      ctx.effect(() => () => store.dispose(), 'fast-history: settings store');
      try {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'fast-history: locale');
      } catch {
        /* locale is optional; the row falls back to navigator.language */
      }
      try {
        const removeRow = ctx.slots.inject('settings.general.item', () => ctx.slots.register({
          name: 'settings.general.item',
          id: 'fast-history',
          order: 60,
          locale: NS,
          inject: () => ({ fastHistoryStore: store }),
        }, FastHistorySettingsRow));
        if (typeof removeRow === 'function') {
          ctx.effect(() => removeRow, 'fast-history: settings row');
        }
      } catch {
        /* the core still works without a settings row */
      }

      let controller = null;
      const boot = () => {
        if (controller || !document.body) return;
        try {
          controller = new HistoryController(ctx, store);
          controller.start();
        } catch (error) {
          controller = null;
          try {
            console.warn('[dsh-fast-history] controller failed to start', error);
          } catch {
            /* ignore */
          }
        }
      };
      ctx.effect(() => {
        if (document.body) {
          boot();
        } else {
          document.addEventListener('DOMContentLoaded', boot, { once: true });
        }
        return () => {
          document.removeEventListener('DOMContentLoaded', boot);
          if (controller) {
            controller.dispose();
            controller = null;
          }
          rowStore = null;
        };
      }, 'fast-history: controller');
    }

    return {
      inject: ['sessions', 'slots', 'locale'],
      apply,
      __internals: {
        VERSION,
        NS,
        SETTINGS_KEY,
        DEBUG_KEY,
        DEFAULTS,
        normalizeSettings,
        autoMarginPx,
        openWindowAllowed,
        pagerText,
        findPagerButton,
        topVisibleRow,
        findRowByKey,
        elementVisible,
        mutationMightChangeBinding,
        isEditable,
        isMobileOverlay,
        isMobileContext,
        nearestNestedScroller,
        SettingsStore,
        HistoryController,
        FastHistorySettingsRow,
        constants: {
          COOLDOWN_MS,
          PAGE_TIMEOUT_MS,
          PREFETCH_DELAY_MS,
          PAGER_CLICK_MAX_PX,
          CHAIN_GAP_MS,
          MAX_CHAIN_PAGES,
          MAX_OPEN_ENTRIES,
          MAX_PAGE_ENTRIES,
          MAX_PREFETCH_ENTRIES,
        },
      },
    };
  },
});

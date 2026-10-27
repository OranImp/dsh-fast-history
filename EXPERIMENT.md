# Experimental branch: mobile-seamless (0.3.0-exp.1)

This directory is the working copy for the **`experiment/mobile-seamless`** branch. It is not the stable 0.2.5 source.

## Why this branch exists

The stable 0.2.5 loader fixes the pager jump, but on a phone history could still reach the visible **Load earlier** control before the next page was ready. Two reasons:

1. A short first page plus a small prefetch target can leave less than one screen of loaded history above the tail, so the pager is already visible.
2. `dsh-mobile` has its own 64 px gate and a different scroll/layout wrapper; a client only listening to one scroller/marker can miss the real scrollport.

## Experiments in this branch

- **Minimum history buffer**: after open, keep pulling pages until `scrollHeight >= clientHeight × bufferScreens` (default 3 screens, cap 4 pages), independent of the normal prefetch count. This makes the pager sit far above the viewport instead of in view.
- **Real scrollport resolver**: prefer the visible scrollable ancestor of `[data-chat-flow]`, including `[data-chat-message-scroll]` / `[data-dsh-mobile-message-scroll]`, with `[data-conversation-scroll]` as the normal fallback.
- **dsh-mobile pager interception**: all mobile pager clicks, including `button.click()` from dsh-mobile, are routed through the anchored direct path.
- **Hover prewarm (open-speed experiment)**: hovering a session row (`[data-row-key="session:<id>"]`) for ~220 ms calls the cold-safe `ctx.remote.session.page` with a one-message page. The host parses/caches the session before the click; the click then reuses the prepared session. TTL is 60 s and already-open sessions are skipped. This is best-effort: failures are swallowed and never block opening.
- **Diagnostics**: `window.__DSH_FAST_HISTORY__.diagnostics()` now always exposes the selected scroller, scrollHeight/clientHeight, buffer shortfall, pager distance, `dshMobile`, and buffer page counts.

## Settings

`localStorage['dsh-fast-history.settings.v1']`:

```json
{
  "enabled": true,
  "prefetchPages": 1,
  "thresholdPx": 96,
  "preloadScreens": 1.5,
  "bufferScreens": 3,
  "prewarm": true
}
```

- `bufferScreens`: 2 / 3 / 4 (also in Settings → General → History loading).
- `prewarm`: experimental; set `false` to disable hover prewarming.
- `prefetchPages`: normal prefetch count; the buffer can pull extra pages beyond it.

## Verification

```bash
node --test test/*.test.mjs
/home/dsh/work/AI自主运营/tools/browser/.venv/bin/python test/browser_test.py
```

Covered: 12 unit checks; page/anchor/scrolltop regressions; no-anchor mobile top; synthetic and trusted mobile pager; four-screen buffer; hover prewarm request shape.

## Risks

- The buffer loads more history than stable; watch host CPU and memory on huge logs. The existing entry/page caps still apply.
- Hover prewarm intentionally parses a session before it is opened. It is cold-safe (no Agent turn), but it uses the host prepared-session cache and may be expensive for very large logs. Disable with `prewarm: false` if it hurts.
- The real DSH Web GUI is not automated in this environment (the running GUI needs auth); phone feel still needs a real device check.

## Rollback

Install the stable package directory back:

```bash
plugin_manager action=install_bundle target="/home/dsh/work/dsh会话快速加载插件/dsh-fast-history"
```

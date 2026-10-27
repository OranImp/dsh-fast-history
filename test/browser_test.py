#!/usr/bin/env python3
"""Browser-level smoke test for dsh-fast-history.

Requires a Python Playwright environment and a Chromium build. No machine-
specific path is assumed: set CHROMIUM_PATH or let Playwright's browser cache
be discovered under PLAYWRIGHT_BROWSERS_PATH / ~/.cache/ms-playwright. The
fixture mimics the official Chat DOM and SessionFace surface; it does not need
the DSH GUI or its auth token.
"""

from __future__ import annotations

import functools
import http.server
import json
import os
import pathlib
import socketserver
import threading

from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent


def find_chromium() -> str:
    explicit = os.environ.get("CHROMIUM_PATH")
    if explicit:
        return explicit
    cache = pathlib.Path(
        os.environ.get(
            "PLAYWRIGHT_BROWSERS_PATH",
            pathlib.Path.home() / ".cache" / "ms-playwright",
        )
    )
    matches = sorted(cache.glob("chromium-*/chrome-linux/chrome"))
    return str(matches[-1]) if matches else ""


CHROMIUM = find_chromium()


def serve() -> tuple[socketserver.TCPServer, str]:
    handler = functools.partial(
        http.server.SimpleHTTPRequestHandler,
        directory=str(ROOT),
    )
    server = socketserver.TCPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_address[1]
    return server, f"http://127.0.0.1:{port}"


def main() -> None:
    server, base = serve()
    errors: list[str] = []
    try:
        with sync_playwright() as p:
            launch_options = {"headless": True, "args": ["--no-sandbox"]}
            if CHROMIUM and pathlib.Path(CHROMIUM).is_file():
                launch_options["executable_path"] = CHROMIUM
            browser = p.chromium.launch(**launch_options)
            page = browser.new_page(viewport={"width": 900, "height": 700})
            page.on("pageerror", lambda error: errors.append(f"pageerror: {error}"))
            page.on(
                "console",
                lambda message: errors.append(f"console.{message.type}: {message.text}")
                if message.type == "error"
                else None,
            )
            page.goto(f"{base}/test/fixture.html")
            page.add_script_tag(path=str(ROOT / "client.js"))
            page.evaluate(
                """() => {
                  localStorage.setItem('dsh-fast-history.settings.v1', JSON.stringify({
                    enabled: true, prefetchPages: 1, thresholdPx: 96, preloadScreens: 1.5,
                  }));
                  localStorage.setItem('dsh-fast-history.debug', '1');
                }"""
            )
            page.evaluate("() => window.__applyPlugin()")

            box = page.locator("#scroller").bounding_box()
            assert box is not None

            def stats() -> dict:
                return page.evaluate("() => window.__DSH_FAST_HISTORY__.stats()")

            def count() -> int:
                return page.evaluate("() => window.__loadCount || 0")

            def set_scroll(top: int) -> None:
                page.evaluate(
                    "(top) => { document.getElementById('scroller').scrollTop = top; }",
                    top,
                )

            def arm_wheel() -> None:
                page.mouse.move(
                    box["x"] + box["width"] / 2,
                    box["y"] + box["height"] / 2,
                )
                page.mouse.wheel(0, -10)

            page.wait_for_timeout(1700)
            print("after prefetch:", count(), json.dumps(stats(), ensure_ascii=False))
            assert count() == 1, f"expected one prefetch page, got {count()}"
            assert stats()["prefetchLoads"] == 1
            assert stats()["prefetchedPages"] == 1

            # Experimental buffer: with a tall phone scrollport and a 4-screen
            # target, keep pulling pages until the head is far enough above the
            # viewport. This is what makes the pager disappear silently.
            buffer_page = browser.new_page(viewport={"width": 900, "height": 700})
            buffer_page.on("pageerror", lambda error: errors.append(f"buffer pageerror: {error}"))
            buffer_page.goto(f"{base}/test/fixture.html")
            buffer_page.add_style_tag(content="#scroller { height: 600px; }")
            buffer_page.add_script_tag(path=str(ROOT / "client.js"))
            buffer_page.evaluate(
                """() => {
                  localStorage.setItem('dsh-fast-history.settings.v1', JSON.stringify({
                    enabled: true, prefetchPages: 0, thresholdPx: 96,
                    preloadScreens: 1.5, bufferScreens: 4,
                  }));
                  localStorage.setItem('dsh-fast-history.debug', '1');
                }"""
            )
            buffer_page.evaluate("() => window.__applyPlugin()")
            buffer_page.wait_for_timeout(5200)
            buffer_stats = buffer_page.evaluate(
                "() => window.__DSH_FAST_HISTORY__.stats()"
            )
            buffer_diag = buffer_page.evaluate(
                "() => window.__DSH_FAST_HISTORY__.diagnostics()"
            )
            buffer_count = buffer_page.evaluate("() => window.__loadCount || 0")
            print(
                "buffer pages:",
                buffer_count,
                json.dumps(buffer_stats, ensure_ascii=False),
                json.dumps(buffer_diag, ensure_ascii=False),
            )
            assert buffer_count >= 3, f"buffer should load multiple pages, got {buffer_count}"
            assert buffer_stats["bufferedPages"] >= 3, buffer_stats
            assert buffer_diag["scrollHeight"] >= 2400, buffer_diag
            assert buffer_diag["bufferShortfallPx"] == 0, buffer_diag

            # Experimental prewarm: hovering a sidebar session row should hit
            # the cold-safe page Remote once (the host prepares the session).
            prewarm_page = browser.new_page(viewport={"width": 900, "height": 700})
            prewarm_page.on("pageerror", lambda error: errors.append(f"prewarm pageerror: {error}"))
            prewarm_page.goto(f"{base}/test/fixture.html")
            prewarm_page.add_script_tag(path=str(ROOT / "client.js"))
            prewarm_page.evaluate(
                """() => {
                  localStorage.setItem('dsh-fast-history.settings.v1', JSON.stringify({
                    enabled: true, prefetchPages: 0, thresholdPx: 96,
                    preloadScreens: 1.5, bufferScreens: 2, prewarm: true,
                  }));
                }"""
            )
            prewarm_page.evaluate("() => window.__applyPlugin()")
            prewarm_page.wait_for_timeout(100)
            prewarm_page.evaluate(
                """() => document.getElementById('session-row').dispatchEvent(
                  new PointerEvent('pointerover', { bubbles: true })
                )"""
            )
            prewarm_page.wait_for_timeout(500)
            prewarm_requests = prewarm_page.evaluate("() => window.__prewarmRequests")
            print("prewarm requests:", json.dumps(prewarm_requests, ensure_ascii=False))
            assert len(prewarm_requests) == 1, prewarm_requests
            assert prewarm_requests[0]["address"]["sessionId"] == "warm-1", prewarm_requests
            assert prewarm_requests[0]["maxMessages"] == 1, prewarm_requests

            # 1. Early load: the pager is offscreen (scrollTop 500 > 96) but the
            #    scroll position is inside the 1.5-screen lead margin (600px).
            set_scroll(500)
            pager_above = page.evaluate(
                """() => {
                  const scroller = document.getElementById('scroller');
                  const pager = document.getElementById('pager');
                  return pager.getBoundingClientRect().bottom
                    <= scroller.getBoundingClientRect().top;
                }"""
            )
            assert pager_above, "pager should be above the viewport for the early-load check"
            arm_wheel()
            page.wait_for_timeout(800)
            print("after early load:", count(), json.dumps(stats(), ensure_ascii=False))
            assert count() == 2, f"expected one early page, got {count()}"
            assert stats()["autoMarginPx"] == 600, stats()
            assert stats()["lastDriftPx"] is None or abs(stats()["lastDriftPx"]) < 2, stats()
            assert page.evaluate("() => document.getElementById('scroller').scrollTop") > 0

            # 2. Chain: widen the lead to 2 screens (800px). One page is 360px,
            #    so after the first page the head is still within the margin and
            #    the plugin should load a second page without waiting for the top.
            page.evaluate(
                "() => window.__DSH_FAST_HISTORY__.setSettings({ preloadScreens: 2 })"
            )
            page.wait_for_timeout(100)
            set_scroll(300)
            page.wait_for_timeout(260)
            arm_wheel()
            page.wait_for_timeout(1200)
            print("after chain:", count(), json.dumps(stats(), ensure_ascii=False))
            assert count() == 4, f"expected initial + one chain page, got {count()}"
            assert stats()["chainLoads"] >= 1, stats()
            assert stats()["chainCount"] >= 2, stats()
            assert stats()["autoMarginPx"] == 800, stats()

            # 3. The official pager still works (manual path), offscreen here.
            page.evaluate("() => document.getElementById('pager').click()")
            page.wait_for_timeout(400)
            print("after manual pager:", count())
            assert count() == 5, f"manual pager should still work, got {count()}"

            # 4. Disposal removes listeners and the debug global; manual pager
            #    remains owned by the app and still works.
            page.evaluate("() => window.__cleanup()")
            set_scroll(500)
            arm_wheel()
            page.wait_for_timeout(600)
            has_debug = page.evaluate("() => '__DSH_FAST_HISTORY__' in window")
            print("after cleanup:", count(), "debug-global:", has_debug)
            assert count() == 5, f"cleanup left auto-load listeners: {count()}"
            assert has_debug is False, "debug API was not removed on dispose"

            page.evaluate("() => document.getElementById('pager').click()")
            page.wait_for_timeout(400)
            print("manual after cleanup:", count())
            assert count() == 6, f"manual pager after cleanup should work, got {count()}"

            # 5. Mobile overlay: the dedicated dsh-mobile layout must keep the
            #    touch loader active, and a taller decoy conversation must not
            #    steal the binding. The decoy has a different session id and no
            #    binding, so a height-only choice would load nothing.
            mobile = browser.new_page(viewport={"width": 390, "height": 760})
            mobile.on("pageerror", lambda error: errors.append(f"mobile pageerror: {error}"))
            mobile.on(
                "console",
                lambda message: errors.append(f"mobile console.{message.type}: {message.text}")
                if message.type == "error"
                else None,
            )
            mobile.goto(f"{base}/test/fixture.html")
            mobile.add_script_tag(path=str(ROOT / "client.js"))
            mobile.evaluate(
                """() => {
                  localStorage.setItem('dsh-fast-history.settings.v1', JSON.stringify({
                    enabled: true, prefetchPages: 1, thresholdPx: 96, preloadScreens: 1.5,
                  }));
                  localStorage.setItem('dsh-fast-history.debug', '1');
                }"""
            )
            mobile.evaluate(
                """() => {
                  const conversation = document.getElementById('conversation');
                  const main = document.createElement('div');
                  main.className = 'dshm-main';
                  main.dataset.dshMobileSession = 's1';
                  conversation.parentNode.insertBefore(main, conversation);
                  main.appendChild(conversation);

                  const decoy = document.createElement('div');
                  decoy.setAttribute('data-conversation-session', 'decoy');
                  decoy.innerHTML = '<div data-conversation-scroll="" style="height:800px;overflow-y:auto">'
                    + '<div data-chat-flow=""><div style="height:800px"></div></div></div>';
                  document.body.appendChild(decoy);
                }"""
            )
            mobile.evaluate("() => window.__applyPlugin()")
            mobile.wait_for_timeout(1700)
            mstats = mobile.evaluate("() => window.__DSH_FAST_HISTORY__.stats()")
            mcount = mobile.evaluate("() => window.__loadCount || 0")
            print("mobile after prefetch:", mcount, json.dumps(mstats, ensure_ascii=False))
            assert mstats["sessionId"] == "s1", mstats
            assert mstats["prefetchLoads"] == 1, mstats

            # Move to the lead window first and let its scroll event settle, then
            # start a fast touch fling. In a real fling scrollTop decreases as
            # the finger moves down; the synthetic scroll event from setting the
            # position must not arrive after touchstart and disarm the gesture.
            mobile.evaluate(
                """() => {
                  const scroller = document.getElementById('scroller');
                  scroller.scrollTop = 500;
                }"""
            )
            mobile.wait_for_timeout(200)
            mobile.evaluate(
                """() => {
                  const row = document.querySelector('[data-chat-anchor-key]');
                  const start = new Event('touchstart', { bubbles: true, cancelable: true });
                  Object.defineProperty(start, 'touches', { value: [{ clientY: 300 }] });
                  row.dispatchEvent(start);
                  const move = new Event('touchmove', { bubbles: true, cancelable: true });
                  Object.defineProperty(move, 'touches', { value: [{ clientY: 360 }] });
                  row.dispatchEvent(move);
                  document.getElementById('scroller').dispatchEvent(
                    new Event('touchend', { bubbles: true })
                  );
                }"""
            )
            mobile.wait_for_timeout(800)
            mstats = mobile.evaluate("() => window.__DSH_FAST_HISTORY__.stats()")
            mcount = mobile.evaluate("() => window.__loadCount || 0")
            mpager = mobile.evaluate("() => window.__pagerClicks || 0")
            print("mobile after touch:", mcount, "pager:", mpager, json.dumps(mstats, ensure_ascii=False))
            assert mcount == 2, f"touch swipe should load one page, got {mcount}"
            assert mstats["autoLoads"] == 1, mstats
            assert mstats["lastDriftPx"] is None or abs(mstats["lastDriftPx"]) < 2, mstats
            assert mpager == 0, f"mobile auto-load must not click the pager, got {mpager}"
            assert mobile.evaluate("() => document.getElementById('scroller').scrollTop") > 0

            # 5b. Fast fling stress: rapid scrollTop changes into the lead must
            #     not start a load mid-gesture. It should arm a pending load and
            #     fire only after the scroll has been quiet for the settle window.
            mobile.evaluate(
                """() => {
                  const scroller = document.getElementById('scroller');
                  scroller.dispatchEvent(new Event('touchend', { bubbles: true }));
                  scroller.scrollTop = 1000;
                  scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
                }"""
            )
            mobile.wait_for_timeout(250)
            mobile.evaluate(
                """() => {
                  const scroller = document.getElementById('scroller');
                  const row = document.querySelector('[data-chat-anchor-key]');
                  const start = new Event('touchstart', { bubbles: true, cancelable: true });
                  Object.defineProperty(start, 'touches', { value: [{ clientY: 300 }] });
                  row.dispatchEvent(start);
                  for (const top of [840, 720, 600, 480, 360, 300]) {
                    scroller.scrollTop = top;
                    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
                  }
                  const move = new Event('touchmove', { bubbles: true, cancelable: true });
                  Object.defineProperty(move, 'touches', { value: [{ clientY: 380 }] });
                  row.dispatchEvent(move);
                }"""
            )
            mobile.wait_for_timeout(80)
            fast_stats = mobile.evaluate("() => window.__DSH_FAST_HISTORY__.stats()")
            fast_count = mobile.evaluate("() => window.__loadCount || 0")
            print("mobile during fast fling:", fast_count, json.dumps(fast_stats, ensure_ascii=False))
            assert fast_count == 2, f"fast fling must not load before settle, got {fast_count}"
            assert fast_stats["pendingLoadAfterSettle"] is True, fast_stats
            assert fast_stats["fastScrolling"] is True, fast_stats
            # The deferred load must remain deferred while the finger is down;
            # lifting it lets the settle timer fire exactly one page.
            mobile.evaluate(
                "() => document.getElementById('scroller').dispatchEvent(new Event('touchend', { bubbles: true }))"
            )
            mobile.wait_for_timeout(500)
            settled_stats = mobile.evaluate("() => window.__DSH_FAST_HISTORY__.stats()")
            settled_count = mobile.evaluate("() => window.__loadCount || 0")
            print("mobile after fast settle:", settled_count, json.dumps(settled_stats, ensure_ascii=False))
            assert settled_count == 3, f"fast fling should load once after settle, got {settled_count}"
            assert mobile.evaluate("() => window.__pagerClicks || 0") == 0
            assert settled_stats["lastDriftPx"] is None or abs(settled_stats["lastDriftPx"]) < 2, settled_stats

            # 5c. True top on mobile: a direct load plus the plugin's own
            #     old-top-row correction. The official pager anchors the first
            #     paging seat, which can land on the next pager on a phone.
            before_top = mobile.evaluate("() => window.__loadCount || 0")
            mobile.evaluate(
                """() => {
                  const scroller = document.getElementById('scroller');
                  scroller.dispatchEvent(new Event('touchend', { bubbles: true }));
                  scroller.scrollTop = 0;
                }"""
            )
            mobile.wait_for_timeout(250)
            mobile.evaluate(
                """() => {
                  const row = document.querySelector('[data-chat-anchor-key]');
                  const start = new Event('touchstart', { bubbles: true, cancelable: true });
                  Object.defineProperty(start, 'touches', { value: [{ clientY: 300 }] });
                  row.dispatchEvent(start);
                  const move = new Event('touchmove', { bubbles: true, cancelable: true });
                  Object.defineProperty(move, 'touches', { value: [{ clientY: 340 }] });
                  row.dispatchEvent(move);
                  const end = new Event('touchend', { bubbles: true, cancelable: true });
                  row.dispatchEvent(end);
                }"""
            )
            mobile.wait_for_timeout(900)
            top_stats = mobile.evaluate("() => window.__DSH_FAST_HISTORY__.stats()")
            top_count = mobile.evaluate("() => window.__loadCount || 0")
            top_pager = mobile.evaluate("() => window.__pagerClicks || 0")
            top_scroll = mobile.evaluate("() => document.getElementById('scroller').scrollTop")
            print("mobile top direct:", top_count, "pager:", top_pager, "scrollTop:", top_scroll, json.dumps(top_stats, ensure_ascii=False))
            assert top_count == before_top + 1, f"top pull should add exactly one page, got {top_count - before_top}"
            assert top_pager == 0, f"mobile top must not click the pager, got {top_pager}"
            assert top_scroll > 4, f"top direct load did not preserve the reading anchor: {top_scroll}"
            assert top_stats["lastDriftPx"] is None or abs(top_stats["lastDriftPx"]) < 2, top_stats
            assert top_stats["chainLoads"] == 0, f"top pull must not chain, got {top_stats['chainLoads']}"
            mobile.wait_for_timeout(500)
            assert mobile.evaluate("() => window.__loadCount || 0") == top_count, "top loading looped after settle"

            # 5d. Plain phone browser (no dsh-mobile overlay): the mobile
            #     interaction context must still be detected from the narrow
            #     viewport/coarse pointer, not only from .dshm-main.
            phone = browser.new_page(
                viewport={"width": 390, "height": 760},
                has_touch=True,
                is_mobile=True,
            )
            phone.on("pageerror", lambda error: errors.append(f"phone pageerror: {error}"))
            phone.on(
                "console",
                lambda message: errors.append(f"phone console.{message.type}: {message.text}")
                if message.type == "error"
                else None,
            )
            phone.goto(f"{base}/test/fixture.html")
            phone.add_script_tag(path=str(ROOT / "client.js"))
            phone.evaluate(
                """() => {
                  localStorage.setItem('dsh-fast-history.settings.v1', JSON.stringify({
                    enabled: true, prefetchPages: 1, thresholdPx: 96, preloadScreens: 1.5,
                  }));
                  localStorage.setItem('dsh-fast-history.debug', '1');
                }"""
            )
            phone.evaluate("() => window.__applyPlugin()")
            phone.wait_for_timeout(1700)
            phone_stats = phone.evaluate("() => window.__DSH_FAST_HISTORY__.stats()")
            phone_diag = phone.evaluate("() => window.__DSH_FAST_HISTORY__.diagnostics()")
            phone_count = phone.evaluate("() => window.__loadCount || 0")
            print("phone after prefetch:", phone_count, json.dumps(phone_diag, ensure_ascii=False))
            assert phone_count == 1, f"phone prefetch should load one page, got {phone_count}"
            assert phone_diag["mobileContext"] is True, phone_diag
            assert phone_stats["prefetchLoads"] == 1, phone_stats

            phone.evaluate(
                """() => {
                  const scroller = document.getElementById('scroller');
                  scroller.scrollTop = 500;
                }"""
            )
            phone.wait_for_timeout(200)
            phone.evaluate(
                """() => {
                  const row = document.querySelector('[data-chat-anchor-key]');
                  const start = new Event('touchstart', { bubbles: true, cancelable: true });
                  Object.defineProperty(start, 'touches', { value: [{ clientY: 300 }] });
                  row.dispatchEvent(start);
                  const move = new Event('touchmove', { bubbles: true, cancelable: true });
                  Object.defineProperty(move, 'touches', { value: [{ clientY: 360 }] });
                  row.dispatchEvent(move);
                  document.getElementById('scroller').dispatchEvent(
                    new Event('touchend', { bubbles: true })
                  );
                }"""
            )
            phone.wait_for_timeout(800)
            phone_count = phone.evaluate("() => window.__loadCount || 0")
            phone_pager = phone.evaluate("() => window.__pagerClicks || 0")
            phone_stats = phone.evaluate("() => window.__DSH_FAST_HISTORY__.stats()")
            print("phone after touch:", phone_count, "pager:", phone_pager, json.dumps(phone_stats, ensure_ascii=False))
            assert phone_count == 2, f"phone touch should load one page, got {phone_count}"
            assert phone_pager == 0, f"phone early load must not click the pager, got {phone_pager}"
            assert phone_stats["lastDriftPx"] is None or abs(phone_stats["lastDriftPx"]) < 2, phone_stats

            # 5e. Mobile top with the browser's own anchor deliberately absent:
            #     the plugin must keep the old top row itself, not land on the
            #     new pager. This is the regression for "jump to next Load
            #     earlier" on phones.
            no_anchor_mobile = browser.new_page(
                viewport={"width": 390, "height": 760},
                has_touch=True,
                is_mobile=True,
            )
            no_anchor_mobile.on(
                "pageerror",
                lambda error: errors.append(f"no-anchor mobile pageerror: {error}"),
            )
            no_anchor_mobile.goto(f"{base}/test/fixture.html")
            no_anchor_mobile.add_script_tag(path=str(ROOT / "client.js"))
            no_anchor_mobile.evaluate(
                """() => {
                  window.__noAnchor = true;
                  localStorage.setItem('dsh-fast-history.settings.v1', JSON.stringify({
                    enabled: true, prefetchPages: 0, thresholdPx: 96, preloadScreens: 1.5,
                  }));
                  localStorage.setItem('dsh-fast-history.debug', '1');
                }"""
            )
            no_anchor_mobile.evaluate("() => window.__applyPlugin()")
            no_anchor_mobile.wait_for_timeout(300)
            no_anchor_mobile.evaluate(
                """() => {
                  const scroller = document.getElementById('scroller');
                  scroller.scrollTop = 0;
                  const row = document.querySelector('[data-chat-anchor-key]');
                  const start = new Event('touchstart', { bubbles: true, cancelable: true });
                  Object.defineProperty(start, 'touches', { value: [{ clientY: 300 }] });
                  row.dispatchEvent(start);
                  const move = new Event('touchmove', { bubbles: true, cancelable: true });
                  Object.defineProperty(move, 'touches', { value: [{ clientY: 340 }] });
                  row.dispatchEvent(move);
                  row.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));
                }"""
            )
            no_anchor_mobile.wait_for_timeout(1000)
            na_mobile_stats = no_anchor_mobile.evaluate(
                "() => window.__DSH_FAST_HISTORY__.stats()"
            )
            na_mobile_count = no_anchor_mobile.evaluate("() => window.__loadCount || 0")
            na_mobile_pager = no_anchor_mobile.evaluate("() => window.__pagerClicks || 0")
            na_mobile_scroll = no_anchor_mobile.evaluate(
                "() => document.getElementById('scroller').scrollTop"
            )
            print(
                "no-anchor mobile top:",
                na_mobile_count,
                "pager:",
                na_mobile_pager,
                "scrollTop:",
                na_mobile_scroll,
                json.dumps(na_mobile_stats, ensure_ascii=False),
            )
            assert na_mobile_count == 1, f"expected one top page, got {na_mobile_count}"
            assert na_mobile_pager == 0, na_mobile_pager
            assert na_mobile_scroll > 4, f"old top row was not held: {na_mobile_scroll}"
            assert na_mobile_stats["lastDriftPx"] is None or abs(
                na_mobile_stats["lastDriftPx"]
            ) < 2, na_mobile_stats
            assert na_mobile_stats["chainLoads"] == 0, na_mobile_stats

            # 5f. dsh-mobile style synthetic pager click. Its 64 px gate calls
            #     button.click(); the plugin must swallow that untrusted click
            #     and use the anchored direct path instead of beginPaging.
            synthetic = browser.new_page(
                viewport={"width": 390, "height": 760},
                has_touch=True,
                is_mobile=True,
            )
            synthetic.on(
                "pageerror",
                lambda error: errors.append(f"synthetic pager pageerror: {error}"),
            )
            synthetic.goto(f"{base}/test/fixture.html")
            synthetic.add_script_tag(path=str(ROOT / "client.js"))
            synthetic.evaluate(
                """() => {
                  window.__noAnchor = true;
                  localStorage.setItem('dsh-fast-history.settings.v1', JSON.stringify({
                    enabled: true, prefetchPages: 0, thresholdPx: 96, preloadScreens: 1.5,
                  }));
                  localStorage.setItem('dsh-fast-history.debug', '1');
                }"""
            )
            synthetic.evaluate("() => window.__applyPlugin()")
            synthetic.wait_for_timeout(300)
            synthetic.evaluate(
                """() => {
                  document.getElementById('scroller').scrollTop = 0;
                  document.getElementById('pager').click();
                }"""
            )
            synthetic.wait_for_timeout(900)
            synthetic_stats = synthetic.evaluate(
                "() => window.__DSH_FAST_HISTORY__.stats()"
            )
            synthetic_count = synthetic.evaluate("() => window.__loadCount || 0")
            synthetic_pager = synthetic.evaluate("() => window.__pagerClicks || 0")
            synthetic_scroll = synthetic.evaluate(
                "() => document.getElementById('scroller').scrollTop"
            )
            print(
                "synthetic pager:",
                synthetic_count,
                "pager:",
                synthetic_pager,
                "scrollTop:",
                synthetic_scroll,
                json.dumps(synthetic_stats, ensure_ascii=False),
            )
            assert synthetic_count == 1, f"synthetic click should load one page, got {synthetic_count}"
            assert synthetic_pager == 0, f"synthetic click must be intercepted, got {synthetic_pager}"
            assert synthetic_scroll > 4, f"synthetic click anchor failed: {synthetic_scroll}"
            assert synthetic_stats["lastDriftPx"] is None or abs(
                synthetic_stats["lastDriftPx"]
            ) < 2, synthetic_stats
            assert synthetic_stats["chainLoads"] == 0, synthetic_stats

            # 5g. A real tap on the official pager on a phone is also routed
            #     through the same anchored direct path, so manual use cannot
            #     land on the next pager either.
            manual_mobile = browser.new_page(
                viewport={"width": 390, "height": 760},
                has_touch=True,
                is_mobile=True,
            )
            manual_mobile.on(
                "pageerror",
                lambda error: errors.append(f"manual mobile pager pageerror: {error}"),
            )
            manual_mobile.goto(f"{base}/test/fixture.html")
            manual_mobile.add_script_tag(path=str(ROOT / "client.js"))
            manual_mobile.evaluate(
                """() => {
                  window.__noAnchor = true;
                  localStorage.setItem('dsh-fast-history.settings.v1', JSON.stringify({
                    enabled: true, prefetchPages: 0, thresholdPx: 96, preloadScreens: 1.5,
                    hidePager: false,
                  }));
                  localStorage.setItem('dsh-fast-history.debug', '1');
                }"""
            )
            manual_mobile.evaluate("() => window.__applyPlugin()")
            manual_mobile.wait_for_timeout(300)
            manual_mobile.locator("#pager").click()
            manual_mobile.wait_for_timeout(900)
            manual_stats = manual_mobile.evaluate(
                "() => window.__DSH_FAST_HISTORY__.stats()"
            )
            manual_count = manual_mobile.evaluate("() => window.__loadCount || 0")
            manual_pager = manual_mobile.evaluate("() => window.__pagerClicks || 0")
            manual_scroll = manual_mobile.evaluate(
                "() => document.getElementById('scroller').scrollTop"
            )
            print(
                "manual mobile pager:",
                manual_count,
                "pager:",
                manual_pager,
                "scrollTop:",
                manual_scroll,
                json.dumps(manual_stats, ensure_ascii=False),
            )
            assert manual_count == 1, f"manual mobile pager should load one page, got {manual_count}"
            assert manual_pager == 0, f"manual mobile pager must be intercepted, got {manual_pager}"
            assert manual_scroll > 4, f"manual mobile pager anchor failed: {manual_scroll}"
            assert manual_stats["lastDriftPx"] is None or abs(
                manual_stats["lastDriftPx"]
            ) < 2, manual_stats
            assert manual_stats["chainLoads"] == 0, manual_stats

            # 6. Desktop top click still uses the official pager (the mobile
            #    suppression above must not disable the anchored path on web).
            top = browser.new_page(viewport={"width": 900, "height": 700})
            top.on("pageerror", lambda error: errors.append(f"pager pageerror: {error}"))
            top.goto(f"{base}/test/fixture.html")
            top.add_script_tag(path=str(ROOT / "client.js"))
            top.evaluate(
                """() => {
                  localStorage.setItem('dsh-fast-history.settings.v1', JSON.stringify({
                    enabled: true, prefetchPages: 1, thresholdPx: 96, preloadScreens: 1,
                  }));
                  localStorage.setItem('dsh-fast-history.debug', '1');
                }"""
            )
            top.evaluate("() => window.__applyPlugin()")
            top.wait_for_timeout(1700)
            assert top.evaluate("() => window.__loadCount || 0") == 1
            top.evaluate("() => { document.getElementById('scroller').scrollTop = 0; }")
            top_box = top.locator("#scroller").bounding_box()
            assert top_box is not None
            top.mouse.move(
                top_box["x"] + top_box["width"] / 2,
                top_box["y"] + top_box["height"] / 2,
            )
            top.mouse.wheel(0, -10)
            top.wait_for_timeout(800)
            tstats = top.evaluate("() => window.__DSH_FAST_HISTORY__.stats()")
            tcount = top.evaluate("() => window.__loadCount || 0")
            tpager = top.evaluate("() => window.__pagerClicks || 0")
            print("desktop top pager:", tcount, "pager:", tpager, json.dumps(tstats, ensure_ascii=False))
            assert tpager == 1, f"desktop top should click the official pager, got {tpager}"
            assert tcount == 2, f"desktop top pager should add exactly one page, got {tcount}"
            assert tstats["autoLoads"] == 1, tstats
            assert tstats["chainLoads"] == 0, f"explicit top pull must not chain, got {tstats['chainLoads']}"

            # 7. Keyboard on body, resync re-arm, aria-hidden rebind, and
            #    top pager without a working anchor.
            keyboard = browser.new_page(viewport={"width": 900, "height": 700})
            keyboard.on("pageerror", lambda error: errors.append(f"keyboard pageerror: {error}"))
            keyboard.goto(f"{base}/test/fixture.html")
            keyboard.add_script_tag(path=str(ROOT / "client.js"))
            keyboard.evaluate(
                """() => {
                  localStorage.setItem('dsh-fast-history.settings.v1', JSON.stringify({
                    enabled: true, prefetchPages: 0, thresholdPx: 96, preloadScreens: 1.5,
                  }));
                  localStorage.setItem('dsh-fast-history.debug', '1');
                }"""
            )
            keyboard.evaluate("() => window.__applyPlugin()")
            keyboard.wait_for_timeout(300)
            keyboard.evaluate("() => { document.getElementById('scroller').scrollTop = 500; }")
            keyboard.wait_for_timeout(120)
            keyboard.evaluate(
                """() => document.body.dispatchEvent(new KeyboardEvent('keydown', {
                  key: 'PageUp', bubbles: true, cancelable: true,
                }))"""
            )
            keyboard.wait_for_timeout(900)
            keyboard_count = keyboard.evaluate("() => window.__loadCount || 0")
            keyboard_stats = keyboard.evaluate("() => window.__DSH_FAST_HISTORY__.stats()")
            print("keyboard body:", keyboard_count, json.dumps(keyboard_stats, ensure_ascii=False))
            assert keyboard_count >= 1, f"body-focused PageUp should load, got {keyboard_count}"
            assert keyboard.evaluate("() => window.__pagerClicks || 0") == 0

            resync = browser.new_page(viewport={"width": 900, "height": 700})
            resync.on("pageerror", lambda error: errors.append(f"resync pageerror: {error}"))
            resync.goto(f"{base}/test/fixture.html")
            resync.add_script_tag(path=str(ROOT / "client.js"))
            resync.evaluate(
                """() => {
                  localStorage.setItem('dsh-fast-history.settings.v1', JSON.stringify({
                    enabled: true, prefetchPages: 1, thresholdPx: 96, preloadScreens: 1.5,
                  }));
                  localStorage.setItem('dsh-fast-history.debug', '1');
                }"""
            )
            resync.evaluate("() => window.__applyPlugin()")
            resync.wait_for_timeout(1800)
            before_resync = resync.evaluate("() => window.__loadCount || 0")
            assert before_resync == 1, before_resync
            resync.evaluate("() => window.__fixture.resync()")
            resync.wait_for_timeout(2600)
            after_resync = resync.evaluate("() => window.__loadCount || 0")
            resync_stats = resync.evaluate("() => window.__DSH_FAST_HISTORY__.stats()")
            print("resync re-arm:", after_resync, json.dumps(resync_stats, ensure_ascii=False))
            assert after_resync == 2, f"resync should re-arm prefetch, got {after_resync}"

            resync.evaluate(
                """() => {
                  const root = document.getElementById('conversation');
                  const wrap = document.createElement('div');
                  wrap.id = 'panel-wrap';
                  wrap.setAttribute('aria-hidden', 'true');
                  root.parentNode.insertBefore(wrap, root);
                  wrap.appendChild(root);
                }"""
            )
            resync.wait_for_timeout(300)
            resync.evaluate(
                """() => {
                  const wrap = document.getElementById('panel-wrap');
                  const root = document.getElementById('conversation');
                  wrap.parentNode.insertBefore(root, wrap);
                  wrap.remove();
                }"""
            )
            resync.wait_for_timeout(1900)
            after_rebind = resync.evaluate("() => window.__loadCount || 0")
            print("after aria-hidden rebind:", after_rebind)
            assert after_rebind == 2, f"same-session rebind must not re-prefetch, got {after_rebind}"

            no_anchor = browser.new_page(viewport={"width": 900, "height": 700})
            no_anchor.on("pageerror", lambda error: errors.append(f"no-anchor pageerror: {error}"))
            no_anchor.goto(f"{base}/test/fixture.html")
            no_anchor.add_script_tag(path=str(ROOT / "client.js"))
            no_anchor.evaluate(
                """() => {
                  window.__noAnchor = true;
                  localStorage.setItem('dsh-fast-history.settings.v1', JSON.stringify({
                    enabled: true, prefetchPages: 0, thresholdPx: 96, preloadScreens: 1.5,
                  }));
                  localStorage.setItem('dsh-fast-history.debug', '1');
                }"""
            )
            no_anchor.evaluate("() => window.__applyPlugin()")
            no_anchor.wait_for_timeout(300)
            no_anchor.evaluate("() => { document.getElementById('scroller').scrollTop = 0; }")
            nb = no_anchor.locator("#scroller").bounding_box()
            assert nb is not None
            no_anchor.mouse.move(nb["x"] + nb["width"] / 2, nb["y"] + nb["height"] / 2)
            no_anchor.mouse.wheel(0, -10)
            no_anchor.wait_for_timeout(900)
            na_stats = no_anchor.evaluate("() => window.__DSH_FAST_HISTORY__.stats()")
            na_count = no_anchor.evaluate("() => window.__loadCount || 0")
            na_pager = no_anchor.evaluate("() => window.__pagerClicks || 0")
            print("no-anchor top:", na_count, "pager:", na_pager, json.dumps(na_stats, ensure_ascii=False))
            assert na_pager == 1, f"top should use the pager once, got {na_pager}"
            assert na_count == 1, f"no-anchor top must not chain, got {na_count}"
            assert na_stats["chainCount"] == 1, na_stats

            browser.close()
    finally:
        server.shutdown()
        server.server_close()

    if errors:
        raise SystemExit("browser errors:\n" + "\n".join(errors))
    print("browser fixture: OK")


if __name__ == "__main__":
    main()

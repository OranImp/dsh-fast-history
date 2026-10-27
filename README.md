# dsh-fast-history

[English](#english) · [中文](#中文)

> **Experimental branch `experiment/mobile-seamless` (0.3.0-exp.1).** See [EXPERIMENT.md](./EXPERIMENT.md); this is not the stable 0.2.5 build.

DSH Web 历史会话渐进加载插件（面向手机/小屏）：**首屏最近消息 → 后台预读少量历史 → 接近已加载头部提前补页**；支持触摸屏/移动端。只影响显示，Host 为模型组装的上下文不变。

Repository: <https://github.com/OranImp/dsh-fast-history> · npm: `dsh-fast-history` (not published yet) · MIT

## English

A mobile-first client-side plugin for **DSH Web** that progressively loads conversation history. The newest messages render first (the official tail-first behavior is preserved); older history is prefetched in the background and then loaded automatically as you approach the currently loaded head — tuned for phones and small screens. It only changes what is displayed; the model context assembled by the host is untouched.

Repository: <https://github.com/OranImp/dsh-fast-history> · npm package: `dsh-fast-history` (not published yet) · MIT

### What official DSH does

- Opens a session with the tail page (at least 50 messages / 2 Turn starts, at most 500 messages).
- Shows a manual **Load earlier** button at the top; each click prepends one page.
- Has no scroll-triggered auto-loading, no background prefetch, and never evicts the loaded window.
- Page size and the initial window are hard-coded in the client, with no config.

This plugin fills those gaps without changing the host or the model context.

### Features

1. **Tail-first first paint** — unchanged from official behavior; no extra initial page request.
2. **Background prefetch** — after the first paint is stable and the session is idle, load one older page directly through `SessionFace.loadOlder()` (0/1/2 configurable).
3. **Early auto-load** — when you are within **1.5 screens** (configurable: 1/1.5/2) of the loaded head, load before the “Load earlier” control becomes the only way to continue. Early loads call `loadOlder()` directly because the official button is offscreen and `beginPaging()` would anchor to the oldest row.
4. **Chain fill** — if one page is shorter than the lead, continue up to 4 pages per approach (including the first); stop when the head leaves the lead, history ends, a load fails, or the session switches.
5. **Touch / mobile** — touch input is supported; single-finger only; pinch and nested scrollers (e.g. code blocks) are ignored. Loads are deferred until the finger lifts and the scroll is quiet for ~140 ms: no load and **no `scrollTop` writes** while a finger is down or momentum is running. Phone/coarse-pointer contexts use the longer 160 ms chain gap.
6. **Top anchor** — at the true top (≤4 px) with the finger lifted, a phone uses a direct load and the plugin keeps the old top row fixed; the official pager is not clicked (its `beginPaging()` seat can land on the next pager). Desktop keeps the official pager path. A top pull loads exactly one page and never chains.
7. **Memory discipline** — scalar state, official object references, and DOM references only; no history entries copied; prefetch and chain are bounded; no full-history preload.

### Install

From a checkout:

```bash
git clone https://github.com/OranImp/dsh-fast-history.git
dsh plugin --profile web add /absolute/path/to/dsh-fast-history
```

From a DSH agent session, the equivalent tool call is
`plugin_manager action=install_bundle target="/absolute/path/to/dsh-fast-history"`.

After the npm release, you can use the package name instead:

```bash
dsh plugin --profile web add dsh-fast-history
```

Refresh the Web GUI after installation (the client bundle is not HMR’d when `pnpm run dev:web` is not running).

Manual install: add
`"dsh-fast-history": "link:/absolute/path/to/dsh-fast-history"` to the profile dependencies, append `"dsh-fast-history"` to `dsh.profile.bundles`, run `pnpm install`, and refresh.

### Settings

**Settings → General → History loading**

- Enable/disable automatic loading and prefetch. When off, the official manual button still works.
- Lead: 1 / 1.5 / 2 screens (default **1.5**). Larger means more invisible headroom but more content read.
- Prefetch pages: 0 / 1 / 2 (default **1**).

Settings live in browser `localStorage` (`dsh-fast-history.settings.v1`), per browser, not host config.

Debug:

```js
localStorage.setItem('dsh-fast-history.debug', '1'); // refresh
window.__DSH_FAST_HISTORY__.stats();
window.__DSH_FAST_HISTORY__.diagnostics();
window.__DSH_FAST_HISTORY__.setSettings({ prefetchPages: 0, preloadScreens: 2 });
```

### Behavior and limits

- **Display-only**: no prompts, no session events appended, no host tools or config added; the model context is unchanged.
- **Fast scrolling**: page insertion and `scrollTop` correction are deferred until the gesture/inertia settles; a fast fling to the top may briefly show “Load earlier” before the load starts. This is intentional to avoid jank.
- **Anchor**: phone/coarse-pointer contexts never write `scrollTop`; desktop corrects a settled drift >2 px using the top visible row.
- **Hard eviction is not implemented**: the public `SessionFace` has no trim API; the plugin does not mutate private fields or `eventSource.replace`. Growth is bounded by user browsing + at most 2 prefetched pages (default 1) + up to 4 chain pages.
- **One-turn / huge sessions**: official pagination can load the whole log on the first page; the plugin does not change official paging and skips prefetch when the initial window is heavy.
- **Localization of the pager**: matches `加载更早 / 加载更多 / Load earlier / Load more`; otherwise uses the structural fallback, then a direct `loadOlder()`.
- **Mobile coexistence**: in the dsh-mobile dedicated layout (`.dshm-main` / `[data-dsh-mobile-frame]`) the plugin binds the mobile conversation. On phones the early path is a direct `loadOlder()` with an old-top-row correction, and pager clicks are routed through the same anchored direct path — both dsh-mobile’s synthetic `button.click()` and a real tap. Desktop keeps the official pager behavior.
- **Other profiles**: if your phone app connects to a different DSH profile, install the bundle there too.

### Tests

From a checkout (tests are not included in the npm tarball):

```bash
node --test test/*.test.mjs
# optional Chromium fixture; requires Playwright + a Chromium build
python3 test/browser_test.py
# if the browser is not in Playwright's default location:
# CHROMIUM_PATH=/path/to/chrome python3 test/browser_test.py
```

### Uninstall

Disable or remove the bundle in the profile, or from a shell run
`dsh plugin --profile web remove dsh-fast-history`, then refresh. In a DSH agent
session the tool call is `plugin_manager action=remove_bundle target="dsh-fast-history"`.

## 中文

面向手机/小屏的 DSH Web 历史会话渐进加载插件：**首屏最近消息 → 后台预读少量历史 → 上滑自动加载更早**。

只影响显示。插件不会发送 prompt、不会追加会话事件、不会改变 Host 为模型组装的上下文。

### 它解决什么

当前安装并已核对的 DSH 0.2.1-rc.2 / rc.3 官方行为（更新版本请重新验证）：

- 打开会话只加载**尾部一页**（至少 50 条消息 / 2 个 Turn，最多 500 条或历史耗尽）。
- 顶部有「加载更早 / Load earlier」按钮，每次手动追加一页。
- 没有滚动自动加载，没有后台预取，已加载窗口也不会被回收。

本插件在官方分页接口之上补齐：

1. **首屏**：不改变官方尾部优先策略，不增加首屏请求。
2. **预取**：首屏稳定且会话空闲时，后台直接调用 `SessionFace.loadOlder()` 预读 1 页（可配置 0/1/2），让第一次上滑通常无需等待。
3. **提前自动加载**：用 wheel / touch / 键盘输入方向门控；在距离已加载头部还有 **1.5 屏**（可设 1/1.5/2 屏）时就开始加载，而不是等只能靠点「加载更早」继续。提前加载使用 `loadOlder()` 直接请求；手机/粗指针上，加载后由插件把加载前的顶部可见消息行按原位置钉住（不在手指/惯性期间写 `scrollTop`）。真正到顶（≤4px）时：桌面点官方 pager，手机走直接加载 + 锚定校正，避免官方 `beginPaging()` 把视口落到下一个 pager。
4. **连续补页**：如果一页内容不足以填满提前量，插件会在页与页之间自动续加载，一次接近最多 4 页（含第一次），直到头部离开提前区或历史耗尽，让上滑过程尽量不出现按钮/加载态。
5. **内存**：只保留标量状态、官方对象引用和 DOM 引用；不复制历史事件，不预读整条历史，预取和续加载都有页数/条数预算。

### 安装

```bash
git clone https://github.com/OranImp/dsh-fast-history.git
dsh plugin --profile web add /absolute/path/to/dsh-fast-history
```

如果是在 DSH Agent 会话里，等价的工具调用是：
`plugin_manager action=install_bundle target="/absolute/path/to/dsh-fast-history"`。

npm 发布后，也可以直接用包名：

```bash
dsh plugin --profile web add dsh-fast-history
```

安装后刷新 Web GUI（当前没有 `pnpm run dev:web` watcher，Client 变更不会 HMR）。

手动安装（如果插件管理器不可用）：

1. 在 profile 的 `package.json` dependencies 中增加
   `"dsh-fast-history": "link:/absolute/path/to/dsh-fast-history"`。
2. 在 `dsh.profile.bundles` 末尾增加 `"dsh-fast-history"`。
3. 在 profile 目录执行 `pnpm install`，刷新页面。

### 设置

Settings → General → **历史消息加载**：

- 开关：启用/停用自动加载与预取；关闭后官方手动按钮仍可用。
- 提前量：1 / 1.5 / 2 屏，默认 **1.5 屏**；越大越无感，但会更早多读内容。
- 预读页数：0 / 1 / 2，默认 1。

设置保存在浏览器 localStorage（`dsh-fast-history.settings.v1`），按浏览器生效；不是 Host 配置。

调试：

```js
localStorage.setItem('dsh-fast-history.debug', '1'); // 刷新后生效
window.__DSH_FAST_HISTORY__.stats();        // 计数、页数、延迟、锚定漂移
window.__DSH_FAST_HISTORY__.diagnostics();  // 当前条件判定
window.__DSH_FAST_HISTORY__.setSettings({ prefetchPages: 0, preloadScreens: 2 });
```

### 行为细节

- **首屏**：沿用官方 `open()`；插件不会在首屏前预读。
- **预取**：`openState=open`、`hasMore`、非 running、在尾部、页面可见、当前窗口 entries ≤ 400 时，延迟约 1.2s 调一次 `loadOlder()`。每页新增 entries > 400 或累计 > 600 即停止。首屏过重的单 Turn 会话直接跳过预取。
- **提前量**：有效触发距离 = `max(96px, scroller.clientHeight × preloadScreens)`；默认 1.5 屏。接近已加载头部时即触发，不必看到 pager。
- **手势**：只响应 `wheel` / `touch` / `ArrowUp|PageUp|Home` 输入；wheel 进入提前区即触发；触摸手势只记下待加载意图，手指抬起且滚动停稳后再触发，不会在手指移动中插入内容。同页脚本也可以合成这些事件或直接点官方 pager，因此这不是安全边界，只是交互门控。
- **触摸屏/手机**：`touchstart` 后，手指向下滑（看更早内容）且进入提前区时，只记下待加载意图；手指抬起且滚动停稳（约 140ms）后才加载，避免和浏览器的滚动锚定/惯性抢位置。只处理单指，双指缩放和嵌套滚动区（代码块等）不触发。手机浏览器按窄视口/粗指针/触摸能力识别，不要求 dsh-mobile 专用布局；dsh-mobile 布局会优先绑定。
- **与 dsh-mobile 共存**：提前区/续加载用 `loadOlder()` 直连；真正到顶（≤4px）时桌面点官方 pager，手机用直接加载 + 自锚定。手机上的 pager 点击（包括 dsh-mobile 的 64px gate 合成 click 和真实手指点击）都改走同一条锚定直连；桌面仍保留官方 pager 行为。
- **快速滑动/惯性**：用 `scrollTop` 速度和单事件位移识别快速滑动；高速阶段不发起加载、不写 `scrollTop`，链式补页也暂停，等惯性停稳约 140ms 后再加载。快速滑到顶部时可能短暂看到“加载更早”，停稳后才补页，这是为了不打断滚动。
- **程序化滚动**：不会把 host 的 prepend 补偿当成用户手势自触发；新的独立手势之间有 400ms cooldown。
- **连续补页**：一页落下后，如果 `scrollTop` 仍在提前区内且 `hasMore`，桌面 80ms / 手机/粗指针 160ms 后自动再加载一页；一次接近最多 4 页（含第一次），头部离开提前区、历史耗尽、失败或切会话即停止。触摸进行中或高速滚动时链式补页暂停，停稳后继续。
- **锚定**：提前/手机顶部加载走直接 `loadOlder()`，加载前记录顶部可见行（`data-chat-anchor-key` + rect），加载后若行仍在则把它的位置钉回原处；手机也做这个校正，但只在手指/惯性停止后写 `scrollTop`，并加 120ms × 最多 6 次的延迟重试。真正在顶部（≤4px）且桌面时点击官方 pager，交给 Chat 自己的 `beginPaging`。顶部 direct 加载后如果仍在 0px（锚定失败），只加载一页、不链式补页，避免循环。
- **会话切换**：按 `[data-conversation-session]` 识别；切换/视图切换/滚动容器复用都会 teardown 旧监听与定时器；旧异步结果按 generation 丢弃。
- **清理**：插件停用/卸载时移除所有监听、Observer、定时器、订阅；调试全局变量删除。

### 已知限制

- **硬回收不存在**：公开的 `SessionFace` 没有裁剪已加载窗口的方法，插件也不会改私有字段或 `eventSource.replace`。内存增长仍由“用户浏览 + 最多 2 页预取（默认 1） + 一次接近最多 4 页提前加载”驱动；不预读整条历史。
- **单 Turn/超大会话**：官方分页要求至少 2 个 Turn 且 50 条消息，某些会话首屏就会整条加载；插件不修改官方分页，只避免额外预取。
- **多语言按钮**：pager 文本匹配 zh/en；其他语言走结构 fallback（`_older` 容器），再失败走 `loadOlder()`。
- **移动端**：手机浏览器和 dsh-mobile 专用布局都可用；手机/小屏按窄视口、粗指针或触摸能力识别，不要求 `.dshm-main`。提前区和真正到顶都用 `loadOlder()` 直连，并做旧顶部行校正；桌面顶部才点官方 pager。若你的手机 App 连接的是另一个 DSH profile，需要把本插件也安装到那个 profile。
- **上下文不变**：加载历史只影响客户端事件窗口；模型上下文由 Host 从持久日志组装。

### 测试

从源码 checkout 运行（npm tarball 不含 test/）：

```bash
node --test test/*.test.mjs
# 可选：真实 Chromium fixture（需要 Playwright + Chromium）
python3 test/browser_test.py
# 如果 Playwright 浏览器不在默认缓存目录，设置 CHROMIUM_PATH：
# CHROMIUM_PATH=/path/to/chrome python3 test/browser_test.py
```

浏览器 fixture 覆盖：预取 1 页、pager 仍在视口外时提前加载、提前区内自动续加载一页、官方 pager 手动仍可用、清理后不再自动加载、调试全局删除、dsh-mobile overlay 的手机上下文、无 overlay 的普通手机浏览器、快速滑动停稳前后不提前加载、body 焦点键盘 PageUp、resync 后重新预取、同会话 aria-hidden 重绑不重复预取、顶部无锚点时只点一次 pager 不续链、手机顶部无浏览器锚定时旧行仍保持、手机合成/真实 pager click 都改走锚定直连、无页面错误。

### 卸载

```bash
dsh plugin --profile web remove dsh-fast-history
```

或在 DSH Agent 会话里用
`plugin_manager action=remove_bundle target="dsh-fast-history"`。

刷新页面。浏览器中的设置键可手动清理：

```js
localStorage.removeItem('dsh-fast-history.settings.v1');
localStorage.removeItem('dsh-fast-history.debug');
```

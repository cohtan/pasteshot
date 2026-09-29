(() => {
  const STYLE_ID = "pasteshot-capture-style";
  const STYLE = `
    html { scroll-behavior: auto !important; }
    * { scrollbar-width: none !important; overflow-anchor: none !important; }
    *::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; }
    *, *::before, *::after {
      animation-play-state: paused !important;
      transition: none !important;
      caret-color: transparent !important;
    }
  `;

  function timeout(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function nextFrames() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
  }

  function queryAll(root) {
    const found = [];
    const visit = (node) => {
      if (!node?.querySelectorAll) return;
      for (const el of node.querySelectorAll("*")) {
        found.push(el);
        if (el.shadowRoot) visit(el.shadowRoot);
      }
    };
    visit(root);
    return found;
  }

  function pageBackground() {
    const colors = [
      document.body ? getComputedStyle(document.body).backgroundColor : "",
      getComputedStyle(document.documentElement).backgroundColor,
    ];
    return colors.find((color) => color && color !== "transparent" && color !== "rgba(0, 0, 0, 0)") || "#ffffff";
  }

  function measureWindow() {
    const root = document.scrollingElement || document.documentElement;
    const body = document.body;
    return {
      contentWidth: Math.max(root.scrollWidth, body?.scrollWidth || 0, window.innerWidth),
      contentHeight: Math.max(root.scrollHeight, body?.scrollHeight || 0, window.innerHeight),
    };
  }

  function roundBox(box) {
    const x = Math.round(box.x);
    const y = Math.round(box.y);
    const right = Math.round(box.x + box.width);
    const bottom = Math.round(box.y + box.height);
    return {
      x,
      y,
      width: Math.max(1, right - x),
      height: Math.max(1, bottom - y),
    };
  }

  function cropOf(el) {
    const rect = el.getBoundingClientRect();
    const x = Math.max(0, rect.left);
    const y = Math.max(0, rect.top);
    const width = Math.min(rect.width, window.innerWidth - x);
    const height = Math.min(rect.height, window.innerHeight - y);
    return roundBox({ x, y, width, height });
  }

  function readMetrics(state) {
    const viewportWidth = Math.round(window.innerWidth);
    const viewportHeight = Math.round(window.innerHeight);
    if (state.mode === "element" && state.el?.isConnected) {
      const crop = cropOf(state.el);
      return {
        viewportWidth,
        viewportHeight,
        contentWidth: Math.max(crop.width, Math.round(state.el.scrollWidth)),
        contentHeight: Math.max(crop.height, Math.round(state.el.scrollHeight)),
        crop,
      };
    }
    const size = measureWindow();
    return {
      viewportWidth,
      viewportHeight,
      contentWidth: Math.round(size.contentWidth),
      contentHeight: Math.round(size.contentHeight),
      crop: { x: 0, y: 0, width: viewportWidth, height: viewportHeight },
    };
  }

  function remember(undo, el) {
    undo.push({ el, style: el.getAttribute("style") });
  }

  function relaxSticky(undo, root) {
    for (const el of queryAll(root)) {
      if (getComputedStyle(el).position !== "sticky") continue;
      remember(undo, el);
      el.style.setProperty("position", "relative", "important");
      el.style.setProperty("top", "auto", "important");
      el.style.setProperty("bottom", "auto", "important");
    }
  }

  function createsContainingBlock(cs) {
    if (cs.transform && cs.transform !== "none") return true;
    if (cs.perspective && cs.perspective !== "none") return true;
    if (cs.filter && cs.filter !== "none") return true;
    if (cs.backdropFilter && cs.backdropFilter !== "none") return true;
    if (cs.willChange?.includes("transform")) return true;
    const contain = cs.contain || "";
    return contain === "strict" || contain.includes("paint") || contain.includes("content");
  }

  function isViewportFixed(el) {
    let node = el.parentElement;
    while (node && node !== document.documentElement) {
      if (createsContainingBlock(getComputedStyle(node))) return false;
      node = node.parentElement;
    }
    return true;
  }

  function placeFixed(el, docX, docY, width, height) {
    el.style.setProperty("position", "absolute", "important");
    el.style.setProperty("box-sizing", "border-box", "important");
    el.style.setProperty("margin", "0", "important");
    el.style.setProperty("transform", "none", "important");
    el.style.setProperty("right", "auto", "important");
    el.style.setProperty("bottom", "auto", "important");
    el.style.setProperty("width", `${Math.max(0, width)}px`, "important");
    el.style.setProperty("height", `${Math.max(0, height)}px`, "important");
    el.style.setProperty("left", "0px", "important");
    el.style.setProperty("top", "0px", "important");
    const next = el.getBoundingClientRect();
    const dx = docX - (next.left + window.scrollX);
    const dy = docY - (next.top + window.scrollY);
    el.style.setProperty("left", `${dx}px`, "important");
    el.style.setProperty("top", `${dy}px`, "important");
  }

  function freezeFixed(undo, pageHeight, viewportHeight) {
    const items = [];
    for (const el of queryAll(document.body || document.documentElement)) {
      const cs = getComputedStyle(el);
      if (cs.position !== "fixed" || !isViewportFixed(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      items.push({ el, rect });
    }
    for (const item of items) {
      remember(undo, item.el);
      const fromTop = item.rect.top;
      const fromBottom = viewportHeight - item.rect.bottom;
      // Computed top is a used pixel value even when the rule says `top: auto`,
      // so a footer has to be recognized by sitting on the bottom edge.
      const bottomAnchored =
        fromBottom < fromTop && fromBottom < viewportHeight * 0.25 && fromTop > viewportHeight * 0.5;
      const docY = bottomAnchored
        ? pageHeight - viewportHeight + item.rect.top
        : item.rect.top + window.scrollY;
      placeFixed(item.el, item.rect.left + window.scrollX, docY, item.rect.width, item.rect.height);
    }
  }

  function pickScroller() {
    let best = null;
    let bestScore = 0;
    for (const el of queryAll(document.body || document.documentElement)) {
      if (el === document.body || el === document.documentElement) continue;
      const delta = el.scrollHeight - el.clientHeight;
      if (delta < 80) continue;
      const overflowY = getComputedStyle(el).overflowY;
      if (overflowY !== "auto" && overflowY !== "scroll" && overflowY !== "overlay") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 160 || rect.height < 160) continue;
      const visibleW = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
      const visibleH = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
      if (visibleW < rect.width * 0.5 || visibleH < 120) continue;
      const score = delta * visibleW * visibleH;
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }
    return best;
  }

  function bumpWatchdog(state) {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      if (window.__pasteshot === state) restore();
    }, 120000);
  }

  function restore() {
    const state = window.__pasteshot;
    if (!state) {
      document.getElementById(STYLE_ID)?.remove();
      return;
    }
    clearTimeout(state.timer);
    for (let i = state.undo.length - 1; i >= 0; i -= 1) {
      const item = state.undo[i];
      if (!item.el.isConnected) continue;
      if (item.style == null) item.el.removeAttribute("style");
      else item.el.setAttribute("style", item.style);
    }
    state.style?.remove();
    try {
      history.scrollRestoration = state.history;
    } catch {
      /* The page may forbid changing this. */
    }
    window.scrollTo(state.scrollX, state.scrollY);
    if (state.el?.isConnected) state.el.scrollTo(state.elScrollX || 0, state.elScrollY || 0);
    delete window.__pasteshot;
  }

  async function prepare() {
    const existing = window.__pasteshot;
    const scrollX = existing ? existing.scrollX : window.scrollX;
    const scrollY = existing ? existing.scrollY : window.scrollY;
    restore();

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = STYLE;
    (document.head || document.documentElement).appendChild(style);

    const state = {
      undo: [],
      style,
      scrollX,
      scrollY,
      el: null,
      elScrollX: 0,
      elScrollY: 0,
      mode: "window",
      history: history.scrollRestoration,
    };
    window.__pasteshot = state;
    bumpWatchdog(state);
    try {
      history.scrollRestoration = "manual";
    } catch {
      /* Ignore when the history API is unavailable. */
    }

    window.scrollTo(0, 0);
    await nextFrames();

    const scrolling = document.scrollingElement || document.documentElement;
    const documentScrolls = scrolling.scrollHeight - window.innerHeight > 16;
    if (documentScrolls) {
      relaxSticky(state.undo, document.body || document.documentElement);
      await nextFrames();
      const size = measureWindow();
      freezeFixed(state.undo, size.contentHeight, window.innerHeight);
      await nextFrames();
    } else {
      const el = pickScroller();
      if (el) {
        state.mode = "element";
        state.el = el;
        state.elScrollX = el.scrollLeft;
        state.elScrollY = el.scrollTop;
        el.scrollTo(0, 0);
        await nextFrames();
        relaxSticky(state.undo, el);
        await nextFrames();
      }
    }

    if (document.fonts?.ready) {
      await Promise.race([document.fonts.ready, timeout(500)]);
    }
    await nextFrames();
    const metrics = readMetrics(state);
    return {
      mode: state.mode,
      title: document.title,
      url: location.href,
      background: pageBackground(),
      ...metrics,
    };
  }

  async function scrollTo(payload) {
    const state = window.__pasteshot;
    if (!state) return { x: window.scrollX, y: window.scrollY };
    bumpWatchdog(state);
    const x = payload?.x ?? 0;
    const y = payload?.y ?? 0;
    if (state.mode === "element" && state.el?.isConnected) state.el.scrollTo(x, y);
    else window.scrollTo(x, y);
    await nextFrames();

    const view =
      state.mode === "element" && state.el?.isConnected
        ? state.el.getBoundingClientRect()
        : { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight };
    const pending = [...document.images].filter((img) => {
      if (img.complete) return false;
      const rect = img.getBoundingClientRect();
      return rect.bottom > view.top && rect.top < view.bottom && rect.right > view.left && rect.left < view.right;
    });
    await Promise.race([
      Promise.all(pending.map((img) => img.decode().catch(() => {}))),
      timeout(220),
    ]);
    await timeout(40);

    if (state.mode === "element" && state.el?.isConnected) {
      return { x: state.el.scrollLeft, y: state.el.scrollTop };
    }
    return { x: window.scrollX, y: window.scrollY };
  }

  function measure() {
    const state = window.__pasteshot;
    if (!state) return null;
    return readMetrics(state);
  }

  function hideChrome() {
    const state = window.__pasteshot;
    if (!state || state.mode !== "element") return;
    for (const el of queryAll(document.body || document.documentElement)) {
      if (getComputedStyle(el).position !== "fixed") continue;
      remember(state.undo, el);
      el.style.setProperty("visibility", "hidden", "important");
    }
  }

  window.__pasteshotApi = { prepare, scrollTo, measure, hideChrome, restore };
})();

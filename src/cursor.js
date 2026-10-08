// Draws the mouse cursor and clicks into the page while a tab is recorded.
// Tab capture records only what the page paints, so without this the video
// would show no cursor at all. Injected into every frame; each frame draws
// the cursor while the pointer is over it.
(() => {
  if (window.__pasteshotCursor) return;

  const ARROW = `
    <svg width="22" height="30" viewBox="0 0 22 30" aria-hidden="true">
      <path d="M1.5 1.5 L1.5 23.5 L7.2 18.3 L11.2 27.6 L15.2 25.9 L11.3 16.8 L19 16.8 Z"
        fill="#ffffff" stroke="#111111" stroke-width="1.6" stroke-linejoin="round" />
    </svg>`;
  const CSS = `
    :host {
      all: initial !important;
      position: fixed !important;
      inset: 0 !important;
      width: 100vw !important;
      height: 100vh !important;
      margin: 0 !important;
      padding: 0 !important;
      border: 0 !important;
      background: transparent !important;
      overflow: hidden !important;
      pointer-events: none !important;
      z-index: 2147483647 !important;
      display: block !important;
    }
    .arrow {
      position: absolute;
      left: 0;
      top: 0;
      margin: -1.5px 0 0 -1.5px;
      filter: drop-shadow(0 1px 1.5px rgba(0, 0, 0, 0.35));
      will-change: transform;
    }
    .arrow[hidden] { display: none; }
    .ring {
      position: absolute;
      left: 0;
      top: 0;
      width: 36px;
      height: 36px;
      margin: -18px 0 0 -18px;
      border-radius: 50%;
      border: 3px solid #e5484d;
      background: rgba(229, 72, 77, 0.22);
      box-sizing: border-box;
    }
  `;

  const host = document.createElement("pasteshot-cursor");
  const root = host.attachShadow({ mode: "closed" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(CSS);
  root.adoptedStyleSheets = [sheet];
  const arrow = document.createElement("div");
  arrow.className = "arrow";
  arrow.hidden = true;
  arrow.innerHTML = ARROW;
  root.append(arrow);

  const usePopover = typeof host.showPopover === "function";
  if (usePopover) host.popover = "manual";

  // Popovers sit in the top layer, above modal dialogs and fullscreen
  // elements that were opened before. Showing it again puts it back on top.
  function raise() {
    if (!host.isConnected) document.documentElement.append(host);
    if (!usePopover) return;
    try {
      if (host.matches(":popover-open")) host.hidePopover();
      host.showPopover();
    } catch {
      /* Some pages remove or move the element; it is appended again next time. */
    }
  }

  function overlaysOpen() {
    return Boolean(document.fullscreenElement || document.querySelector(":modal"));
  }

  let x = 0;
  let y = 0;
  let frame = 0;
  let raisedForOverlay = false;

  function draw() {
    frame = 0;
    if (!host.isConnected) raise();
    arrow.style.transform = `translate(${x}px, ${y}px)`;
  }

  // Over a child frame, that frame draws its own cursor.
  function isFrame(el) {
    return el instanceof HTMLIFrameElement || el instanceof HTMLFrameElement || el instanceof HTMLEmbedElement || el instanceof HTMLObjectElement;
  }

  function onMove(event) {
    if (isFrame(event.target)) {
      arrow.hidden = true;
      return;
    }
    x = event.clientX;
    y = event.clientY;
    arrow.hidden = false;
    if (!frame) frame = requestAnimationFrame(draw);
  }

  function onDown(event) {
    onMove(event);
    const open = overlaysOpen();
    if (open || raisedForOverlay) raise();
    raisedForOverlay = open;
    const ring = document.createElement("div");
    ring.className = "ring";
    ring.style.transform = `translate(${event.clientX}px, ${event.clientY}px)`;
    root.insertBefore(ring, arrow);
    const animation = ring.animate(
      [
        { transform: `translate(${event.clientX}px, ${event.clientY}px) scale(0.4)`, opacity: 1 },
        { transform: `translate(${event.clientX}px, ${event.clientY}px) scale(1.3)`, opacity: 0 },
      ],
      { duration: 550, easing: "ease-out" },
    );
    animation.onfinish = () => ring.remove();
  }

  function onLeave(event) {
    if (!event.relatedTarget || isFrame(event.relatedTarget)) arrow.hidden = true;
  }

  function onOverlayChange() {
    if (overlaysOpen() || raisedForOverlay) raise();
    raisedForOverlay = overlaysOpen();
  }

  const options = { capture: true, passive: true };
  window.addEventListener("pointermove", onMove, options);
  window.addEventListener("pointerdown", onDown, options);
  document.addEventListener("pointerout", onLeave, options);
  document.addEventListener("fullscreenchange", onOverlayChange, options);
  // Dialogs opened with the keyboard never see a pointer event.
  const overlayTimer = window.setInterval(onOverlayChange, 1000);

  raise();

  window.__pasteshotCursor = {
    remove() {
      window.removeEventListener("pointermove", onMove, options);
      window.removeEventListener("pointerdown", onDown, options);
      document.removeEventListener("pointerout", onLeave, options);
      document.removeEventListener("fullscreenchange", onOverlayChange, options);
      window.clearInterval(overlayTimer);
      if (frame) cancelAnimationFrame(frame);
      host.remove();
      delete window.__pasteshotCursor;
    },
  };
})();

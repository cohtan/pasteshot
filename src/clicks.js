// Shows a ripple where the user clicks while a tab is recorded. Chrome
// draws the mouse cursor into a tab capture itself, but not the clicks.
// Injected into every frame; each frame shows the clicks made in it.
(() => {
  if (window.__pasteshotClicks) return;

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

  const host = document.createElement("pasteshot-clicks");
  const root = host.attachShadow({ mode: "closed" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(CSS);
  root.adoptedStyleSheets = [sheet];

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

  function onDown(event) {
    if (!host.isConnected || document.fullscreenElement || document.querySelector(":modal")) raise();
    const at = `translate(${event.clientX}px, ${event.clientY}px)`;
    const ring = document.createElement("div");
    ring.className = "ring";
    ring.style.transform = at;
    root.append(ring);
    const animation = ring.animate(
      [
        { transform: `${at} scale(0.4)`, opacity: 1 },
        { transform: `${at} scale(1.3)`, opacity: 0 },
      ],
      { duration: 550, easing: "ease-out" },
    );
    animation.onfinish = () => ring.remove();
  }

  const options = { capture: true, passive: true };
  window.addEventListener("pointerdown", onDown, options);

  raise();

  window.__pasteshotClicks = {
    remove() {
      window.removeEventListener("pointerdown", onDown, options);
      host.remove();
      delete window.__pasteshotClicks;
    },
  };
})();

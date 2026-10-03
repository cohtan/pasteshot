# PasteShot

English | [日本語](README.ja.md)

A Chrome extension that turns the whole page you are viewing, including the part you have to scroll to, into one image and copies it to the clipboard. Paste it straight into a chat or a document.

## Install

PasteShot is not on the Chrome Web Store. Load it like this:

1. Clone this repository, or use "Code → Download ZIP" and unzip it.
2. Open `chrome://extensions` in Chrome.
3. Turn on "Developer mode" in the top right.
4. Click "Load unpacked" and pick the unzipped folder (the one that contains `manifest.json`).
5. Pin PasteShot from the puzzle-piece icon in the toolbar so it is easy to reach.

Chrome 116 or later is required. Edge, Brave, and other Chromium browsers work the same way.

## Use

1. Open the page you want to capture.
2. Click the PasteShot icon in the toolbar.
3. A small progress window opens and the page scrolls by itself while it is captured. Don't resize the window or switch tabs until it finishes.
4. When it is done, the image is on the clipboard. Just paste it.

To stop a capture partway, press Cancel in the progress window, click the PasteShot icon again, or close the progress window. The page goes back the way it was.

If the image could not be copied automatically, a preview page opens where you can copy or save it by hand.

If the page is long enough to be split into several images, only the first one is copied. Copy the rest with the buttons in the progress window.

The screens follow the browser's language: Japanese for Japanese, English otherwise.

## Settings

Choose the resolution on the extension's options page.

| Setting | What it does |
|---|---|
| Standard (default) | Up to 1280px wide. A good size for pasting into chat. |
| As on screen | Keeps the width you see now. |
| High resolution | Keeps the display's pixels. About twice the size on Retina screens, so images are larger. |

## Limitations

- Only `http(s)://` and `file://` pages can be captured. The browser does not allow capturing `chrome://` pages, the Chrome Web Store, and similar pages.
- To capture `file://` pages, turn on "Allow access to file URLs" in the extension's details.
- A capture covers at most 24 screens. On longer pages the bottom is cut off.
- Content that overflows sideways is left out when it would need too many tiles.
- If the page stops scrolling partway, the image ends there.
- If the window is resized during capture, the capture stops.
- Chrome needs about 0.5 seconds between screenshots, so long pages take longer.
- Images taller than 7200px are split into several images.
- Videos, animations, and content that loads partway down the page appear as they looked at the moment of capture.

## Privacy

Everything is processed on your device. Nothing is sent to any server. Only the resolution setting is saved through Chrome sync so it follows you across browsers.

The last 4 captures (the images, page titles, and URLs) are kept inside the extension (IndexedDB) so the preview page can reopen them. Starting a 5th capture removes the oldest. Removing the extension deletes all of them.

Permissions used:

- `activeTab`, `scripting`: to capture the tab when you click the icon
- `clipboardWrite`: to copy the image to the clipboard
- `offscreen`: to stitch the screenshots together and copy the result
- `storage`: to save the resolution setting

## Development

There is no build step. The source loads as is.

```sh
pnpm test
```

`test/capture.mjs` checks a real capture in a real browser.

## Layout

| File | Role |
|---|---|
| `src/background.js` | Overall control (service worker) |
| `src/page-hook.js` | Preparing, scrolling, and restoring the page |
| `src/geometry.js` | Tile placement and splitting the output |
| `src/stitch.js`, `src/offscreen.*` | Stitching the image and copying it |
| `src/settings.js` | Reading and writing the resolution setting |
| `src/db.js` | Storing capture data (IndexedDB) |
| `src/progress.*`, `src/preview.*`, `src/options.*` | The screens |
| `src/i18n.js`, `_locales/` | Screen text (Japanese and English, picked by the browser language) |
| `tools/make-icons.py` | Generates the icons (`python3 tools/make-icons.py`, needs Pillow) |

## License

[MIT](LICENSE)

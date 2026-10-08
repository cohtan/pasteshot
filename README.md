# PasteShot

English | [日本語](README.ja.md)

A Chrome extension that turns the whole page you are viewing, including the part you have to scroll to, into one image and copies it to the clipboard. Paste it straight into a chat or a document.

It can also record what you do in a tab as a video, with the cursor shown. Handy for showing the steps in customer support.

## Install

PasteShot is not on the Chrome Web Store. Load it like this:

1. Clone this repository, or use "Code → Download ZIP" and unzip it.
2. Open `chrome://extensions` in Chrome.
3. Turn on "Developer mode" in the top right.
4. Click "Load unpacked" and pick the unzipped folder (the one that contains `manifest.json`).
5. Pin PasteShot from the puzzle-piece icon in the toolbar so it is easy to reach.

Chrome 116 or later is required. Edge, Brave, and other Chromium browsers work the same way.

## Use

Click the PasteShot icon in the toolbar to open its menu, then choose "Copy page as image" or "Record this tab".

### Copy page as image

1. Open the page you want to capture.
2. Click the PasteShot icon and choose "Copy page as image".
3. A small progress window opens and the page scrolls by itself while it is captured. Don't resize the window or switch tabs until it finishes.
4. When it is done, the image is on the clipboard. Just paste it.

To stop a capture partway, press Cancel in the progress window, click the PasteShot icon again, or close the progress window. The page goes back the way it was.

If the image could not be copied automatically, a preview page opens where you can copy or save it by hand.

If the page is long enough to be split into several images, only the first one is copied. Copy the rest with the buttons in the progress window.

### Record this tab

1. Open the page you want to record.
2. Click the PasteShot icon and choose "Record this tab".
3. While the progress window shows the elapsed time, what you do in the tab is recorded. The cursor and where you click are drawn into the video.
4. When you are done, press Stop in the progress window or click the PasteShot icon again. Closing the progress window or the recorded tab also stops it.
5. The video is saved to your Downloads folder. "Show in folder" opens it.

Videos are saved as MP4, or WebM if the browser cannot write MP4.

Recording continues when you move to another page. To keep the cursor on the pages you move to, allow access to all sites. Until you do, the progress window shows an Allow button. You only need to allow it once.

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

Recording limitations:

- Only the content of the tab you started recording is recorded. The browser's address bar, other tabs, and other apps are not.
- The cursor in the video is drawn by the extension and is always an arrow. It does not change over text fields or links.
- No sound is recorded.
- A recording lasts at most 30 minutes. At 30 minutes it stops by itself and saves what it has.
- The video keeps the display's pixels, up to 1920px on the long edge.

## Privacy

Everything, images and videos alike, is processed on your device. Nothing is sent to any server. Only the resolution setting is saved through Chrome sync so it follows you across browsers.

The last 4 captures and recordings (the images or videos, page titles, and URLs) are kept inside the extension (IndexedDB) so the preview page can reopen them. Starting a 5th capture removes the oldest. Removing the extension deletes all of them.

Permissions used:

- `activeTab`, `scripting`: to capture the tab when you click the icon
- `clipboardWrite`: to copy the image to the clipboard
- `offscreen`: to stitch the screenshots together and copy the result
- `storage`: to save the resolution setting
- `tabCapture`: to record the tab
- `downloads`: to save recordings to the Downloads folder
- Access to all sites (optional): to keep the cursor on pages you move to while recording. Asked for only when you press Allow in the progress window

## Development

There is no build step. The source loads as is.

```sh
pnpm test
```

`test/capture.mjs` checks a real capture and recording in a real browser.

## Layout

| File | Role |
|---|---|
| `src/background.js` | Overall control (service worker) |
| `src/page-hook.js` | Preparing, scrolling, and restoring the page |
| `src/geometry.js` | Tile placement and splitting the output |
| `src/stitch.js`, `src/offscreen.*` | Stitching the image and copying it, and recording the tab |
| `src/cursor.js` | Drawing the cursor and clicks into the page while recording |
| `src/video.js` | Recording format, size, and file name |
| `src/settings.js` | Reading and writing the resolution setting |
| `src/db.js` | Storing capture data (IndexedDB) |
| `src/popup.*`, `src/progress.*`, `src/preview.*`, `src/options.*` | The screens |
| `src/i18n.js`, `_locales/` | Screen text (Japanese and English, picked by the browser language) |
| `tools/make-icons.py` | Generates the icons (`python3 tools/make-icons.py`, needs Pillow) |

## License

[MIT](LICENSE)

import assert from "node:assert/strict";
import test from "node:test";

globalThis.chrome = {
  runtime: {
    id: "abc",
    getURL: (path) => `chrome-extension://abc/${path}`,
  },
};

const { fromExtension } = await import("../src/messages.js");

test("messages from the extension's own pages are accepted", () => {
  assert.equal(fromExtension({ id: "abc", url: "chrome-extension://abc/src/popup.html" }), true);
  assert.equal(fromExtension({ id: "abc", url: "chrome-extension://abc/src/background.js" }), true);
});

test("messages from scripts in web pages are refused", () => {
  assert.equal(fromExtension({ id: "abc", url: "https://example.com/", tab: { id: 1 } }), false);
});

test("messages from other extensions are refused", () => {
  assert.equal(fromExtension({ id: "xyz", url: "chrome-extension://xyz/page.html" }), false);
  assert.equal(fromExtension(undefined), false);
});

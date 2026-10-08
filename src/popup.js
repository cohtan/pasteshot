import { localize, t } from "./i18n.js";

localize();

const captureButton = document.querySelector("#capture");
const recordButton = document.querySelector("#record");
const noteEl = document.querySelector("#note");

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

if (!tab || !/^(https?|file):/i.test(tab.url || "")) {
  captureButton.disabled = true;
  recordButton.disabled = true;
  noteEl.hidden = false;
  noteEl.textContent = t("errRestricted");
}

async function start(mode) {
  captureButton.disabled = true;
  recordButton.disabled = true;
  await chrome.runtime.sendMessage({ target: "background", type: "start", mode, tabId: tab.id }).catch(() => {});
  window.close();
}

captureButton.addEventListener("click", () => void start("capture"));

recordButton.addEventListener("click", () => void start("record"));

document.querySelector("#settings").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

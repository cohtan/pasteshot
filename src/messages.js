// Messages come only from this extension's own pages and worker. The scripts
// put into web pages never send any, so a message from a page is refused.
export function fromExtension(sender) {
  return sender?.id === chrome.runtime.id && Boolean(sender.url?.startsWith(chrome.runtime.getURL("")));
}

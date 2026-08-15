/* Jarvis service worker: the only piece that may speak native messaging.
 *
 * Holds one long-lived port to the native host proxy (which relays to the running
 * Jarvis overlay). An open native port keeps the MV3 service worker alive
 * (Chrome 105+), so the link stays up without keepalive hacks; if the port drops
 * we reconnect with backoff.
 *
 * The overlay addresses ONE tab: the "armed" tab. Arming is a deliberate user
 * action in the browser (toolbar click or Ctrl+Shift+J) — the overlay can never
 * point itself at a tab you didn't hand it.
 */

const HOST = "com.jarvis.host";
let port = null;
let backoff = 1000;

async function armedTabId() {
  const { armedTabId } = await chrome.storage.session.get("armedTabId");
  return armedTabId || null;
}

async function setArmed(tabId, note) {
  await chrome.storage.session.set({ armedTabId: tabId });
  try {
    await chrome.action.setBadgeText({ text: tabId ? "ON" : "" });
    await chrome.action.setBadgeBackgroundColor({ color: "#6c5ce7" });
  } catch (e) { /* badge is cosmetic */ }
  send({ type: "event", event: "tab_armed", tabId, note: note || "" });
}

function connect() {
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch (e) {
    schedule();
    return;
  }
  backoff = 1000;
  port.onMessage.addListener(handle);
  port.onDisconnect.addListener(() => {
    port = null;
    schedule();
  });
}

function schedule() {
  setTimeout(connect, backoff);
  backoff = Math.min(backoff * 2, 30000);
}

function send(obj) {
  try { if (port) port.postMessage(obj); } catch (e) { /* dropped; reconnect will follow */ }
}

async function handle(msg) {
  const id = msg.id;
  const reply = (payload) => send(Object.assign({ id }, payload));
  try {
    if (msg.action === "ping") { reply({ ok: true, pong: true }); return; }

    let tabId = await armedTabId();
    if (!tabId) {
      // Fall back to the active tab of the last focused window, but only report it
      // as a hint — the user still has to arm a tab for actions to run.
      reply({ ok: false, error: "No tab is armed. In Chrome, open the page and press "
                              + "Ctrl+Shift+J (or click the Jarvis toolbar icon) to give "
                              + "Jarvis access to that tab." });
      return;
    }
    let tab;
    try { tab = await chrome.tabs.get(tabId); }
    catch (e) {
      await setArmed(null);
      reply({ ok: false, error: "The armed tab was closed. Arm another one with Ctrl+Shift+J." });
      return;
    }
    if (msg.action === "read_page" || msg.action === "list_fields" || msg.action === "fill_fields") {
      // Ask every frame; ATS forms are often inside an iframe (Greenhouse embeds).
      const frames = await chrome.webNavigation?.getAllFrames?.({ tabId }).catch(() => null);
      const target = { tabId };
      const res = await chrome.tabs.sendMessage(tabId, msg).catch(async (e) => {
        // content script not present (page loaded before install) → inject and retry
        await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content.js"] });
        return chrome.tabs.sendMessage(tabId, msg);
      });
      reply(Object.assign({ ok: true, tabUrl: tab.url, tabTitle: tab.title }, res || {}));
      return;
    }
    reply({ ok: false, error: "unknown action: " + msg.action });
  } catch (e) {
    reply({ ok: false, error: String((e && e.message) || e) });
  }
}

chrome.action.onClicked.addListener((tab) => setArmed(tab.id, tab.url));
chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== "arm-tab") return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab) setArmed(tab.id, tab.url);
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if ((await armedTabId()) === tabId) setArmed(null);
});

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();

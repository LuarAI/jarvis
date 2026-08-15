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

/* Ask EVERY frame of the tab, not just the top one.
 *
 * ATS forms are routinely inside an iframe (Greenhouse embeds its board that way),
 * and a plain tabs.sendMessage only reaches the top frame — which on those pages
 * answers nothing and rejects, the "browser tool errored out" the user saw. So:
 * enumerate frames, ask each, and merge. Fields from all frames are combined and
 * their refs namespaced per frame so a later fill goes back to the right one.
 */
async function askFrames(tabId, msg) {
  let frameIds = [0];
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    if (frames && frames.length) frameIds = frames.map((f) => f.frameId);
  } catch (e) { /* no webNavigation permission / restricted page → top frame only */ }

  // Make sure the content script is present everywhere (a page loaded before the
  // extension was installed has none).
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content.js"] });
  } catch (e) { /* injection blocked on some frames; the declared script may still be there */ }

  const per = await Promise.all(frameIds.map(async (frameId) => {
    try {
      const r = await chrome.tabs.sendMessage(tabId, msg, { frameId });
      return r && r.ok ? { frameId, r } : null;
    } catch (e) {
      return null;   // frame has no content script (about:blank, cross-origin ad) — skip
    }
  }));
  const live = per.filter(Boolean);
  if (!live.length) {
    return { error: "Couldn't reach the page. Reload the tab, then press Ctrl+Shift+J "
                  + "again (Chrome can't inject into chrome:// pages, the Web Store, or "
                  + "PDF viewers)." };
  }

  if (msg.action === "fill_fields") {
    // Route each fill back to the frame that owns its ref.
    const results = [];
    for (const { frameId, r } of live) results.push(...(r.results || []));
    return { results };
  }

  // read_page / list_fields: merge, preferring the top frame's page text but taking
  // fields from every frame (namespaced refs: "2:f7" = frame 2, field f7).
  const fields = [];
  let page_text = "", url = "", title = "", ats = "generic";
  const excluded = { credentials: 0, hidden_or_honeypot: 0 };
  for (const { frameId, r } of live) {
    for (const f of r.fields || []) {
      fields.push(Object.assign({}, f, { ref: frameId + ":" + f.ref }));
    }
    const ec = r.excluded_counts || {};
    excluded.credentials += ec.credentials || 0;
    excluded.hidden_or_honeypot += ec.hidden_or_honeypot || 0;
    // the frame with the most text wins the description (embeds put it in the iframe)
    if ((r.page_text || "").length > page_text.length) {
      page_text = r.page_text || "";
      url = r.url || url; title = r.title || title;
    }
    if (r.ats && r.ats !== "generic") ats = r.ats;
  }
  return { fields, page_text, url, title, ats, excluded_counts: excluded };
}

async function handle(msg) {
  const id = msg.id;
  const reply = (payload) => send(Object.assign({ id }, payload));
  try {
    if (msg.action === "ping") { reply({ ok: true, pong: true }); return; }
    if (msg.action === "armed_status") {
      const tid = await armedTabId();
      if (!tid) { reply({ ok: true, armed: false }); return; }
      try {
        const t = await chrome.tabs.get(tid);
        reply({ ok: true, armed: true, url: t.url, title: t.title });
      } catch (e) {
        await setArmed(null);
        reply({ ok: true, armed: false });
      }
      return;
    }

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
      const res = await askFrames(tabId, msg);
      if (res.error) { reply({ ok: false, error: res.error }); return; }
      reply(Object.assign({ ok: true, tabUrl: tab.url, tabTitle: tab.title }, res));
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

/* Jarvis service worker: the only piece that may speak native messaging.
 *
 * Holds one long-lived port to the native host proxy (which relays to the running
 * Jarvis overlay). An open native port keeps the MV3 service worker alive
 * (Chrome 105+), so the link stays up without keepalive hacks; if the port drops
 * we reconnect with backoff.
 *
 * Jarvis reads the tab the user is looking at; the toolbar button / Alt+Shift+J
 * PINS a specific tab so it keeps reading that one while they browse elsewhere.
 * Acting (filling) always goes through the overlay's approval card regardless.
 */

const HOST = "com.jarvis.host";
let port = null;
let backoff = 1000;

/* The badge reflects ONE thing: is the extension talking to the Jarvis overlay.
 *
 * It used to mean "this tab is pinned for Jarvis". That pin existed when Jarvis
 * could only touch a tab you had explicitly handed it — but it now reads whatever
 * tab you're on, and the 📄 collector captures what you browse, so pinning had no
 * job left. A badge implying a mode that no longer exists is worse than no badge. */
async function setConnectedBadge(on) {
  try {
    await chrome.action.setBadgeText({ text: on ? "ON" : "" });
    await chrome.action.setBadgeBackgroundColor({ color: "#6c5ce7" });
  } catch (e) { /* badge is cosmetic */ }
}

/* The hard switch. While disabled we do not hold a native port at all, so no page
 * content can reach the overlay however it asks — this is a disconnect, not a
 * politeness. Persisted, so it survives browser restarts. */
let enabled = true;

async function loadEnabled() {
  const { enabled: e } = await chrome.storage.local.get("enabled");
  enabled = (e !== false);            // default ON for a freshly installed extension
  return enabled;
}

async function setEnabled(value) {
  enabled = !!value;
  await chrome.storage.local.set({ enabled });
  if (enabled) {
    connect();
  } else {
    try { if (port) port.disconnect(); } catch (e) { /* already gone */ }
    port = null;
    setConnectedBadge(false);
  }
  return enabled;
}

function connect() {
  if (!enabled || port) return;
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch (e) {
    schedule();
    return;
  }
  backoff = 1000;
  setConnectedBadge(true);
  port.onMessage.addListener(handle);
  port.onDisconnect.addListener(() => {
    port = null;
    setConnectedBadge(false);
    schedule();
  });
}

function schedule() {
  if (!enabled) return;               // off means off: no reconnect loop
  setTimeout(connect, backoff);
  backoff = Math.min(backoff * 2, 30000);
}

/* The popup talks to us over runtime messaging (it cannot hold the native port).
 * Returning `true` ONLY for popup messages matters: this listener also sees the
 * content script's messages, and claiming the channel for those would leave them
 * waiting on a reply we never send. */
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (!msg || !msg.popup) return false;
  (async () => {
    if (msg.popup === "setEnabled") {
      await setEnabled(msg.value);
    } else {
      // Status query: read the persisted value, since the service worker may have
      // restarted since the toggle was set and the in-memory flag would be default.
      await loadEnabled();
    }
    let tab = "";
    try {
      const t = await targetTab();
      tab = t ? (t.title || t.url || "") : "";
    } catch (e) { /* no usable tab */ }
    respond({ enabled, connected: !!port, tab: String(tab).slice(0, 80) });
  })();
  return true;                        // async respond (popup messages only)
});

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
  const frameUrl = {};
  const diag = [];                        // why each frame failed — surfaced on error
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    if (frames && frames.length) {
      /* Ask the TOP frame plus same-site frames only. A LinkedIn page carries ~15
       * ad/tracking iframes (doubleclick, demdex, protechts, recaptcha); asking them
       * produced pages of noise in the error output and let an empty ad frame be
       * mistaken for "the job page has no cards". Content frames of the site being
       * read are the only ones that can hold its content. */
      const top = frames.find((f) => f.frameId === 0);
      let host = "";
      try { host = new URL(top ? top.url : "").hostname.split(".").slice(-2).join("."); }
      catch (e) { host = ""; }
      const keep = frames.filter((f) => {
        if (f.frameId === 0) return true;
        try { return host && new URL(f.url).hostname.endsWith(host); }
        catch (e) { return false; }
      });
      frameIds = keep.map((f) => f.frameId);
      for (const f of keep) frameUrl[f.frameId] = f.url;
    }
  } catch (e) { /* no webNavigation permission / restricted page → top frame only */ }

  /* Ask a frame, injecting the content script first if it isn't there.
   *
   * Injection is PER FRAME: an allFrames:true executeScript rejects the whole call
   * as soon as one frame is restricted (LinkedIn is full of cross-origin ad iframes),
   * which meant the retry never ran and a page whose declared script hadn't loaded
   * looked permanently unreachable ("the connection to that tab is stale"). */
  async function askFrame(frameId) {
    const short = (u) => String(u || "").slice(0, 60);
    let stale = false;
    try {
      const r = await chrome.tabs.sendMessage(tabId, msg, { frameId });
      if (r && r.ok) return { frameId, r };
      // "unknown action" means an OLD content script is still resident (the page was
      // loaded before the extension was updated). Re-inject to replace it, instead of
      // accepting the refusal — otherwise the stale script persists until a reload.
      stale = !!(r && /unknown action/i.test(String(r.error || "")));
      if (r && !stale) {
        diag.push({ frameId, url: short(frameUrl[frameId]),
                    error: "replied not-ok: " + (r.error || "?") });
        return null;
      }
    } catch (e) { /* no content script here yet — inject and retry below */ }
    try {
      await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] },
                                             files: ["content.js"] });
      const r = await chrome.tabs.sendMessage(tabId, msg, { frameId });
      if (r && r.ok) return { frameId, r };
      diag.push({ frameId, url: short(frameUrl[frameId]),
                  error: r ? ("replied not-ok: " + (r.error || "?")) : "no reply after inject" });
    } catch (e) {
      diag.push({ frameId, url: short(frameUrl[frameId]),
                  error: String((e && e.message) || e).slice(0, 120) });
    }
    return null;
  }

  const per = await Promise.all(frameIds.map(askFrame));
  let live = per.filter(Boolean);
  if (!live.length && !frameIds.includes(0)) {
    const top = await askFrame(0);            // last resort: the top frame explicitly
    if (top) live = [top];
  }
  if (!live.length) {
    // Report WHY, per frame — a bare "couldn't reach the page" told nobody anything
    // and cost several rounds of guesswork.
    const why = diag.map((d) => `frame ${d.frameId} (${d.url || "?"}): ${d.error}`).join(" | ");
    return { error: "Couldn't reach the page. " + (why || "no frames responded.")
                  + " (Chrome cannot read chrome:// pages, the Web Store, or PDFs.)" };
  }

  if (msg.action === "fill_fields") {
    // Route each fill back to the frame that owns its ref.
    const results = [];
    for (const { frameId, r } of live) results.push(...(r.results || []));
    return { results };
  }

  if (msg.action === "show_me" || msg.action === "clear_show_me") {
    // Every frame is asked; each marks the items it owns. Merge what was shown.
    const shown = [];
    for (const { r } of live) shown.push(...(r.shown || []));
    return { shown };
  }

  if (msg.action === "collect_snapshot") {
    // whichever frame has the most text is the content (not an ad iframe)
    let best = null;
    for (const { r } of live) {
      if (!best || (r.text || "").length > (best.text || "").length) best = r;
    }
    return best || { text: "" };
  }

  if (msg.action === "probe_layout") {
    // Report EVERY frame that answered, with its URL — reporting one arbitrary frame
    // made an ad iframe's empty result look like the job page having no cards.
    const best = live.find(({ r }) => r.cardCount) || live[0];
    return Object.assign({}, best ? best.r : { selectors: [], cardCount: 0 }, {
      frames: live.map(({ frameId, r }) => ({
        frameId, url: (frameUrl[frameId] || r.url || "?").slice(0, 80),
        cards: r.cardCount || 0, chars: (r.selectors || [])
          .reduce((m, s) => Math.max(m, s.chars || 0), 0),
      })),
    });
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

/* Which tab does Jarvis act on?
 *
 * The pinned (armed) tab if there is a live one — that's the user saying "this
 * specific page, even while I browse elsewhere". Otherwise the tab they're
 * actually looking at. Requiring an explicit arm for every read turned out to be
 * the wrong contract: users read "Jarvis Bridge ON" as "it can see my browser",
 * and being told to arm a tab they had already armed is just wrong. Filling still
 * cannot happen without the approval card, so this widens READ convenience, not
 * the ability to act. chrome:// and Web Store pages are unscriptable — skip them
 * so we fail with a useful message rather than a permissions error. */
const UNSCRIPTABLE = /^(chrome|edge|about|devtools|view-source):|^https:\/\/chromewebstore\.google\.com|^https:\/\/chrome\.google\.com\/webstore/;

async function targetTab() {
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active && !UNSCRIPTABLE.test(active.url || "")) return active;
  return null;
}

async function handle(msg) {
  const id = msg.id;
  const reply = (payload) => send(Object.assign({ id }, payload));
  try {
    if (msg.action === "ping") { reply({ ok: true, pong: true }); return; }
    if (msg.action === "armed_status") {
      const t = await targetTab();
      if (!t) { reply({ ok: true, armed: false }); return; }
      reply({ ok: true, armed: true, url: t.url, title: t.title });
      return;
    }

    const target = await targetTab();
    if (!target) {
      reply({ ok: false, error: "No usable tab. Open the page in Chrome (Jarvis can't "
                              + "read chrome:// pages, the Web Store, or PDF viewers), "
                              + "then try again." });
      return;
    }
    const tabId = target.id;
    const tab = target;
    if (msg.action === "collect_snapshot") {
      // Snapshot whatever tab the user is looking at — deliberately NOT the pinned
      // one: the collector follows the user's browsing.
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!active || UNSCRIPTABLE.test(active.url || "")) {
        reply({ ok: true, skip: true }); return;
      }
      const r = await askFrames(active.id, msg);
      reply(r.error ? { ok: false, error: r.error }
                    : Object.assign({ ok: true }, r));
      return;
    }
    if (msg.action === "read_page" || msg.action === "list_fields"
        || msg.action === "fill_fields" || msg.action === "probe_layout"
        || msg.action === "show_me" || msg.action === "clear_show_me"
        || msg.action === "probe_options") {
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

// The toolbar icon opens the popup (declared in the manifest), which owns the
// on/off switch — no click handler here.
chrome.runtime.onStartup.addListener(() => loadEnabled().then(connect));
chrome.runtime.onInstalled.addListener(() => loadEnabled().then(connect));
loadEnabled().then(connect);

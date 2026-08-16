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

/* Armed-tab state lives in chrome.storage.LOCAL, not .session: session storage is
 * wiped when the extension reloads or the browser restarts, while the toolbar badge
 * is not — so the badge said ON while the stored id was already gone, and Jarvis
 * reported "no tab armed" on a tab the user had clearly armed. Local storage keeps
 * the two in agreement; a stale id is validated (and cleared) on use. */
async function armedTabId() {
  const { armedTabId } = await chrome.storage.local.get("armedTabId");
  return armedTabId || null;
}

async function setArmed(tabId, note) {
  await chrome.storage.local.set({ armedTabId: tabId || null });
  try {
    await chrome.action.setBadgeText({ text: tabId ? "ON" : "" });
    await chrome.action.setBadgeBackgroundColor({ color: "#6c5ce7" });
  } catch (e) { /* badge is cosmetic */ }
  send({ type: "event", event: "tab_armed", tabId, note: note || "" });
}

/* Re-paint the badge for whatever tab the user is looking at: the badge is
 * per-extension (global), so without this a restored armed id shows ON on every
 * tab, and a lost one shows nothing on the right tab. */
async function repaintBadge(activeTabId) {
  const armed = await armedTabId();
  try {
    await chrome.action.setBadgeText({ text: (armed && armed === activeTabId) ? "ON" : "" });
  } catch (e) { /* cosmetic */ }
}
chrome.tabs.onActivated.addListener(({ tabId }) => repaintBadge(tabId));

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
  const pinnedId = await armedTabId();
  if (pinnedId) {
    try {
      const t = await chrome.tabs.get(pinnedId);
      if (t && !UNSCRIPTABLE.test(t.url || "")) { t._pinned = true; return t; }
    } catch (e) {
      await setArmed(null);        // it was closed — stop claiming it's armed
    }
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active && !UNSCRIPTABLE.test(active.url || "")) { active._pinned = false; return active; }
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
      reply({ ok: true, armed: true, url: t.url, title: t.title, pinned: t._pinned });
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
        || msg.action === "fill_fields" || msg.action === "probe_layout") {
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

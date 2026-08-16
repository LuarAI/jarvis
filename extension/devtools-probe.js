/* Jarvis — paste this into Chrome DevTools Console on the LinkedIn jobs page.
 *
 * It reports what the page ACTUALLY contains, so selectors can be written from
 * evidence instead of guesses. Read-only: it clicks nothing and changes nothing.
 *
 * How to use:
 *   1. On the jobs page, press F12 (or Ctrl+Shift+I) → "Console" tab
 *   2. Paste this whole file, press Enter
 *   3. Copy the output back to Jarvis
 */
(() => {
  const out = {};
  out.url = location.href.slice(0, 160);
  out.topFrame = window.top === window;
  out.bodyChars = (document.body && document.body.innerText || "").length;

  // 1. Which frame holds the jobs UI? (run this in EACH frame via the frame selector)
  out.frames = window.frames.length;

  // 2. Stable-looking attributes
  const attrs = {};
  for (const a of ["data-job-id", "data-occludable-job-id", "data-view-name",
                   "data-component-type", "data-entity-urn", "data-test-id",
                   "data-tracking-control-name"]) {
    const n = document.querySelectorAll(`[${a}]`).length;
    if (n) attrs[a] = n;
  }
  out.attributes = attrs;

  // 3. data-view-name values in use (the React layout keys off these)
  const vn = {};
  document.querySelectorAll("[data-view-name]").forEach((el) => {
    const v = el.getAttribute("data-view-name");
    vn[v] = (vn[v] || 0) + 1;
  });
  out.dataViewNames = vn;

  // 4. Job links = the surest sign of the results list
  const links = [...document.querySelectorAll("a[href*='/jobs/view/']")];
  out.jobViewLinks = links.length;
  out.sampleJobLink = links[0] ? {
    href: links[0].getAttribute("href").slice(0, 80),
    text: (links[0].innerText || "").trim().slice(0, 60),
    // what does the CARD around this link look like?
    ancestry: (() => {
      const chain = [];
      let n = links[0];
      for (let i = 0; i < 6 && n; i++, n = n.parentElement) {
        chain.push(`${n.tagName.toLowerCase()}` +
          (n.id ? `#${n.id}` : "") +
          (n.className ? "." + String(n.className).trim().split(/\s+/).slice(0, 3).join(".") : "") +
          (n.getAttribute && n.getAttribute("data-view-name") ? `[data-view-name=${n.getAttribute("data-view-name")}]` : "") +
          (n.getAttribute && n.getAttribute("data-occludable-job-id") ? "[data-occludable-job-id]" : ""));
      }
      return chain;
    })(),
  } : null;

  // 4b. The NEW React app doesn't use /jobs/view/ anchors. Find what the cards
  //     actually are: currentJobId links, other /jobs/ links, React fiber props,
  //     and the scroll container that holds the virtualized list.
  const byPattern = {};
  for (const [name, sel] of [
    ["currentJobId links", "a[href*='currentJobId']"],
    ["any /jobs/ links", "a[href*='/jobs/']"],
    ["role=listitem", "[role='listitem']"],
    ["li elements", "li"],
    ["aria-label anchors", "a[aria-label]"],
  ]) {
    const els = [...document.querySelectorAll(sel)];
    byPattern[name] = {
      count: els.length,
      samples: els.slice(0, 5).map((e) => ({
        href: (e.getAttribute && e.getAttribute("href") || "").slice(0, 90),
        text: (e.innerText || "").replace(/\s+/g, " ").trim().slice(0, 60),
      })),
    };
  }
  out.linkPatterns = byPattern;

  // React fiber: the props often carry the job urn even when the DOM doesn't
  const probeEl = document.querySelector("a[href*='currentJobId']")
    || document.querySelector("[role='listitem']")
    || document.querySelector("a[href*='/jobs/']");
  out.reactFiber = (() => {
    if (!probeEl) return "no candidate element";
    const keys = Object.keys(probeEl).filter((k) =>
      k.startsWith("__react") || k.startsWith("_react"));
    if (!keys.length) return "no react keys on element";
    const info = { keys };
    try {
      const fiber = probeEl[keys[0]];
      const props = (fiber && (fiber.memoizedProps || fiber.pendingProps))
        || (fiber && fiber.return && fiber.return.memoizedProps);
      if (props) {
        info.propKeys = Object.keys(props).slice(0, 25);
        const j = JSON.stringify(props, (k, v) =>
          (typeof v === "object" && v !== null && k && k.length > 40) ? "[obj]" : v);
        const urn = j && j.match(/urn:li:[a-zA-Z]+:\d+/g);
        info.urns = urn ? [...new Set(urn)].slice(0, 5) : [];
      }
    } catch (e) { info.error = String(e && e.message); }
    return info;
  })();

  // The virtualized list's scroll container — needed to load all 25 cards
  out.scrollContainers = [...document.querySelectorAll("div,ul,section,main")]
    .filter((e) => e.scrollHeight > e.clientHeight + 200 && e.clientHeight > 200)
    .slice(0, 5)
    .map((e) => ({
      tag: e.tagName.toLowerCase(),
      cls: String(e.className || "").slice(0, 60),
      scrollH: e.scrollHeight, clientH: e.clientHeight,
      children: e.children.length,
    }));

  // 5. Where is the description? Biggest text blocks on the page.
  const big = [];
  document.querySelectorAll("div,section,article,main").forEach((el) => {
    const len = (el.innerText || "").length;
    if (len > 800 && el.children.length < 60) {
      big.push({ len, id: el.id || "", cls: String(el.className || "").slice(0, 80) });
    }
  });
  big.sort((a, b) => b.len - a.len);
  out.biggestTextBlocks = big.slice(0, 8);

  // 6. Does LinkedIn ship the posting as structured data here?
  let ld = 0;
  document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
    try {
      const d = JSON.parse(s.textContent);
      const items = Array.isArray(d) ? d : [d, ...(d["@graph"] || [])];
      for (const it of items) if (it && it["@type"] === "JobPosting") ld += (it.description || "").length;
    } catch (e) { /* not JSON */ }
  });
  out.jsonLdJobPostingChars = ld;

  console.log("=== JARVIS PAGE PROBE ===");
  console.log(JSON.stringify(out, null, 1));
  console.log("=== copy everything above back to Jarvis ===");
  return out;
})();

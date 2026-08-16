/* Jarvis content script: extract a page's readable text + a schema of its form
 * fields, and fill fields the user approved — one at a time, never submitting.
 *
 * Safety invariants enforced HERE, structurally (not by prompting):
 *   - password, payment (cc-*), OTP and hidden/invisible fields never enter the
 *     schema, so the model can't ask for them and fill() can't resolve them;
 *   - fields are addressed by opaque refs into a local map — a CSS selector the
 *     model invented can never reach an element;
 *   - nothing that looks like a submitter is ever clicked, and Enter is never
 *     dispatched into a form (implicit submission).
 */
(() => {
  /* Re-injection: REPLACE, never skip.
   *
   * The old guard returned early when a flag was set. But the service worker
   * re-injects this file to recover a frame that isn't answering — and an early
   * return left that frame with the flag set and NO live listener, so it never
   * replied and every read failed permanently. LinkedIn hit this every time: its
   * SPA rewrites the DOM without reloading, so the declared script's listener can
   * be gone while the flag survives.
   *
   * Now each injection tears down the previous listener (if any) and installs a
   * fresh one, so re-injecting always heals the frame.
   */
  if (window.__jarvisTeardown) {
    try { window.__jarvisTeardown(); } catch (e) { /* previous listener already dead */ }
  }

  const FIELDS = new Map();          // ref -> element (rebuilt on each scan)
  let refSeq = 0;

  // ── visibility: the honeypot battery ────────────────────────────────────
  // Job forms plant invisible fields to catch bots; filling one flags the
  // application. Modern traps avoid display:none, so test properly.
  function isVisible(el) {
    try {
      if (el.type === "hidden" || el.disabled || el.readOnly) return false;
      if (typeof el.checkVisibility === "function" &&
          !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      // parked far off-screen (a favourite honeypot trick)
      if (r.right < -500 || r.bottom < -500) return false;
      if (el.closest('[aria-hidden="true"]')) return false;
      if (el.tabIndex === -1 && !labelFor(el)) return false;
      return true;
    } catch (e) {
      return false;
    }
  }

  // ── hard exclusions: credentials and payment instruments ────────────────
  const BAD_AC = /(^|\s)(current-password|new-password|one-time-code|cc-(number|csc|exp|exp-month|exp-year|name|type|given-name|family-name|additional-name))(\s|$)/i;
  const BAD_NAME = /(pass(word|wd)|otp|cvv|cvc|card.?num|securitycode|routing|iban|ssn|social.?security)/i;
  function isForbidden(el) {
    const t = (el.type || "").toLowerCase();
    if (t === "password") return true;
    const ac = el.getAttribute("autocomplete") || "";
    if (BAD_AC.test(ac)) return true;
    const hay = [el.name, el.id, el.getAttribute("aria-label"), el.placeholder]
      .filter(Boolean).join(" ");
    return BAD_NAME.test(hay);
  }

  // ── label resolution (Chromium/Bitwarden precedence) ────────────────────
  function labelFor(el) {
    const txt = (s) => (s || "").replace(/\s+/g, " ").trim();
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l && txt(l.innerText)) return txt(l.innerText);
    }
    const wrap = el.closest("label");
    if (wrap && txt(wrap.innerText)) return txt(wrap.innerText);
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      const parts = lb.split(/\s+/).map((id) => document.getElementById(id))
        .filter(Boolean).map((n) => txt(n.innerText));
      if (parts.join(" ").trim()) return txt(parts.join(" "));
    }
    const al = el.getAttribute("aria-label");
    if (txt(al)) return txt(al);
    if (txt(el.placeholder)) return txt(el.placeholder);
    if (txt(el.title)) return txt(el.title);
    // nearest preceding text node/element (label-less layouts)
    let p = el.previousElementSibling;
    for (let i = 0; i < 3 && p; i++, p = p.previousElementSibling) {
      const t = txt(p.innerText);
      if (t && t.length <= 120) return t;
    }
    const auto = el.getAttribute("data-automation-id");   // Workday convention
    if (auto) return txt(auto.replace(/[-_]/g, " "));
    return txt(el.name || el.id);
  }

  function sectionFor(el) {
    const fs = el.closest("fieldset");
    const leg = fs && fs.querySelector("legend");
    if (leg && leg.innerText.trim()) return leg.innerText.trim().slice(0, 80);
    let n = el;
    while ((n = n.parentElement)) {
      const h = n.querySelector && n.querySelector("h1,h2,h3,h4,legend");
      if (h && h.innerText.trim()) return h.innerText.trim().slice(0, 80);
      if (n.tagName === "FORM") break;
    }
    return "";
  }

  const FIELD_SEL = "input,textarea,select,[contenteditable=''],[contenteditable='true']";

  /* Shadow-root accessor.
   *
   * chrome.dom.openOrClosedShadowRoot(el) THROWS for anything that isn't a valid
   * shadow host — which is almost every node on a page. The old code only checked
   * that the API existed, never that the call succeeded, so on a big site
   * (LinkedIn) the very first non-host element killed the entire scan and every
   * frame reported an error. Always attempt the cheap open .shadowRoot first, and
   * treat the closed-root API as best-effort. */
  function shadowRootOf(el) {
    try {
      if (el.shadowRoot) return el.shadowRoot;
    } catch (e) { /* some elements throw on access */ }
    try {
      if (chrome.dom && typeof chrome.dom.openOrClosedShadowRoot === "function") {
        return chrome.dom.openOrClosedShadowRoot(el) || null;
      }
    } catch (e) { /* not a shadow host — by far the common case */ }
    return null;
  }

  // shadow DOM: querySelectorAll can't cross roots (Bitwarden's traversal).
  // Depth- and size-capped: a malformed/recursive tree must not hang the page.
  function deepQueryAll(root, out, depth) {
    out = out || [];
    depth = depth || 0;
    if (depth > 8 || out.length > 2000) return out;
    let nodes;
    try {
      nodes = root.querySelectorAll ? root.querySelectorAll("*") : [];
    } catch (e) {
      return out;
    }
    for (const n of nodes) {
      try {
        if (n.matches && n.matches(FIELD_SEL)) out.push(n);
      } catch (e) { /* exotic element — skip */ }
      const sr = shadowRootOf(n);
      if (sr) deepQueryAll(sr, out, depth + 1);   // the old walker never descended:
    }                                             // createTreeWalker ignored `root`
    return out;
  }

  function kindOf(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "select") return "select";
    if (tag === "textarea") return "textarea";
    if (el.isContentEditable) return "contenteditable";
    const t = (el.type || "text").toLowerCase();
    if (["checkbox", "radio", "file", "email", "tel", "url", "number", "date"].includes(t)) return t;
    return "text";
  }

  function scanFields() {
    FIELDS.clear();
    refSeq = 0;
    const fields = [];
    const excluded = { credentials: 0, hidden_or_honeypot: 0 };
    for (const el of deepQueryAll(document)) {
      // One awkward element must never cost the whole page: skip it and carry on.
      // (A single throw here used to fail the entire frame, which is how a
      // shadow-DOM quirk turned into "the reader failed on every frame".)
      try {
      if (isForbidden(el)) { excluded.credentials++; continue; }
      if (!isVisible(el)) { excluded.hidden_or_honeypot++; continue; }
      const ref = "f" + ++refSeq;
      FIELDS.set(ref, el);
      const kind = kindOf(el);
      const f = {
        ref, kind,
        label: labelFor(el).slice(0, 160),
        section: sectionFor(el),
        required: !!(el.required || el.getAttribute("aria-required") === "true"),
        autocomplete: el.getAttribute("autocomplete") || "",
        nameAttr: el.name || "", idAttr: el.id || "",
        automationId: el.getAttribute("data-automation-id") || "",
        maxLength: el.maxLength > 0 ? el.maxLength : null,
        currentValue: kind === "checkbox" || kind === "radio"
          ? (el.checked ? "checked" : "")
          : String(el.value || "").slice(0, 200),
      };
      if (kind === "select") {
        f.options = Array.from(el.options).slice(0, 60)
          .map((o) => ({ value: o.value, text: (o.text || "").trim() }));
        if (el.options.length > 60) f.optionsTruncated = true;
      }
      fields.push(f);
      } catch (e) { /* unreadable element — omit it rather than fail the scan */ }
    }
    return { fields, excluded_counts: excluded };
  }

  /* LinkedIn's jobs UI is a two-pane SPA: a list of <li> cards on the left and the
   * selected posting on the right. A whole-body innerText dump buries the posting
   * under nav chrome, and the cards' text is a soup of aria labels and "Easy Apply"
   * badges. So extract it structurally: the open posting in full, plus a compact
   * index of the visible cards (title · company · location · flags). */
  /* The visible job cards, deduped and parsed once — shared by the page-text
   * extractor and by read_listings. Both the <li> and the .job-card-container
   * inside it match the selector, so dedupe by job id or every posting appears
   * twice. */
  function linkedinCards() {
    if (!/linkedin\.com/.test(location.hostname)) return [];
    const t = (n) => (n && (n.innerText || "")).replace(/\s+/g, " ").trim();
    const seen = new Set();
    const out = [];
    for (const el of document.querySelectorAll("li[data-occludable-job-id], .job-card-container")) {
      const id = el.getAttribute("data-occludable-job-id") || el.getAttribute("data-job-id");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const link = el.querySelector("a.job-card-container__link, a.job-card-list__title--link");
      const title = (link && (link.getAttribute("aria-label") || t(link))) || "";
      if (!title) continue;
      const href = link && link.getAttribute("href");
      out.push({
        el, link, id, title,
        company: t(el.querySelector(".artdeco-entity-lockup__subtitle")),
        place: t(el.querySelector(".job-card-container__metadata-wrapper, .artdeco-entity-lockup__caption")),
        foot: t(el.querySelector(".job-card-container__footer-wrapper")),
        url: href ? "https://www.linkedin.com" + href.split("?")[0] : "",
        active: !!(el.querySelector('[aria-current="page"]') || el.matches('[aria-current="page"]')
                   || el.querySelector(".jobs-search-results-list__list-item--active")),
      });
      if (out.length >= 40) break;
    }
    return out;
  }

  /* The open posting's pane. LinkedIn renames these classes regularly (and hashes
   * some), so try the known names, then fall back to STRUCTURE: the biggest text
   * block in the detail column that isn't the results list. Relying on one class
   * name is what left every listing "(description didn't load)". */
  function detailPane() {
    const SELS = [".jobs-search__job-details", ".jobs-details", ".job-view-layout",
                  "#job-details", ".jobs-search__job-details--wrapper",
                  ".jobs-details__main-content", ".jobs-box__html-content",
                  "[class*='jobs-search__job-details']"];
    for (const sel of SELS) {
      let n = null;
      try { n = document.querySelector(sel); } catch (e) { continue; }
      if (n && (n.innerText || "").trim().length > 200) return n;
    }
    // structural fallback: the detail column of the two-pane layout
    const col = document.querySelector(".scaffold-layout__detail, main .scaffold-layout__detail");
    if (col && (col.innerText || "").trim().length > 200) return col;
    return null;
  }

  function detailSignature() {
    const d = detailPane();
    return d ? (d.innerText || "").trim().slice(0, 400) : "";
  }

  function linkedinJobs() {
    if (!/linkedin\.com/.test(location.hostname)) return null;
    const t = (n) => (n && (n.innerText || "")).replace(/\s+/g, " ").trim();
    const out = [];

    const detail = detailPane();
    if (detail && t(detail).length > 200) {
      out.push("=== OPEN POSTING ===", (detail.innerText || "").replace(/\n{3,}/g, "\n\n").trim());
    }

    const cards = linkedinCards();
    if (cards.length) {
      const rows = cards.map((c) =>
        `${c.active ? "▶ " : "- "}${c.title}` +
        (c.company ? ` — ${c.company}` : "") +
        (c.place ? ` (${c.place})` : "") +
        (c.foot ? ` [${c.foot}]` : "") +
        (c.id ? ` #${c.id}` : "") +
        (c.url ? `\n    ${c.url}` : ""));
      out.push("", `=== JOB LIST (${rows.length} shown; ▶ = currently open) ===`,
               rows.join("\n"),
               "", "(Ask me to read them all and I'll open each one for its full "
               + "description.)");
    }
    return out.length ? out.join("\n") : null;
  }

  function pageText(limit) {
    const special = linkedinJobs();
    if (special) return special.slice(0, limit || 20000);
    const clone = document.body ? document.body.cloneNode(true) : null;
    if (!clone) return "";
    clone.querySelectorAll("script,style,noscript,svg,nav,footer,aside,[aria-hidden='true']")
      .forEach((n) => n.remove());
    return (clone.innerText || "").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ")
      .trim().slice(0, limit || 20000);
  }

  function atsOf() {
    const h = location.hostname;
    if (/greenhouse\.io/.test(h)) return "greenhouse";
    if (/lever\.co/.test(h)) return "lever";
    if (/myworkdayjobs\.com|workday/.test(h)) return "workday";
    if (/linkedin\.com/.test(h)) return "linkedin";
    return "generic";
  }

  // ── filling ─────────────────────────────────────────────────────────────
  const SUBMITTY = /(submit|apply|send|next|continue|review|finish|save and)/i;
  function isSubmitter(el) {
    if (!el) return false;
    if (el.type === "submit" || el.type === "image") return true;
    const name = (el.innerText || el.value || el.getAttribute("aria-label") || "");
    return SUBMITTY.test(name);
  }

  function nativeSet(el, value) {
    // React/Vue track values on the instance; assigning el.value is swallowed.
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  function highlight(el, state) {
    if (!document.getElementById("__jarvis_hl_style")) {
      const s = document.createElement("style");
      s.id = "__jarvis_hl_style";
      // outline never affects layout, so the page can't be reflowed by us
      s.textContent =
        '[data-jarvis-hl="pending"]{outline:2px solid #6c5ce7 !important;outline-offset:2px !important}' +
        '[data-jarvis-hl="filled"]{outline:2px solid #00b894 !important;outline-offset:2px !important}';
      (document.head || document.documentElement).appendChild(s);
    }
    if (state) el.setAttribute("data-jarvis-hl", state);
    else el.removeAttribute("data-jarvis-hl");
  }

  function fillOne(ref, value) {
    // The service worker namespaces refs across frames as "<frameId>:<ref>"; each
    // frame only knows its own bare ids. A ref for another frame simply isn't here,
    // and that frame handles it in parallel.
    const bare = String(ref).includes(":") ? String(ref).split(":").pop() : String(ref);
    const el = FIELDS.get(bare);
    if (!el || !el.isConnected) return { ref, ok: false, error: "field is gone (page changed?)" };
    if (isForbidden(el) || !isVisible(el)) return { ref, ok: false, error: "field is not fillable" };
    if (isSubmitter(el)) return { ref, ok: false, error: "refusing to touch a submit control" };
    try {
      highlight(el, "pending");
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      const kind = kindOf(el);
      el.focus();
      if (kind === "checkbox" || kind === "radio") {
        const want = value === true || /^(true|yes|on|checked|1)$/i.test(String(value));
        if (!!el.checked !== want) el.click();      // click fires everything natively
      } else if (kind === "select") {
        const opts = Array.from(el.options);
        const want = String(value).toLowerCase();
        const hit = opts.find((o) => o.value.toLowerCase() === want)
          || opts.find((o) => (o.text || "").trim().toLowerCase() === want)
          || opts.find((o) => (o.text || "").toLowerCase().includes(want));
        if (!hit) return { ref, ok: false, error: "no matching option" };
        nativeSet(el, hit.value);
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (kind === "contenteditable") {
        document.execCommand("insertText", false, String(value));
      } else {
        nativeSet(el, String(value));
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
      el.blur();                                     // many form libs validate on blur
      highlight(el, "filled");
      const now = (kind === "checkbox" || kind === "radio") ? (el.checked ? "checked" : "") : String(el.value || "");
      return { ref, ok: true, value: now.slice(0, 200) };
    } catch (e) {
      return { ref, ok: false, error: String(e && e.message || e) };
    }
  }

  // ── message handling ────────────────────────────────────────────────────
  const onMessage = (msg, _sender, respond) => {
    try {
      if (msg.action === "read_page") {
        // Text and fields fail independently: a page whose form scan trips must
        // still return its text (and vice versa), instead of the whole frame
        // reporting failure and the user being told to reload.
        let text = "", fields = [], excluded = { credentials: 0, hidden_or_honeypot: 0 };
        const warnings = [];
        try { text = pageText(msg.params && msg.params.limit); }
        catch (e) { warnings.push("text: " + (e && e.message || e)); }
        try { const s = scanFields(); fields = s.fields; excluded = s.excluded_counts; }
        catch (e) { warnings.push("fields: " + (e && e.message || e)); }
        respond({
          ok: true,
          url: location.href,
          title: document.title,
          ats: atsOf(),
          isTop: window.top === window,
          page_text: text,
          fields: fields,
          excluded_counts: excluded,
          warnings: warnings.length ? warnings : undefined,
        });
      } else if (msg.action === "probe_layout") {
        /* Diagnostic: what does this page actually look like to us? Reports which
         * detail-pane selector matches and how many cards we see, so a layout change
         * is a five-second check instead of a guessing session. */
        const SELS = [".jobs-search__job-details", ".jobs-details", ".job-view-layout",
                      "#job-details", ".jobs-search__job-details--wrapper",
                      ".jobs-details__main-content", "[class*='jobs-search__job-details']",
                      ".scaffold-layout__detail", ".jobs-box__html-content"];
        const hits = SELS.map((sel) => {
          let n = null;
          try { n = document.querySelector(sel); } catch (e) { /* bad selector */ }
          return { sel, found: !!n, chars: n ? (n.innerText || "").trim().length : 0 };
        });
        const cards = linkedinCards();
        respond({ ok: true, url: location.href, selectors: hits,
                  cardCount: cards.length,
                  firstCard: cards[0] ? { title: cards[0].title, hasLink: !!cards[0].link,
                                          connected: !!(cards[0].el && cards[0].el.isConnected) }
                                      : null });
      } else if (msg.action === "read_listings") {
        /* Open each job card in turn and collect its full description.
         *
         * Only ever runs on an explicit user request ("read all of these"), inside
         * the tab they are already looking at, at human pace — this is the user
         * clicking through their own search results, not a crawler: no pagination,
         * no navigation away, nothing fetched that isn't already on this page. */
        const ids = linkedinCards().map((c) => c.id);
        if (!ids.length) { respond({ ok: false, error: "no job list on this page" }); return true; }
        const want = Math.min(ids.length, (msg.params && msg.params.max) || 8);
        const out = [];
        const diag = [];
        let i = 0;

        const next = () => {
          if (i >= want) { respond({ ok: true, listings: out, diag }); return; }
          const id = ids[i++];
          // Re-find the card by ID each time: LinkedIn VIRTUALIZES the list, so the
          // element captured at scan time is detached by the time we reach it — the
          // click then went nowhere and every description came back empty.
          const card = linkedinCards().find((c) => c.id === id);
          if (!card) { diag.push(`#${id}: card gone from DOM`); next(); return; }
          const before = detailSignature();
          try {
            card.el.scrollIntoView({ block: "center" });   // virtualized lists need this
            (card.link || card.el).click();
          } catch (e) {
            diag.push(`#${id}: click failed ${e && e.message}`);
          }
          // Poll for the pane to actually CHANGE, rather than assuming a fixed delay.
          let waited = 0;
          const poll = () => {
            const sig = detailSignature();
            if ((sig && sig !== before && sig.length > 300) || waited >= 4000) {
              const d = detailPane();
              const text = d ? (d.innerText || "").replace(/\n{3,}/g, "\n\n").trim() : "";
              if (!text) diag.push(`#${id}: pane empty after ${waited}ms`);
              out.push({
                title: card.title, company: card.company, place: card.place,
                url: card.url, flags: card.foot,
                description: text ? text.slice(0, 6000) : "(description didn't load)",
              });
              next();
              return;
            }
            waited += 200;
            setTimeout(poll, 200);
          };
          setTimeout(poll, 250);
        };
        next();
        return true;                   // async respond
      } else if (msg.action === "list_fields") {
        const scan = scanFields();
        respond({ ok: true, url: location.href, ats: atsOf(), isTop: window.top === window,
                  fields: scan.fields, excluded_counts: scan.excluded_counts });
      } else if (msg.action === "fill_fields") {
        const results = [];
        // Only the fills whose refs live in THIS frame (see fillOne): every frame gets
        // the same message and answers for its own fields.
        const items = ((msg.params && msg.params.fills) || []).filter((it) => {
          const bare = String(it.ref).includes(":") ? String(it.ref).split(":").pop() : String(it.ref);
          return FIELDS.has(bare);
        });
        let i = 0;
        const step = () => {
          if (i >= items.length) { respond({ ok: true, results }); return; }
          const it = items[i++];
          results.push(Object.assign(fillOne(it.ref, it.value), { ref: it.ref }));
          setTimeout(step, 90);        // let per-field validators and dependent fields catch up
        };
        step();
        return true;                   // async respond
      } else {
        respond({ ok: false, error: "unknown action" });
      }
    } catch (e) {
      respond({ ok: false, error: String(e && e.message || e) });
    }
    return true;
  };

  chrome.runtime.onMessage.addListener(onMessage);
  // Let the NEXT injection remove this listener, so re-injecting a wedged frame
  // always yields exactly one live listener (see the header comment).
  window.__jarvisTeardown = () => {
    try { chrome.runtime.onMessage.removeListener(onMessage); } catch (e) { /* gone */ }
    window.__jarvisTeardown = null;
  };
})();

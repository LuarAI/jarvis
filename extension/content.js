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
  // Bumped whenever this file changes: every reply carries it, so "the page is running
  // an old script" is visible in the answer instead of being inferred from a weird error.
  const JARVIS_CS_VERSION = 5;

  const FIELDS = new Map();          // ref -> element (rebuilt on each scan)
  const FIELD_FP = new Map();        // ref -> fingerprint, re-checked before writing
  let refSeq = 0;

  // ── visibility: the honeypot battery ────────────────────────────────────
  // Job forms plant invisible fields to catch bots; filling one flags the
  // application. Modern traps avoid display:none, so test properly.
  function isVisible(el) {
    try {
      if (el.type === "hidden" || el.disabled || el.readOnly) return false;
      const t = (el.type || "").toLowerCase();
      /* Radios and checkboxes are routinely SIZE-ZERO by design: the control is
       * hidden and its <label> is styled to look like the button you click (this is
       * how LinkedIn Easy Apply renders every Yes/No). Judging them by their own box
       * marked them as honeypots and dropped them from the schema entirely — which
       * is why Jarvis could see the text questions but not the Yes/No ones. Judge
       * them by whether their LABEL is visible instead. */
      if (t === "radio" || t === "checkbox") {
        if (el.closest('[aria-hidden="true"]')) return false;
        const lab = (el.id && labelElementFor(el.id)) || el.closest("label");
        for (const n of [el, lab]) {
          if (!n) continue;
          try {
            const r = n.getBoundingClientRect();
            if (r.width >= 2 && r.height >= 2 && r.right > -500 && r.bottom > -500) {
              return true;
            }
          } catch (e) { /* try the next candidate */ }
        }
        return false;
      }
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

  /* <label for="…"> lookup that tolerates ids CSS.escape can't express (LinkedIn's
   * urn:li:fsd_formElement:…(4452974708,35282365962,multipleChoice)). */
  function labelElementFor(id) {
    try {
      const l = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (l) return l;
    } catch (e) { /* fall through */ }
    try {
      return Array.from(document.querySelectorAll("label[for]"))
        .find((n) => n.getAttribute("for") === id) || null;
    } catch (e) {
      return null;
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
  /* Strings that look like a label but aren't — accepting one is worse than
   * finding nothing, because it silently reads as a real question. LinkedIn's
   * radio groups put a visually-hidden "Required" span inside the <legend>. */
  const LABEL_NOISE = /^(required|optional|\*|select an option|choose|please select|yes|no)$/i;

  /* Read an element's text INCLUDING visually-hidden parts.
   *
   * innerText skips anything hidden by CSS, and LinkedIn duplicates each question
   * as an aria-hidden span plus a .visually-hidden span for screen readers. Using
   * innerText therefore returned "" for those labels and the resolver fell back to
   * the element id — the "raw element ids" the user saw. textContent sees both
   * copies, so de-duplicate the doubled text afterwards. */
  function labelText(node) {
    if (!node) return "";
    let s = (node.textContent || "").replace(/\s+/g, " ").trim();
    if (!s) return "";
    // Strip the trailing Required/* FIRST: LinkedIn appends it inside the same
    // container, and leaving it on defeats the duplicate check below.
    s = s.replace(/\s*(required|optional|\*)\s*$/i, "").trim();
    // "Question?Question?" → "Question?" — LinkedIn renders each question twice,
    // once aria-hidden and once visually-hidden, so textContent sees both.
    const half = s.length / 2;
    if (s.length % 2 === 0 && s.slice(0, half).trim() === s.slice(half).trim()) {
      s = s.slice(0, half).trim();
    } else {
      // tolerate a separator between the copies ("Q? Q?")
      const m = s.match(/^(.{8,}?)[\s.,;:—-]*\1$/);
      if (m) s = m[1].trim();
    }
    return s;
  }

  function labelFor(el) {
    const ok = (s) => (s && !LABEL_NOISE.test(s) && s !== el.id && s !== el.name) ? s : "";
    let hit;
    if (el.id) {
      let l = null;
      try { l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); }
      catch (e) { /* exotic id — fall through */ }
      if (!l) {                       // CSS.escape can still miss urn:li:…(a,b,c) ids
        try {
          l = Array.from(document.querySelectorAll("label[for]"))
            .find((n) => n.getAttribute("for") === el.id) || null;
        } catch (e) { /* none */ }
      }
      if ((hit = ok(labelText(l)))) return hit;
    }
    if ((hit = ok(labelText(el.closest("label"))))) return hit;
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      const parts = lb.split(/\s+/).map((id) => document.getElementById(id))
        .filter(Boolean).map(labelText).filter((t) => t && !LABEL_NOISE.test(t));
      if ((hit = ok(parts.join(" ").trim()))) return hit;
    }
    if ((hit = ok((el.getAttribute("aria-label") || "").trim()))) return hit;
    // the group's own caption: <fieldset><legend> (radio groups), or the question
    // block LinkedIn/Greenhouse wrap each field in
    const grp = el.closest("fieldset");
    if (grp && (hit = ok(labelText(grp.querySelector("legend"))))) return hit;
    const box = el.closest("[data-test-form-element], .fb-dash-form-element, "
                           + ".artdeco-text-input--container, .form-group, fieldset");
    if (box) {
      const cap = box.querySelector("label, legend, .fb-dash-form-element__label");
      if ((hit = ok(labelText(cap)))) return hit;
    }
    if ((hit = ok((el.placeholder || "").trim()))) return hit;
    if ((hit = ok((el.title || "").trim()))) return hit;
    let p = el.previousElementSibling;
    for (let i = 0; i < 3 && p; i++, p = p.previousElementSibling) {
      const t = labelText(p);
      if (t && t.length <= 200 && (hit = ok(t))) return hit;
    }
    const auto = el.getAttribute("data-automation-id");   // Workday convention
    if (auto) return auto.replace(/[-_]/g, " ").trim();
    return "";                        // NOT the id: an unlabelled field must say so
  }

  /* Where the label came from. Returned in the schema so the model can tell a real
   * question from a fallback and ask instead of inventing an answer — Jarvis could
   * previously only detect failure when the label happened to equal the id. */
  function labelSourceFor(el, label) {
    if (!label) return "none";
    const t = (n) => labelText(n);
    if (el.id) {
      let l = null;
      try {
        l = Array.from(document.querySelectorAll("label[for]"))
          .find((n) => n.getAttribute("for") === el.id) || null;
      } catch (e) { /* none */ }
      if (l && t(l) === label) return "label-for";
    }
    if (t(el.closest("label")) === label) return "wrapping-label";
    if ((el.getAttribute("aria-labelledby") || "").trim()) return "aria-labelledby";
    if ((el.getAttribute("aria-label") || "").trim() === label) return "aria-label";
    const grp = el.closest("fieldset");
    if (grp && t(grp.querySelector("legend")) === label) return "legend";
    if ((el.placeholder || "").trim() === label) return "placeholder";
    return "nearby-text";
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

  const FIELD_SEL = "input,textarea,select,[contenteditable=''],[contenteditable='true']," +
    // Workday-style listboxes are BUTTONS, so they'd never be found by an
    // input/select scan — but they're fields as far as the user is concerned.
    "[aria-haspopup='listbox'],[role='combobox']";

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
    // a listbox-backed control (Workday) behaves like a select to the user even
    // though it's a button — say so, or the model proposes free text for it
    if (isCombobox(el)) return "combobox";
    const t = (el.type || "text").toLowerCase();
    if (["checkbox", "radio", "file", "email", "tel", "url", "number", "date"].includes(t)) return t;
    return "text";
  }

  /* The visible text of one radio/checkbox option: its own label, not the group's
   * question. LinkedIn puts it in <label for>; other forms wrap the input. */
  function optionText(el) {
    const lab = (el.id && labelElementFor(el.id)) || el.closest("label");
    const t = labelText(lab);
    if (t) return t;
    return (el.value || "").trim();
  }

  /* The question a radio GROUP asks — one level up from the individual options.
   * fieldset/legend first (LinkedIn, Greenhouse), then an explicit radiogroup, then
   * the shared form-element container. */
  function groupLabel(el) {
    const grp = el.closest("fieldset, [role='radiogroup'], [data-test-form-element], "
                           + ".fb-dash-form-element, .form-group");
    if (!grp) return "";
    const legend = grp.querySelector("legend, .fb-dash-form-element__label");
    let t = labelText(legend);
    if (t && !LABEL_NOISE.test(t)) return t;
    t = (grp.getAttribute("aria-label") || "").trim();
    if (t && !LABEL_NOISE.test(t)) return t;
    const lb = grp.getAttribute("aria-labelledby");
    if (lb) {
      const parts = lb.split(/\s+/).map((id) => document.getElementById(id))
        .filter(Boolean).map(labelText).filter((s) => s && !LABEL_NOISE.test(s));
      if (parts.length) return parts.join(" ");
    }
    return "";
  }

  function scanFields() {
    FIELDS.clear();
    refSeq = 0;
    const fields = [];
    const excluded = { credentials: 0, hidden_or_honeypot: 0 };
    const radioGroups = new Map();     // group key → {members, field}
    for (const el of deepQueryAll(document)) {
      // One awkward element must never cost the whole page: skip it and carry on.
      // (A single throw here used to fail the entire frame, which is how a
      // shadow-DOM quirk turned into "the reader failed on every frame".)
      try {
      if (isForbidden(el)) { excluded.credentials++; continue; }
      if (!isVisible(el)) { excluded.hidden_or_honeypot++; continue; }
      /* A radio group is N inputs sharing a name but ONE logical question.
       * Emitting them separately would hand the model two refs ("Yes", "No") with
       * no signal that they're exclusive — so collapse them into a single field
       * shaped exactly like a <select>, options and all, and remember every member
       * so the fill can click the right one. */
      if ((el.type || "").toLowerCase() === "radio") {
        const key = (el.form ? "f" : "") + (el.name || groupLabel(el) || "radio");
        let g = radioGroups.get(key);
        if (!g) {
          const ref = "f" + ++refSeq;
          const question = groupLabel(el) || labelFor(el) || "";
          g = {
            members: [],
            field: { ref, kind: "radio", label: question.slice(0, 160),
                     labelSource: question ? "legend" : "none",
                     nameAttr: el.name || "", options: [], currentValue: "" },
          };
          radioGroups.set(key, g);
          fields.push(g.field);
          FIELDS.set(ref, g.members);           // the fill resolves this to a member
          FIELD_FP.set(ref, "radio|" + key + "|" + question.slice(0, 60));
        }
        g.members.push(el);
        const text = optionText(el);
        g.field.options.push({ value: el.value || text, text });
        if (el.checked) g.field.currentValue = text || el.value || "";
        continue;
      }
      const ref = "f" + ++refSeq;
      FIELDS.set(ref, el);
      const kind = kindOf(el);
      const lbl = labelFor(el);
      /* Identity that does NOT depend on document order.
       *
       * Refs were ordinal, so if the page re-rendered between listing the fields and
       * the user approving the fill (LinkedIn's count went 39 → 34 → 39), f7 pointed
       * at a DIFFERENT element and a value was written into the wrong input — a
       * healthcare answer landed in a "Your Role / Title" box on a live application.
       * The fill now re-verifies this fingerprint before typing and refuses on
       * mismatch, so drift becomes a clean error instead of silent corruption. */
      const fp = [el.tagName, el.type || "", el.name || "", el.id || "",
                  lbl.slice(0, 60)].join("|");
      FIELD_FP.set(ref, fp);
      const f = {
        ref, kind,
        label: lbl.slice(0, 160),
        labelSource: labelSourceFor(el, lbl),
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
   * extractor and by the page index. Both the <li> and the .job-card-container
   * inside it match the selector, so dedupe by job id or every posting appears
   * twice. */
  /* Card selectors, in priority order.
   *
   * LinkedIn is mid-migration from the legacy Ember/artdeco DOM (hashed BEM classes)
   * to React with data-view-name attributes and virtualized [data-component-type=
   * LazyColumn] lists — which is why /jobs/search-results/ looked empty while
   * /jobs/collections/ worked. Match on STABLE attributes (data-occludable-job-id,
   * data-job-id, data-view-name) and use :has() so hashed class names never matter.
   * Shape follows damianmgarcia/Hide-n-Seek, which carries both DOM generations. */
  const CARD_SELECTORS = [
    "li[data-occludable-job-id]",
    "li:has(.job-card-container, .job-search-card, [data-job-id])",
    ".job-card-container[data-job-id]",
    "[data-view-name='job-card']",
    "div:has(> [data-view-name='job-search-job-card'])",
    "[data-view-name='job-search-job-card']",
  ];

  /* Job ids WITHOUT touching the DOM's class names.
   *
   * The new /jobs/search-results/ React app has no data-* hooks and hashes every
   * class (_4bbf76d5), so any selector written against it dies on LinkedIn's next
   * deploy. But the URL carries the ids: currentJobId is the open one, and
   * originToLandingJobPostings lists the results. Those are LinkedIn's own API
   * contract, not styling, so they survive redesigns — this is the durable hook. */
  function idsFromUrl() {
    const ids = [];
    try {
      const u = new URL(location.href);
      const cur = u.searchParams.get("currentJobId");
      if (cur) ids.push(cur);
      const landing = u.searchParams.get("originToLandingJobPostings");
      if (landing) {
        for (const part of landing.split(",")) {
          const id = part.trim();
          if (id && !ids.includes(id)) ids.push(id);
        }
      }
    } catch (e) { /* malformed URL */ }
    return ids;
  }

  /* Every job id the page mentions, from anywhere that isn't a class name:
   * card anchors, currentJobId links, and any urn:li:jobPosting in the markup. */
  function idsFromPage() {
    const ids = new Set(idsFromUrl());
    try {
      for (const a of document.querySelectorAll("a[href]")) {
        const href = a.getAttribute("href") || "";
        let m = /\/jobs\/view\/(\d+)/.exec(href) || /[?&]currentJobId=(\d+)/.exec(href);
        if (m) ids.add(m[1]);
      }
    } catch (e) { /* ignore */ }
    try {
      const html = document.documentElement.innerHTML;
      const re = /urn:li:(?:jobPosting|fsd_jobPosting):(\d+)/g;
      let m, guard = 0;
      while ((m = re.exec(html)) && guard++ < 200) ids.add(m[1]);
    } catch (e) { /* huge page — skip */ }
    return [...ids];
  }

  function cardId(el) {
    const direct = el.getAttribute("data-occludable-job-id") || el.getAttribute("data-job-id");
    if (direct) return direct;
    const inner = el.querySelector && el.querySelector("[data-job-id], [data-occludable-job-id]");
    if (inner) {
      const v = inner.getAttribute("data-job-id") || inner.getAttribute("data-occludable-job-id");
      if (v) return v;
    }
    // React layout: the id lives in the card's own /jobs/view/<id> link
    const a = el.matches && el.matches("a[href*='/jobs/view/']")
      ? el : (el.querySelector && el.querySelector("a[href*='/jobs/view/']"));
    const m = a && /\/jobs\/view\/(\d+)/.exec(a.getAttribute("href") || "");
    return m ? m[1] : null;
  }

  function linkedinCards() {
    if (!/linkedin\.com/.test(location.hostname)) return [];
    // NB the parens: `(n && n.innerText) || ""` — the old form evaluated to null for a
    // missing element and then threw on .replace, which killed the whole scan on
    // layouts that lack the legacy classes.
    const t = (n) => ((n && n.innerText) || "").replace(/\s+/g, " ").trim();
    const seen = new Set();
    const out = [];
    const nodes = [];
    for (const sel of CARD_SELECTORS) {
      try {
        for (const n of document.querySelectorAll(sel)) nodes.push(n);
      } catch (e) { /* :has() unsupported on an old engine — skip that selector */ }
    }
    for (const el of nodes) {
      const id = cardId(el);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      // Title/link: legacy classes first, then ANY /jobs/view/ anchor (React layout),
      // then the card's own aria-label. Hashed classes are never required.
      const link = el.querySelector("a.job-card-container__link, a.job-card-list__title--link")
        || el.querySelector("a[href*='/jobs/view/']")
        || (el.matches && el.matches("a[href*='/jobs/view/']") ? el : null);
      let title = (link && (link.getAttribute("aria-label") || t(link))) || "";
      if (!title) title = t(el.querySelector("[class*='job-card-list__title'], strong")) || "";
      if (!title) title = (el.getAttribute("aria-label") || "").trim();
      if (!title) continue;
      title = title.replace(/\s+with verification$/i, "").trim();
      const href = link && link.getAttribute("href");
      // Company/location: the legacy lockup classes, else the card's remaining lines.
      let company = t(el.querySelector(".artdeco-entity-lockup__subtitle"));
      let place = t(el.querySelector(
        ".job-card-container__metadata-wrapper, .artdeco-entity-lockup__caption"));
      if (!company || !place) {
        const lines = (el.innerText || "").split("\n")
          .map((s) => s.trim())
          .filter((s) => s && s !== title && !/^(easy apply|promoted|viewed|saved)$/i.test(s));
        if (!company && lines[0]) company = lines[0];
        if (!place && lines[1]) place = lines[1];
      }
      out.push({
        el, link, id, title, company, place,
        foot: t(el.querySelector(".job-card-container__footer-wrapper"))
          || ((el.innerText || "").match(/Easy Apply|Promoted|Viewed|Actively reviewing/gi) || []).join(" · "),
        url: href ? ("https://www.linkedin.com" + href.split("?")[0]).replace(
                      /^https:\/\/www\.linkedin\.comhttps?:/, "https:")
                  : `https://www.linkedin.com/jobs/view/${id}/`,
        active: !!(el.querySelector('[aria-current="page"]') || (el.matches && el.matches('[aria-current="page"]'))
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
  const DETAIL_SELECTORS = [
    "#job-details",                              // an ID, the most durable of the set
    ".jobs-description-content__text",
    ".jobs-box__html-content",
    ".jobs-description__content",
    "[class*='jobs-description']",
    "[data-view-name='job-details']",            // React layout
    ".jobs-search__job-details",
    ".jobs-details", ".job-view-layout",
    ".scaffold-layout__detail",                  // structural: the whole detail column
  ];

  function detailPane() {
    for (const sel of DETAIL_SELECTORS) {
      let n = null;
      try { n = document.querySelector(sel); } catch (e) { continue; }
      if (n && (n.innerText || "").trim().length > 200) return n;
    }
    return null;
  }

  /* Last resort: LinkedIn embeds a schema.org JobPosting in the page. When every
   * selector misses (a layout we've never seen), this still yields the description. */
  function jsonLdPosting() {
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      let data = null;
      try { data = JSON.parse(s.textContent || "{}"); } catch (e) { continue; }
      const items = Array.isArray(data) ? data : [data, ...(data["@graph"] || [])];
      for (const it of items) {
        if (it && it["@type"] === "JobPosting" && it.description) {
          const tmp = document.createElement("div");
          tmp.innerHTML = String(it.description);
          const text = (tmp.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
          if (text.length > 100) {
            return [it.title, it.hiringOrganization && it.hiringOrganization.name, text]
              .filter(Boolean).join("\n");
          }
        }
      }
    }
    return "";
  }

  function detailText() {
    const d = detailPane();
    const text = d ? (d.innerText || "").replace(/\n{3,}/g, "\n\n").trim() : "";
    return text || jsonLdPosting();
  }

  /* Which job is the detail pane currently showing? The URL's currentJobId is the
   * SPA's own source of truth, so a click is "done" when it matches the card we
   * clicked — far more reliable than a fixed delay, which is how the reader ended up
   * capturing the PREVIOUS job's description. */
  function openJobId() {
    try {
      const u = new URL(location.href);
      const q = u.searchParams.get("currentJobId");
      if (q) return q;
    } catch (e) { /* fall through */ }
    const m = /\/jobs\/view\/(\d+)/.exec(location.pathname);
    if (m) return m[1];
    const a = document.querySelector(
      ".jobs-search__job-details a[href*='/jobs/view/'], [data-view-name='job-details'] a[href*='/jobs/view/']");
    const m2 = a && /\/jobs\/view\/(\d+)/.exec(a.getAttribute("href") || "");
    return m2 ? m2[1] : null;
  }

  function detailSignature() {
    const d = detailPane();
    return d ? (d.innerText || "").trim().slice(0, 400) : "";
  }

  function linkedinJobs() {
    if (!/linkedin\.com/.test(location.hostname)) return null;
    // NB the parens: `(n && n.innerText) || ""` — the old form evaluated to null for a
    // missing element and then threw on .replace, which killed the whole scan on
    // layouts that lack the legacy classes.
    const t = (n) => ((n && n.innerText) || "").replace(/\s+/g, " ").trim();
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

  /* Workday-style listbox: a <button aria-haspopup="listbox">, never a <select>.
   * You cannot assign a value — you must open the popup and CLICK the option, and
   * the options don't exist in the DOM until it opens. Hence the async dance:
   * click, wait for the listbox, match the text, click it. Returns a promise. */
  function isCombobox(el) {
    try {
      return el.getAttribute("aria-haspopup") === "listbox"
        || el.getAttribute("role") === "combobox"
        || (el.tagName === "BUTTON" && !!el.getAttribute("data-automation-id"));
    } catch (e) {
      return false;
    }
  }

  function fillCombobox(el, value, ref) {
    return new Promise((resolve) => {
      const want = String(value).trim().toLowerCase();
      try {
        el.scrollIntoView({ block: "center" });
        el.click();
      } catch (e) {
        resolve({ ref, ok: false, error: "couldn't open the list" });
        return;
      }
      let waited = 0;
      const OPT = "[role='option'], [data-automation-id='promptOption'], "
                + "[data-automation-id='menuItem'], li[role='option']";
      const poll = () => {
        let opts = [];
        try { opts = Array.from(document.querySelectorAll(OPT)); } catch (e) { /* none */ }
        const visible = opts.filter((o) => {
          try { return o.getBoundingClientRect().height > 0; } catch (e) { return false; }
        });
        if (visible.length) {
          const txt = (o) => (o.innerText || o.textContent || "").replace(/\s+/g, " ").trim();
          const hit = visible.find((o) => txt(o).toLowerCase() === want)
            || visible.find((o) => txt(o).toLowerCase().includes(want))
            || visible.find((o) => want.includes(txt(o).toLowerCase()) && txt(o).length > 2);
          if (hit) {
            try {
              hit.scrollIntoView({ block: "nearest" });
              hit.click();
              resolve({ ref, ok: true, value: txt(hit).slice(0, 200) });
            } catch (e) {
              resolve({ ref, ok: false, error: "couldn't click the option" });
            }
            return;
          }
          if (waited >= 1500) {           // list is open but nothing matches
            try { el.click(); } catch (e) { /* leave it */ }   // close it again
            resolve({ ref, ok: false,
                      error: `no option matching "${value}" (saw: ` +
                             visible.slice(0, 4).map(txt).join(", ") + ")" });
            return;
          }
        }
        if (waited >= 3000) {
          resolve({ ref, ok: false, error: "the option list never opened" });
          return;
        }
        waited += 150;
        setTimeout(poll, 150);
      };
      setTimeout(poll, 200);
    });
  }

  function fillOne(ref, value) {
    // The service worker namespaces refs across frames as "<frameId>:<ref>"; each
    // frame only knows its own bare ids. A ref for another frame simply isn't here,
    // and that frame handles it in parallel.
    const bare = String(ref).includes(":") ? String(ref).split(":").pop() : String(ref);
    let el = FIELDS.get(bare);
    /* A radio ref resolves to the GROUP (an array of inputs); pick the member whose
     * option text or value matches, then click it. Direct .checked assignment is
     * ignored by React, so a real click is the only thing that sticks. */
    if (Array.isArray(el)) {
      const live = el.filter((n) => n && n.isConnected);
      if (!live.length) return { ref, ok: false, error: "the options are gone (page changed?)" };
      const want = String(value).trim().toLowerCase();
      const norm = (s) => String(s || "").trim().toLowerCase();
      const pick = live.find((n) => norm(optionText(n)) === want)
        || live.find((n) => norm(n.value) === want)
        || live.find((n) => norm(optionText(n)).startsWith(want))
        || live.find((n) => want.startsWith(norm(optionText(n))) && norm(optionText(n)).length > 1);
      if (!pick) {
        return { ref, ok: false,
                 error: `no option "${value}" (choices: `
                        + live.map(optionText).filter(Boolean).join(", ") + ")" };
      }
      try {
        (labelElementFor(pick.id) || pick).scrollIntoView({ block: "center" });
        pick.click();                       // fires input+change the way a user does
        if (!pick.checked) {                // some forms need the label clicked
          const lab = labelElementFor(pick.id);
          if (lab) lab.click();
        }
      } catch (e) {
        return { ref, ok: false, error: String(e && e.message || e) };
      }
      // verify: a write that silently didn't take is worse than a reported failure
      if (!pick.checked) {
        return { ref, ok: false, error: "the option didn't select (the form ignored it)" };
      }
      highlight(pick, "filled");
      return { ref, ok: true, value: optionText(pick) || pick.value || "" };
    }
    if (!el || !el.isConnected) return { ref, ok: false, error: "field is gone (page changed?)" };
    if (isForbidden(el) || !isVisible(el)) return { ref, ok: false, error: "field is not fillable" };
    if (isSubmitter(el)) return { ref, ok: false, error: "refusing to touch a submit control" };
    // Refuse if this ref no longer points at the field it was listed as. A re-render
    // between listing and approval used to silently retarget the write.
    const want = FIELD_FP.get(bare);
    if (want && !String(want).startsWith("radio|")) {
      const now = [el.tagName, el.type || "", el.name || "", el.id || "",
                   labelFor(el).slice(0, 60)].join("|");
      if (now !== want) {
        return { ref, ok: false,
                 error: "the form changed since it was read — re-read it before "
                        + "filling (refusing to write into a different field)" };
      }
    }
    try {
      highlight(el, "pending");
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      const kind = kindOf(el);
      // Workday and friends: not a <select>, so it must be opened and clicked.
      // Returns a promise — the caller awaits it.
      if (kind !== "select" && isCombobox(el)) {
        return fillCombobox(el, value, ref).then((r) => {
          highlight(el, r.ok ? "filled" : null);
          return r;
        });
      }
      el.focus();
      if (kind === "checkbox" || kind === "radio") {
        const want = value === true || /^(true|yes|on|checked|1)$/i.test(String(value));
        if (!!el.checked !== want) el.click();      // click fires everything natively
        if (!!el.checked !== want) {                // hidden input? click its label
          const lab = labelElementFor(el.id);
          if (lab) lab.click();
        }
        if (!!el.checked !== want) {                // verify: a silent no-op is worse
          return { ref, ok: false, error: "the box didn't change (the form ignored it)" };
        }
      } else if (kind === "select") {
        const opts = Array.from(el.options);
        const want = String(value).toLowerCase();
        const hit = opts.find((o) => o.value.toLowerCase() === want)
          || opts.find((o) => (o.text || "").trim().toLowerCase() === want)
          || opts.find((o) => (o.text || "").toLowerCase().includes(want));
        if (!hit) return { ref, ok: false, error: "no matching option" };
        nativeSet(el, hit.value);
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (kind === "file") {
        /* CV upload. input.files is assignable via a DataTransfer, which is the
         * standard (and only) way to attach a file programmatically. The bytes come
         * from the overlay as base64 — the user picked the file there, so this is
         * their own document, attached on their behalf after they approved it. */
        const f = value && value.__file;
        if (!f || !f.b64) return { ref, ok: false, error: "no file provided" };
        const bin = atob(f.b64);
        const buf = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        const dt = new DataTransfer();
        dt.items.add(new File([buf], f.name || "document.pdf",
                              { type: f.type || "application/octet-stream" }));
        el.files = dt.files;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        // drag-and-drop uploaders listen for `drop` rather than the input's change
        try {
          const zone = el.closest("[class*='drop'], [class*='upload']") || el.parentElement;
          if (zone) {
            const ev = new DragEvent("drop", { bubbles: true, dataTransfer: dt });
            zone.dispatchEvent(ev);
          }
        } catch (e) { /* plain input — the change above already did it */ }
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

  /* Read each job by driving the SPA's own URL parameter.
   *
   * pushState + popstate makes LinkedIn's router swap the detail pane exactly as a
   * click would, without needing to find (or click) a card. Class-name churn can't
   * break this, which is the point: three rounds of selector fixes died to hashed
   * classes. The original URL is restored at the end. */
  function readByUrl(ids, respond) {
    const started = location.href;
    const out = [];
    const diag = ["url-driven mode (no DOM cards found)"];
    let i = 0;

    const finish = () => {
      try { history.pushState({}, "", started); window.dispatchEvent(new PopStateEvent("popstate")); }
      catch (e) { /* leave the URL as-is rather than fail the read */ }
      respond({ ok: true, listings: out, diag, csVersion: JARVIS_CS_VERSION });
    };

    const next = () => {
      if (i >= ids.length) { finish(); return; }
      const id = ids[i++];
      const before = detailText().slice(0, 400);
      try {
        const u = new URL(location.href);
        u.searchParams.set("currentJobId", id);
        history.pushState({}, "", u.toString());
        window.dispatchEvent(new PopStateEvent("popstate"));
      } catch (e) {
        diag.push(`#${id}: navigation failed ${e && e.message}`);
      }
      let waited = 0;
      const poll = () => {
        const text = detailText();
        const open = openJobId();
        const ready = text.length > 200
          && (String(open) === String(id) || text.slice(0, 400) !== before);
        if (ready || waited >= 8000) {
          if (!ready) diag.push(`#${id}: no description after ${waited}ms (open=${open})`);
          const head = text.split("\n").map((s) => s.trim()).filter(Boolean);
          out.push({
            title: head[0] || `Job ${id}`,
            company: head[1] || "",
            place: head[2] || "",
            url: `https://www.linkedin.com/jobs/view/${id}/`,
            flags: "",
            description: text ? text.slice(0, 6000) : "(description didn't load)",
          });
          next();
          return;
        }
        waited += 150;
        setTimeout(poll, 150);
      };
      setTimeout(poll, 250);
    };
    next();
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
      } else if (msg.action === "collect_snapshot") {
        /* One page snapshot for the collector: what the user is looking at RIGHT
         * NOW. No clicking, no enumeration, no walking a result set — the user
         * browses, we remember. That sidesteps every fragile thing about scraping
         * a listing UI (hashed classes, virtualization, hidden ids) because the
         * content is already on screen, and it keeps the human in front of the
         * filter. Works on any site, not just job boards. */
        const key = openJobId() || location.href.split("#")[0];
        const text = (linkedinJobs() ? detailText() : "") || pageText(6000);
        respond({
          ok: true,
          key: String(key),
          url: location.href.slice(0, 300),
          title: (document.title || "").slice(0, 160),
          text: (text || "").slice(0, 6000),
          csVersion: JARVIS_CS_VERSION,
        });
      } else if (msg.action === "probe_layout") {
        /* Diagnostic: what does this page actually look like to us? Reports which
         * detail-pane selector matches and how many cards we see, so a layout change
         * is a five-second check instead of a guessing session. */
        const hits = DETAIL_SELECTORS.map((sel) => {
          let n = null;
          try { n = document.querySelector(sel); } catch (e) { /* bad selector */ }
          return { sel, found: !!n, chars: n ? (n.innerText || "").trim().length : 0 };
        });
        const cardSel = CARD_SELECTORS.map((sel) => {
          let n = 0;
          try { n = document.querySelectorAll(sel).length; } catch (e) { n = -1; }
          return { sel, count: n };
        });
        /* Rather than only testing MY guesses, report what the page actually has:
         * the most common attributes, and the classes of the biggest text blocks.
         * That turns "everything returned 0" into a list of selectors that exist. */
        const attrCounts = {};
        for (const a of ["data-job-id", "data-occludable-job-id", "data-view-name",
                         "data-component-type", "data-entity-urn", "data-test-id"]) {
          let n = 0;
          try { n = document.querySelectorAll(`[${a}]`).length; } catch (e) { n = -1; }
          if (n) attrCounts[a] = n;
        }
        const viewNames = {};
        try {
          for (const el of document.querySelectorAll("[data-view-name]")) {
            const v = el.getAttribute("data-view-name");
            viewNames[v] = (viewNames[v] || 0) + 1;
          }
        } catch (e) { /* none */ }
        const jobLinks = (() => {
          try { return document.querySelectorAll("a[href*='/jobs/view/']").length; }
          catch (e) { return -1; }
        })();
        // biggest text blocks — the description is almost certainly one of them
        const big = [];
        try {
          for (const el of document.querySelectorAll("div,section,article,main")) {
            const len = (el.innerText || "").length;
            if (len > 800 && el.children.length < 60) {
              big.push({ cls: (el.className || "").toString().slice(0, 70),
                         id: el.id || "", len });
            }
          }
          big.sort((a, b) => b.len - a.len);
        } catch (e) { /* ignore */ }

        const cards = linkedinCards();
        respond({ ok: true, url: location.href, selectors: hits, cardSelectors: cardSel,
                  csVersion: JARVIS_CS_VERSION,
                  openJobId: openJobId(),
                  jsonLd: jsonLdPosting().length,
                  isTop: window.top === window,
                  bodyChars: (document.body && document.body.innerText || "").length,
                  attrs: attrCounts, viewNames, jobLinks,
                  bigBlocks: big.slice(0, 6),
                  cardCount: cards.length,
                  firstCard: cards[0] ? { title: cards[0].title, id: cards[0].id,
                                          hasLink: !!cards[0].link,
                                          connected: !!(cards[0].el && cards[0].el.isConnected) }
                                      : null });
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
          // fillOne returns a plain object OR a promise (comboboxes must open a
          // popup and click an option). Promise.resolve normalises both.
          Promise.resolve(fillOne(it.ref, it.value)).then((r) => {
            results.push(Object.assign(r || {}, { ref: it.ref }));
          }).catch((e) => {
            results.push({ ref: it.ref, ok: false, error: String(e && e.message || e) });
          }).then(() => {
            setTimeout(step, 90);      // let validators and dependent fields catch up
          });
        };
        step();
        return true;                   // async respond
      } else {
        respond({ ok: false, error: "unknown action", csVersion: JARVIS_CS_VERSION });
      }
    } catch (e) {
      respond({ ok: false, error: String(e && e.message || e),
                csVersion: JARVIS_CS_VERSION });
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

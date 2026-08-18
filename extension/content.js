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
  const JARVIS_CS_VERSION = 7;

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
    /* A slider thumb's own aria-label is only "Minimum"/"Maximum" — true but useless
     * on its own, since it never says minimum OF WHAT. The question lives on an
     * ancestor's aria-labelledby (Radix's usual shape). Join them so the model gets
     * "…monthly pay rate… — Minimum" rather than two indistinguishable thumbs. */
    if (el.getAttribute("role") === "slider") {
      const own = (el.getAttribute("aria-label") || "").trim();
      let grpText = "";
      let n = el.parentElement;
      for (let i = 0; i < 5 && n && !grpText; i++, n = n.parentElement) {
        const ids = n.getAttribute && n.getAttribute("aria-labelledby");
        if (ids) {
          grpText = ids.split(/\s+/).map((id) => document.getElementById(id))
            .filter(Boolean).map(labelText).filter(Boolean).join(" ").trim();
        }
      }
      const joined = [grpText, own].filter(Boolean).join(" — ");
      if ((hit = ok(joined))) return hit;
    }
    /* A <label for> whose target doesn't exist.
     *
     * Strider labels its skills picker <label for="mainSkills"> but the input is
     * id="stacks-0" — there is no #mainSkills at all. The label is orphaned, so
     * every id-based lookup misses and the PLACEHOLDER wins: the field came back
     * called "E.g React.js" instead of "What are your main skills?". Adopt an
     * orphaned label from the enclosing block, but only if it points at nothing —
     * a label with a real target belongs to that target, not to us. */
    const orphan = (l) => {
      if (!l) return "";
      const tgt = l.getAttribute && l.getAttribute("for");
      if (!tgt || document.getElementById(tgt)) return "";    // it has a real owner
      return ok(labelText(l));
    };
    /* Walk outward, and at each level check the PRECEDING SIBLINGS — a caption sits
     * just before the block it describes. Deliberately not a form-wide sweep: that
     * would let one field adopt a distant field's orphaned label. */
    let node = el;
    for (let up = 0; up < 4 && node && node.tagName !== "FORM" && node.tagName !== "BODY"; up++) {
      let sib = node.previousElementSibling;
      for (let i = 0; i < 3 && sib; i++, sib = sib.previousElementSibling) {
        if ((hit = orphan(sib))) return hit;
        const inner = sib.querySelector && sib.querySelector("label[for]");
        if ((hit = orphan(inner))) return hit;
      }
      node = node.parentElement;
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
    "[aria-haspopup='listbox'],[role='combobox']," +
    // Custom sliders are <span role="slider"> (Radix, MUI, Reach). They carry a
    // value the user must set, so they are fields — but no input/select scan finds
    // them, which is why Strider's pay-rate slider never appeared in the list.
    "[role='slider']";

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
    // a slider is a value control, not text — check before contenteditable/type so a
    // <span role="slider"> is never mistaken for something typeable
    if (el.getAttribute("role") === "slider") return "slider";
    if (tag === "input" && (el.type || "").toLowerCase() === "range") return "slider";
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
      /* A combobox wrapper and the <input> inside it BOTH match the selector, so the
       * same control was listed twice ("Which roles are you open to?" appeared as a
       * combobox and again as a text box) — two refs for one question, and the model
       * had no way to know they were the same. Keep the input, drop the wrapper:
       * the input is what carries the label, the value, and the typing. */
      if (el.getAttribute("role") === "combobox"
          || el.getAttribute("aria-haspopup") === "listbox") {
        if (comboInput(el) && comboInput(el) !== el) continue;
      }
      /* A slider's companion input. Radix renders a plain <input> beside each thumb
       * to carry the value in form submissions; it's display:none, but a hidden
       * control that survives the visibility check would be listed as a nameless
       * text box and could adopt a neighbouring field's label — i.e. a second, wrong
       * ref for a question the model already has. The thumb is the real control. */
      if (el.tagName === "INPUT" && !el.id && !el.name
          && (el.previousElementSibling || el.nextElementSibling)
          && [el.previousElementSibling, el.nextElementSibling]
               .some((n) => n && n.getAttribute
                         && n.getAttribute("role") === "slider")) continue;
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
      if (kind === "slider") {
        /* Report the RANGE, not just the current value. Strider's pay slider runs
         * 0..97 while the visible labels read $600..$20,000 — it's an INDEX into a
         * non-linear scale, so a model told only "$600 to $20,000" would propose a
         * dollar amount that means nothing to the control. Give it both: the raw
         * bounds it must speak in, and aria-valuetext (what the user sees) so it can
         * tell that 0 currently means $600. */
        const s = sliderInfo(el);
        f.min = s.min; f.max = s.max; f.step = s.step;
        f.currentValue = String(s.now);
        if (s.text) f.valueText = s.text;
        /* Only flag a scale mismatch when there IS one. A native <input type=range>
         * for "years of experience" means literally 7 years, and calling that an
         * index would push the model toward converting a number that needs no
         * conversion. aria-valuetext differing from aria-valuenow is the signal that
         * the control's number isn't what the user sees. */
        if (s.text && s.text.replace(/\s/g, "") !== String(s.now)) {
          f.scaleNote = "the control's number is not the displayed value: "
                      + `${s.now} currently shows as "${s.text}"`;
        }
      }
      if (kind === "combobox") {
        /* Options usually DON'T exist until the user types (they're fetched), so an
         * empty options list here means "type to discover", not "no choices". Say
         * which it is, so the model knows whether it can pick from a known set or is
         * proposing a string that must be matched against a catalogue it can't see. */
        const box = comboListbox(el);
        const opts = box ? Array.from(box.querySelectorAll("[role='option'],li")) : [];
        const texts = opts.map((o) => (o.textContent || "").replace(/\s+/g, " ").trim())
          .filter(Boolean).slice(0, 60);
        if (texts.length) f.options = texts.map((t) => ({ value: t, text: t }));
        else f.optionsDynamic = true;          // they appear only after typing
        // several values allowed? (chips-style pickers say so, or repeat the input)
        const host = el.closest("[role='combobox'],[aria-haspopup='listbox']") || el;
        if (host.getAttribute("aria-multiselectable") === "true"
            || el.getAttribute("aria-multiselectable") === "true") f.multiple = true;
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

  /* ── "show me where": point at things on the page ──────────────────────────
   *
   * Drawn IN THE PAGE, not on a screen overlay. That's the whole design decision:
   * a marker anchored to the element moves with it for free — scroll, resize,
   * reflow — whereas a screen overlay would have to poll and re-project, and would
   * still smear during smooth scrolling. It also means no screenshot is taken and
   * nothing leaves the machine.
   *
   * Two shapes, because the accuracy differs sharply:
   *   - element: a ring around one control ("the Submit button")
   *   - region : a labelled box around an area ("this strip is the tool palette")
   * Regions are what a model is reliable at, so the tool can fall back to naming an
   * area rather than guessing a specific control.
   */
  const HL_ROOT_ID = "__jarvis_showme";
  const HL_PALETTE = ["#ff5c5c", "#56ccf2", "#ffbe3c", "#82dc82", "#c88cff",
                      "#ff8cbe", "#78f0dc", "#faa05a"];
  let hlItems = [];                      // [{el|rect, n, label, node, arrow}]
  let hlRaf = 0;

  function hlRoot() {
    let r = document.getElementById(HL_ROOT_ID);
    if (r) return r;
    r = document.createElement("div");
    r.id = HL_ROOT_ID;
    // pointer-events:none is the safety rule — the overlay must never eat a click
    // meant for the page underneath.
    r.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;"
                    + "pointer-events:none;";
    (document.body || document.documentElement).appendChild(r);
    return r;
  }

  function clearShowMe() {
    hlItems = [];
    if (hlRaf) { cancelAnimationFrame(hlRaf); hlRaf = 0; }
    const r = document.getElementById(HL_ROOT_ID);
    if (r) r.remove();
    window.removeEventListener("scroll", hlSchedule, true);
    window.removeEventListener("resize", hlSchedule, true);
    document.removeEventListener("keydown", hlKey, true);
    document.removeEventListener("mousedown", hlDismiss, true);
  }

  function hlKey(e) {
    if (e.key === "Escape") clearShowMe();
  }
  function hlDismiss() { clearShowMe(); }

  function hlSchedule() {
    if (hlRaf) return;
    hlRaf = requestAnimationFrame(() => { hlRaf = 0; hlReposition(); });
  }

  /* Reposition every marker from its element's CURRENT rect. Called on scroll and
   * resize — this is what "follows the page" means. An element that has been removed
   * (SPA re-render) drops its marker rather than pointing at empty space. */
  function hlReposition() {
    const vw = window.innerWidth, vh = window.innerHeight;
    for (const it of hlItems.slice()) {
      let r;
      if (it.el) {
        if (!it.el.isConnected) { it.node.remove(); if (it.arrow) it.arrow.remove();
                                  hlItems = hlItems.filter((x) => x !== it); continue; }
        r = it.el.getBoundingClientRect();
      } else {
        r = it.rect;
      }
      const off = r.bottom < 0 ? "up" : (r.top > vh ? "down" : "");
      it.node.style.display = off ? "none" : "block";
      if (!off) {
        it.node.style.left = (r.left - 4) + "px";
        it.node.style.top = (r.top - 4) + "px";
        it.node.style.width = Math.max(8, r.width + 8) + "px";
        it.node.style.height = Math.max(8, r.height + 8) + "px";
      }
      /* Off-screen: show an arrow at the edge instead of silently hiding. Being told
       * "it's below, scroll down" is the difference between a hint and a dead end. */
      if (it.arrow) {
        it.arrow.style.display = off ? "flex" : "none";
        if (off) {
          it.arrow.style.top = off === "up" ? "12px" : (vh - 52) + "px";
          it.arrow.style.left = Math.min(vw - 120,
            Math.max(12, (r.left + r.width / 2) - 40)) + "px";
          it.arrow.firstChild.textContent = (off === "up" ? "▲ " : "▼ ") + it.n;
        }
      }
    }
  }

  function showMe(items) {
    clearShowMe();
    const root = hlRoot();
    const shown = [];
    items.slice(0, 8).forEach((it, i) => {
      const colour = HL_PALETTE[i % HL_PALETTE.length];
      let el = null, rect = null;
      if (it.ref) {
        const bare = String(it.ref).includes(":") ? String(it.ref).split(":").pop()
                                                  : String(it.ref);
        const found = FIELDS.get(bare);
        el = Array.isArray(found) ? found.find((n) => n && n.isConnected) : found;
        if (!el || !el.isConnected) return;             // stale ref: skip, don't guess
      } else if (it.selector) {
        try { el = document.querySelector(it.selector); } catch (e) { el = null; }
        if (!el) return;
      } else if (it.rect) {
        rect = { left: it.rect.x, top: it.rect.y, width: it.rect.w,
                 height: it.rect.h, bottom: it.rect.y + it.rect.h };
      } else {
        return;
      }

      const box = document.createElement("div");
      const dashed = it.approximate ? "dashed" : "solid";
      box.style.cssText =
        `position:fixed;border:3px ${dashed} ${colour};border-radius:6px;`
        + `box-shadow:0 0 0 2px rgba(0,0,0,.45),0 0 14px ${colour}88;`
        + "pointer-events:none;transition:opacity .15s;";
      const tag = document.createElement("div");
      tag.textContent = it.label ? (it.n || i + 1) + "  " + it.label : String(it.n || i + 1);
      tag.style.cssText =
        `position:absolute;left:-3px;top:-26px;background:${colour};color:#111;`
        + "font:600 13px/1.6 system-ui,sans-serif;padding:1px 8px;border-radius:5px;"
        + "white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis;";
      box.appendChild(tag);
      root.appendChild(box);

      const arrow = document.createElement("div");
      arrow.style.cssText =
        `position:fixed;display:none;align-items:center;background:${colour};color:#111;`
        + "font:600 13px/1.6 system-ui,sans-serif;padding:3px 10px;border-radius:14px;"
        + "box-shadow:0 2px 8px rgba(0,0,0,.5);pointer-events:none;";
      arrow.appendChild(document.createElement("span"));
      root.appendChild(arrow);

      const n = it.n || i + 1;
      hlItems.push({ el, rect, n, node: box, arrow });
      shown.push({ n, label: it.label || "", ref: it.ref || "", offscreen: false });
    });

    if (!hlItems.length) return { shown: [], error: "nothing to point at" };
    hlReposition();

    /* Bring ONE target into view, and only when it's off-screen. Scrolling the page
     * under the user is a real intrusion; doing it when the thing is already visible
     * would be gratuitous. Never for a multi-item explanation — that would yank the
     * view away from the overview the user asked for. */
    if (hlItems.length === 1 && hlItems[0].el) {
      const r = hlItems[0].el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) {
        try { hlItems[0].el.scrollIntoView({ block: "center", behavior: "smooth" }); }
        catch (e) { /* older engine — the arrow still tells them where it is */ }
      }
    }

    window.addEventListener("scroll", hlSchedule, true);
    window.addEventListener("resize", hlSchedule, true);
    document.addEventListener("keydown", hlKey, true);
    document.addEventListener("mousedown", hlDismiss, true);
    setTimeout(() => { if (hlItems.length) clearShowMe(); }, 30000);
    return { shown };
  }

  /* Workday-style listbox: a <button aria-haspopup="listbox">, never a <select>.
   * You cannot assign a value — you must open the popup and CLICK the option, and
   * the options don't exist in the DOM until it opens. Hence the async dance:
   * click, wait for the listbox, match the text, click it. Returns a promise. */
  function isCombobox(el) {
    try {
      if (el.getAttribute("aria-haspopup") === "listbox") return true;
      if (el.getAttribute("role") === "combobox") return true;
      if (el.tagName === "BUTTON" && el.getAttribute("data-automation-id")) return true;
      /* A type-ahead input announces itself on the INPUT… */
      if (el.getAttribute("aria-autocomplete")) return true;
      if (el.getAttribute("aria-controls") && el.getAttribute("aria-expanded")) return true;
      if (el.getAttribute("aria-activedescendant") !== null) return true;
      /* …but very often the ARIA role sits on a WRAPPER while the real control is
       * the plain <input> inside it (Strider's "roles"/"stacks" boxes are exactly
       * this). Reading only the input's own attributes called those plain text —
       * so the value was typed and never committed, and the box discarded it on
       * blur. Look one level out, but only for text-ish inputs. */
      const t = (el.type || "text").toLowerCase();
      if (el.tagName === "INPUT" && (t === "text" || t === "search")) {
        const host = el.closest("[role='combobox'],[aria-haspopup='listbox']");
        if (host && host !== el) return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  /* The input you actually type into for a combobox.
   *
   * When the role is on a wrapper (Strider) the wrapper itself isn't typeable; the
   * <input> inside it is. When the control is a Workday <button> there is no input
   * at all and we drive the button. */
  function comboInput(el) {
    try {
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return el;
      return el.querySelector("input:not([type='hidden']),textarea") || null;
    } catch (e) {
      return null;
    }
  }

  /* Where a combobox's options render. aria-controls/aria-owns name it explicitly;
   * otherwise the popup is a sibling list inside the wrapper. */
  function comboListbox(el) {
    try {
      const id = el.getAttribute("aria-controls") || el.getAttribute("aria-owns");
      if (id) {
        const n = document.getElementById(id);
        if (n) return n;
      }
      const host = el.closest("[role='combobox'],[aria-haspopup='listbox']") || el.parentElement;
      if (host) {
        const n = host.querySelector("[role='listbox'],ul,ol");
        if (n) return n;
        // some render the popup as a sibling of the wrapper rather than a child
        const sib = host.parentElement
          && host.parentElement.querySelector("[role='listbox']");
        if (sib) return sib;
      }
    } catch (e) { /* fall through */ }
    return null;
  }

  /* Native <input type="range"> and ARIA sliders share one shape. Read the numbers
   * from wherever they live: attributes for ARIA, properties for the native input. */
  function sliderInfo(el) {
    if (el.getAttribute("role") === "slider") {
      const num = (a, dflt) => {
        const v = parseFloat(el.getAttribute(a));
        return isNaN(v) ? dflt : v;
      };
      return {
        aria: true,
        min: num("aria-valuemin", 0),
        max: num("aria-valuemax", 100),
        now: num("aria-valuenow", 0),
        step: num("aria-valuestep", 1) || 1,
        text: (el.getAttribute("aria-valuetext") || "").trim(),
      };
    }
    const num = (v, dflt) => {
      const n = parseFloat(v);
      return isNaN(n) ? dflt : n;
    };
    return {
      aria: false,
      min: num(el.min, 0), max: num(el.max, 100),
      now: num(el.value, 0), step: num(el.step, 1) || 1, text: "",
    };
  }

  const OPT_SEL = "[role='option'], [data-automation-id='promptOption'], "
                + "[data-automation-id='menuItem'], li[role='option'], li";

  function optLabel(o) {
    return (o.innerText || o.textContent || "").replace(/\s+/g, " ").trim();
  }

  /* The options currently on offer, scoped to THIS combobox where possible.
   *
   * Scoping matters: a page with three skill pickers has three <ul>s, and a
   * document-wide query would happily click an option belonging to a different one.
   * Fall back to a document sweep only for popups portalled to <body> (Workday). */
  function visibleOptions(el) {
    let nodes = [];
    const box = comboListbox(el);
    try {
      if (box) nodes = Array.from(box.querySelectorAll(OPT_SEL));
      if (!nodes.length) nodes = Array.from(document.querySelectorAll(OPT_SEL));
    } catch (e) { /* none */ }
    return nodes.filter((o) => {
      try {
        if (!optLabel(o)) return false;
        const r = o.getBoundingClientRect();
        return r.height > 0 && r.width > 0;
      } catch (e) { return false; }
    });
  }

  /* Match a proposed string against the offered options.
   *
   * Ambiguity is NOT resolved by picking the first hit. "Py" matching both Python
   * and PyTorch, or "Chía" matching four Colombian towns, is exactly the case where
   * guessing writes a plausible wrong answer into a real application — so return the
   * candidates and let the model choose on the next turn. */
  function matchOption(opts, value) {
    const want = String(value).trim().toLowerCase();
    const exact = opts.filter((o) => optLabel(o).toLowerCase() === want);
    if (exact.length) return { hit: exact[0] };
    const pre = opts.filter((o) => optLabel(o).toLowerCase().startsWith(want));
    if (pre.length === 1) return { hit: pre[0] };
    if (pre.length > 1) return { ambiguous: pre };
    const sub = opts.filter((o) => optLabel(o).toLowerCase().includes(want));
    if (sub.length === 1) return { hit: sub[0] };
    if (sub.length > 1) return { ambiguous: sub };
    // the proposal is longer than the option ("AI Engineer (Remote)" vs "AI Engineer")
    const rev = opts.filter((o) => optLabel(o).length > 2
                                && want.includes(optLabel(o).toLowerCase()));
    if (rev.length === 1) return { hit: rev[0] };
    return {};
  }

  /* Type-ahead comboboxes: TYPE, wait, then COMMIT.
   *
   * The old version clicked the control and looked for options. That works for
   * Workday (a button that opens a static menu) but not for a search box whose
   * options don't exist until you type and the server answers — Strider's location,
   * roles and skills fields all behave that way. Worse, when no list appeared the
   * value stayed typed in the box and the tool reported success, so a field the user
   * believed was filled was silently empty on submit.
   *
   * So: set the value natively (React ignores plain assignment), fire `input` to
   * trigger the query, poll for options through the debounce, then click the match
   * and VERIFY something committed. On failure, clear what we typed — leaving
   * uncommitted text in a search box is how you submit a form with a half-typed city.
   */
  function fillCombobox(el, value, ref) {
    return new Promise((resolve) => {
      const input = comboInput(el);
      const before = chipSignature(el);
      const done = (r) => resolve(Object.assign({ ref }, r));

      try {
        (input || el).scrollIntoView({ block: "center" });
        if (input) {
          input.focus();
          nativeSet(input, String(value));
          input.dispatchEvent(new Event("input", { bubbles: true }));
          // some listen for keys rather than input events
          try {
            input.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
            input.dispatchEvent(new KeyboardEvent("keyup", { key: "a", bubbles: true }));
          } catch (e) { /* older engines — the input event above is the main path */ }
        } else {
          el.click();                    // Workday-style button: opens a static menu
        }
      } catch (e) {
        done({ ok: false, error: "couldn't open the list: " + (e && e.message) });
        return;
      }

      const giveUp = (err) => {
        // never leave half-typed text behind: it reads as filled and submits as junk
        if (input) {
          try {
            nativeSet(input, "");
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.blur();
          } catch (e) { /* best effort */ }
        }
        done({ ok: false, error: err });
      };

      let waited = 0;
      const STEP = 150;
      const LIMIT = 4000;                // remote-search boxes debounce ~300ms + RTT
      const poll = () => {
        const opts = visibleOptions(el);
        if (opts.length) {
          const m = matchOption(opts, value);
          if (m.hit) {
            const text = optLabel(m.hit);
            try {
              m.hit.scrollIntoView({ block: "nearest" });
              m.hit.click();
            } catch (e) {
              giveUp("couldn't click the option");
              return;
            }
            /* Verify the COMMIT, not the text box. A committed value shows up as a
             * chip, a hidden input, or aria-activedescendant — and on many pickers
             * the visible box is CLEARED on commit, so reading it back would report
             * failure for a success (and, before this, success for a failure). */
            setTimeout(() => {
              const after = chipSignature(el);
              const boxText = input ? String(input.value || "").trim() : "";
              const committed = after !== before
                || boxText.toLowerCase() === text.toLowerCase()
                || (!!input && boxText === "" && !!before !== !!after);
              if (committed || !input) done({ ok: true, value: text.slice(0, 200) });
              else done({ ok: false, error: `clicked "${text}" but the field didn't `
                                          + "record it — it may need to be picked by hand" });
            }, 250);
            return;
          }
          if (m.ambiguous) {
            giveUp(`"${value}" matches ${m.ambiguous.length} options — say which: `
                   + m.ambiguous.slice(0, 8).map(optLabel).join(" | "));
            return;
          }
          if (waited >= 1200) {          // list is open and settled, nothing matches
            giveUp(`no option matching "${value}" (offered: `
                   + opts.slice(0, 6).map(optLabel).join(" | ") + ")");
            return;
          }
        }
        if (waited >= LIMIT) {
          giveUp(opts.length ? `no option matching "${value}"`
                             : "the option list never appeared (the site may still be "
                               + "searching, or this control needs a real click)");
          return;
        }
        waited += STEP;
        setTimeout(poll, STEP);
      };
      setTimeout(poll, 200);
    });
  }

  /* A cheap fingerprint of what this control has COMMITTED — chips, selected
   * options, the hidden input a picker writes to. Compared before/after so a commit
   * can be confirmed rather than assumed. */
  function chipSignature(el) {
    try {
      /* Scope: the block that owns this control, not just its immediate parent.
       * Pickers render the committed chip as a SIBLING of the input's wrapper (or
       * further out), so a tight scope saw no chip and reported a successful commit
       * as a failure. Two levels up covers the common shapes without straying into
       * a neighbouring field. */
      const host = el.closest("[role='combobox'],[aria-haspopup='listbox']") || el;
      /* Climb to the block that holds the whole field. When the role sits on a
       * wrapper, that wrapper's parent is usually it; when there's no wrapper at all
       * (a bare type-ahead input), the input is `host` and we must climb further, or
       * the scope sits BELOW where the chip renders and a real commit reads as a
       * failure. Stop at the form so a neighbouring field's chips never count. */
      let scope = host;
      for (let i = 0; i < 3; i++) {
        const up = scope.parentElement;
        if (!up || up.tagName === "FORM" || up.tagName === "BODY") break;
        scope = up;
      }
      const parts = [];
      const sel = scope.querySelectorAll(
        "[role='option'][aria-selected='true'], [data-chip], [class*='chip'], "
        + "[class*='tag'], [class*='pill'], input[type='hidden']");
      for (const n of Array.from(sel).slice(0, 20)) {
        parts.push(n.tagName === "INPUT" ? String(n.value || "")
                                         : (n.textContent || "").trim());
      }
      const ad = el.getAttribute("aria-activedescendant");
      if (ad) parts.push("ad:" + ad);
      return parts.join("|");
    } catch (e) {
      return "";
    }
  }

  /* Set a slider by pressing keys, not by dragging.
   *
   * Every slider that meets the ARIA pattern implements Home/End/arrows, and Radix
   * (Strider's) reads event.key off a bubbling keydown — so dispatched keys work.
   * Pointer dragging would need geometry AND a linear scale, and this scale is not
   * linear: the control runs 0..97 while the labels read $600..$20,000. One
   * ArrowRight is exactly one step whatever the curve, so stepping lands where the
   * user asked; pixel math would not.
   *
   * Home first, then N steps, so the starting position can't matter.
   */
  function fillSlider(el, value, ref) {
    return new Promise((resolve) => {
      const s = sliderInfo(el);
      const target = Number(String(value).replace(/[$,\s]/g, ""));
      if (isNaN(target)) {
        resolve({ ref, ok: false,
                  error: `"${value}" isn't a number; this slider takes ${s.min}..${s.max}` });
        return;
      }
      const clamped = Math.max(s.min, Math.min(s.max, target));

      if (!s.aria) {                        // native <input type="range">: assignable
        try {
          nativeSet(el, String(clamped));
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        } catch (e) {
          resolve({ ref, ok: false, error: String(e && e.message || e) });
          return;
        }
        const now = sliderInfo(el).now;
        resolve({ ref, ok: true, value: String(now),
                  note: now !== target ? `landed on ${now} (asked ${target})` : undefined });
        return;
      }

      const key = (name) => {
        const init = { key: name, code: name, bubbles: true, cancelable: true };
        el.dispatchEvent(new KeyboardEvent("keydown", init));
        el.dispatchEvent(new KeyboardEvent("keyup", init));
      };
      try {
        el.scrollIntoView({ block: "center" });
        el.focus();
        key("Home");                        // known state, so steps are absolute
      } catch (e) {
        resolve({ ref, ok: false, error: "couldn't focus the slider" });
        return;
      }

      /* Step toward the target, re-reading aria-valuenow each time. Bounded, and it
       * stops early if the value stops moving — a slider that ignores keys must be
       * reported, not hammered 200 times. */
      const step = s.step || 1;
      let guard = 0;
      const MAX_STEPS = 400;
      let stalls = 0;
      const advance = () => {
        const now = sliderInfo(el).now;
        if (Math.abs(now - clamped) < step / 2 || guard >= MAX_STEPS) {
          finish(now);
          return;
        }
        const before = now;
        key(now < clamped ? "ArrowRight" : "ArrowLeft");
        guard++;
        const after = sliderInfo(el).now;
        if (after === before) {
          stalls++;
          if (stalls >= 3) { finish(after); return; }   // keys ignored, or at a bound
        } else {
          stalls = 0;
        }
        // yield occasionally so a React re-render can land between steps
        if (guard % 20 === 0) setTimeout(advance, 0);
        else advance();
      };
      const finish = (now) => {
        const info = sliderInfo(el);
        const shown = info.text ? ` (${info.text})` : "";
        if (Math.abs(now - clamped) > step) {
          resolve({ ref, ok: false,
                    error: `couldn't move the slider to ${clamped}; it stopped at `
                           + `${now}${shown}` });
          return;
        }
        /* Report where it LANDED, never what was asked. Sliders snap, and a snapped
         * salary floor reported as the requested number is a wrong number in a real
         * application. */
        resolve({ ref, ok: true, value: String(now) + shown,
                  note: now !== target
                    ? `landed on ${now}${shown}; you asked for ${target}` : undefined });
      };
      advance();
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
      // Sliders take keys, not text. Async because stepping yields to let the
      // component re-render between presses.
      if (kind === "slider") {
        return fillSlider(el, value, ref).then((r) => {
          highlight(el, r.ok ? "filled" : null);
          return r;
        });
      }
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
        /* Some type-ahead boxes are structurally INVISIBLE as such: Strider's
         * "Where do you live?" is a bare <input name="query"> with no role, no
         * aria-autocomplete and no list in the DOM until you type. Nothing at scan
         * time can tell it from a plain text field — so detect it here, after
         * typing: if a suggestion list appeared, this was a picker all along, and
         * leaving the raw text uncommitted would submit a city the site never
         * accepted. Hand off to the commit path. */
        if (el.tagName === "INPUT" && !el.getAttribute("list")) {
          return new Promise((res) => setTimeout(res, 400)).then(() => {
            if (!visibleOptions(el).length) {
              el.blur();
              highlight(el, "filled");
              return { ref, ok: true, value: String(el.value || "").slice(0, 200) };
            }
            return fillCombobox(el, value, ref).then((r) => {
              highlight(el, r.ok ? "filled" : null);
              return r;
            });
          });
        }
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
      } else if (msg.action === "probe_options") {
        /* Diagnostic for "the options came back as UUIDs".
         *
         * Every unit of the label path passes in isolation against the reported
         * markup, so the failure is something only the live page shows. Rather than
         * theorise again, report each step's ACTUAL result per radio input: what the
         * id is, whether a label[for] exists via each lookup route, what its raw
         * textContent is, and what optionText finally returned. Whichever step first
         * yields empty is the bug, with no guessing left to do. */
        const out = [];
        const groups = document.querySelectorAll(
          "fieldset[data-test-form-builder-radio-button-form-component], "
          + "fieldset, [role='radiogroup']");
        for (const g of Array.from(groups).slice(0, 6)) {
          const radios = Array.from(g.querySelectorAll("input[type='radio']")).slice(0, 6);
          if (!radios.length) continue;
          out.push({
            groupTag: g.tagName,
            groupId: (g.id || "").slice(0, 80),
            legend: ((g.querySelector("legend") || {}).textContent || "").replace(/\s+/g, " ").trim().slice(0, 90),
            options: radios.map((el) => {
              const id = el.id || "";
              let escOk = null, escErr = null;
              try {
                escOk = !!document.querySelector(`label[for="${CSS.escape(id)}"]`);
              } catch (e) { escErr = String(e.message || e).slice(0, 60); }
              const scan = Array.from(document.querySelectorAll("label[for]"))
                .find((n) => n.getAttribute("for") === id) || null;
              const wrap = el.closest("label");
              const dataAttr = el.getAttribute("data-test-text-selectable-option__input") || "";
              return {
                id: id.slice(-28),
                value: (el.value || "").slice(0, 12),
                viaEscape: escOk, escapeError: escErr,
                viaScan: !!scan,
                scanRaw: scan ? (scan.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40) : null,
                wrappingLabel: !!wrap,
                dataTestAttr: dataAttr.slice(0, 40),
                optionTextResult: optionText(el).slice(0, 40),
                inShadow: !!(el.getRootNode && el.getRootNode() !== document),
              };
            }),
          });
        }
        respond({ ok: true, csVersion: JARVIS_CS_VERSION, url: location.href.slice(0, 200),
                  radioGroups: out.length, detail: out });
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
      } else if (msg.action === "show_me") {
        // Only mark items this frame actually owns; other frames answer for theirs.
        const items = ((msg.params && msg.params.items) || []).filter((it) => {
          if (!it.ref) return true;                   // selector/rect items: try here
          const bare = String(it.ref).includes(":") ? String(it.ref).split(":").pop()
                                                    : String(it.ref);
          return FIELDS.has(bare);
        });
        if (!items.length) { respond({ ok: true, shown: [] }); return true; }
        const r = showMe(items);
        respond({ ok: true, shown: r.shown, url: location.href });
      } else if (msg.action === "clear_show_me") {
        clearShowMe();
        respond({ ok: true });
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
    // Markers are DOM nodes plus window listeners; a re-injection that left them
    // behind would strand rings on the page with nothing able to clear them.
    try { clearShowMe(); } catch (e) { /* nothing drawn */ }
    window.__jarvisTeardown = null;
  };
})();

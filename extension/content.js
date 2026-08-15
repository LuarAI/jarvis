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
  if (window.__jarvisContentLoaded) return;
  window.__jarvisContentLoaded = true;

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

  // shadow DOM: querySelectorAll can't cross roots (Bitwarden's traversal)
  function deepQueryAll(root, out) {
    out = out || [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let n = walker.currentNode;
    while (n) {
      if (n.matches && n.matches("input,textarea,select,[contenteditable=''],[contenteditable='true']")) out.push(n);
      const sr = n.shadowRoot ||
        (chrome.dom && chrome.dom.openOrClosedShadowRoot ? chrome.dom.openOrClosedShadowRoot(n) : null);
      if (sr) deepQueryAll(sr, out);
      n = walker.nextNode();
    }
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
    }
    return { fields, excluded_counts: excluded };
  }

  function pageText(limit) {
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
  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    try {
      if (msg.action === "read_page") {
        const scan = scanFields();
        respond({
          ok: true,
          url: location.href,
          title: document.title,
          ats: atsOf(),
          isTop: window.top === window,
          page_text: pageText(msg.params && msg.params.limit),
          fields: scan.fields,
          excluded_counts: scan.excluded_counts,
        });
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
  });
})();

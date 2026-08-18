/* Option labels must never be replaced by an internal id.
 *
 * On LinkedIn an option's `value` is an opaque UUID, and optionText() used to end
 * with `return el.value`. So any failure of the label lookup produced something that
 * LOOKED like data: four questions came back as sixteen UUIDs with nothing marking
 * them as unread. The model could not tell "here are your choices" from "we couldn't
 * read your choices", and refused to answer at all — correctly, but for a reason it
 * had to infer.
 *
 * These cases cover the label routes in order, and — most importantly — the case
 * where EVERY route fails: the option must come back empty and flagged, never as a
 * UUID wearing a label's clothes.
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const SRC = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");

const NAME = "urn:li:fsd_formElement:urn:li:jobs_applyformcommon_easyApplyFormElement:"
           + "(4455240264,35391884658,multipleChoice)";
const UUID = ["c3d079e4-aa73-4163-beea-0547fff82d95",
              "76696175-b430-4dba-a581-c421375d919f"];
const OPTS = ["8+ years", "Less than 3 years"];

// Each variant renders the SAME question with the option text reachable a different
// way — or, in the last one, not reachable at all.
const VARIANTS = {
  "label[for] (the standard association)": (t, i) =>
    `<input id="${NAME}-${i}" name="${NAME}" type="radio" value="${UUID[i]}">
     <label for="${NAME}-${i}">${t}</label>`,
  "wrapping <label>": (t, i) =>
    `<label><input name="${NAME}" type="radio" value="${UUID[i]}">${t}</label>`,
  "data-test attributes only (no usable label association)": (t, i) =>
    `<input data-test-text-selectable-option__input="${t}" id="${NAME}-${i}"
            name="${NAME}" type="radio" value="${UUID[i]}">
     <label data-test-text-selectable-option__label="${t}" for="MISMATCHED-${i}"></label>`,
  "aria-label on the input": (t, i) =>
    `<input aria-label="${t}" name="${NAME}" type="radio" value="${UUID[i]}">`,
  "plain sibling text in the option row": (t, i) =>
    `<div data-test-text-selectable-option="${i}">
       <input name="${NAME}" type="radio" value="${UUID[i]}"><span>${t}</span></div>`,
  "NOTHING readable (must not fall back to the UUID)": (t, i) =>
    `<input name="${NAME}" type="radio" value="${UUID[i]}">`,
};

function scan(render) {
  const rows = OPTS.map((t, i) => `<div>${render(t, i)}</div>`).join("");
  const html = `<body><form><fieldset>
    <legend><span class="fb-dash-form-element__label">
      <span aria-hidden="true">How many years of React experience do you have?</span>
      <span class="visually-hidden">How many years of React experience do you have?</span>
    </span><span class="visually-hidden">Required</span></legend>
    ${rows}</fieldset></form></body>`;
  const dom = new JSDOM(html, { url: "https://www.linkedin.com/jobs/" });
  const { window } = dom;
  Object.defineProperty(window.HTMLElement.prototype, "innerText", {
    get() {
      const c = this.cloneNode(true);
      c.querySelectorAll(".visually-hidden, [aria-hidden='true']").forEach((n) => n.remove());
      return c.textContent;
    },
  });
  window.HTMLElement.prototype.checkVisibility = () => true;
  window.HTMLElement.prototype.getBoundingClientRect = () =>
    ({ width: 160, height: 20, right: 160, bottom: 20, top: 0, left: 0 });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  if (!window.CSS) window.CSS = {};
  if (!window.CSS.escape) window.CSS.escape = (v) => String(v).replace(/[^\w-]/g, (m) => "\\" + m);

  const listeners = [];
  const chrome = { runtime: { onMessage: { addListener: (f) => listeners.push(f),
                                           removeListener: () => {} } }, dom: {} };
  new Function("window", "chrome", "document", "location", "NodeFilter", "CSS", "self",
               "setTimeout", "clearTimeout", "URL", "Event", "KeyboardEvent", "Promise",
               "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement",
               "requestAnimationFrame", "cancelAnimationFrame", SRC)(
    window, chrome, window.document, window.location, window.NodeFilter, window.CSS, window,
    window.setTimeout.bind(window), window.clearTimeout.bind(window), URL, window.Event,
    window.KeyboardEvent, Promise, window.HTMLInputElement, window.HTMLTextAreaElement,
    window.HTMLSelectElement, (f) => window.setTimeout(f, 0), () => {});

  let fields = [];
  listeners[0]({ action: "list_fields" }, {}, (r) => { fields = r.fields || []; });
  return fields.find((f) => f.kind === "radio");
}

let pass = true;
const chk = (n, v) => { console.log((v ? "PASS " : "FAIL ") + n); pass = pass && v; };

for (const [name, render] of Object.entries(VARIANTS)) {
  const f = scan(render);
  const texts = ((f && f.options) || []).map((o) => o.text);
  const readable = name.indexOf("NOTHING") === -1;
  console.log(`\n── ${name}`);
  console.log("   options:", JSON.stringify(texts));
  if (readable) {
    chk("   labels resolved", texts.join("|") === OPTS.join("|"));
    chk("   not flagged unreadable", !(f && f.optionsUnreadable));
  } else {
    chk("   no UUID passed off as a label",
        !texts.some((t) => /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(String(t))));
    chk("   flagged so the model refuses to guess", !!(f && f.optionsUnreadable));
  }
  chk("   the question itself still resolved",
      !!f && /How many years of React/.test(f.label || ""));
}

console.log("\nRESULT:", pass ? "OK" : "FAILED");
process.exit(pass ? 0 : 1);

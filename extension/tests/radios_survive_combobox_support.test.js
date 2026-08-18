/* Did the Strider combobox work break LinkedIn's radios?
 *
 * The user's hypothesis. Two changes from 6004f2e are candidates:
 *
 *  1. the wrapper-dedupe guard: if an element has role=combobox / aria-haspopup=
 *     listbox and CONTAINS an input, the wrapper is skipped. comboInput() grabs the
 *     first input of ANY type — including a radio — so a container carrying that
 *     ARIA anywhere around a radio group changes what gets scanned.
 *
 *  2. kindOf() now returns "combobox" BEFORE it checks type=radio, and isCombobox()
 *     accepts aria-activedescendant / aria-autocomplete / a combobox ancestor. A
 *     radio inside such an ancestor is reclassified, and the combobox branch builds
 *     its options from a listbox lookup that can fall back to a document sweep —
 *     which is precisely "all four questions returned the same list".
 *
 * Test both against a LinkedIn-shaped modal that carries the ARIA a real one does.
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const SRC = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");

const UUID = ["c3d079e4", "76696175", "a7402915", "72f309cd"];
const QS = [
  { id: "35391884658", q: "How many years of professional React development experience do you have?",
    o: ["8+ years", "5–8 years", "3–5 years", "Less than 3 years"] },
  { id: "35391884650", q: "Have you built chat-based or conversational web applications?",
    o: ["Production implementations", "Internal or proof-of-concept projects",
        "Limited experimentation", "No experience"] },
];
const fieldset = (s) => {
  const N = `urn:li:fsd_formElement:urn:li:jobs_applyformcommon_easyApplyFormElement:(4455240264,${s.id},multipleChoice)`;
  return `<div class="fb-dash-form-element" data-test-form-element="">
  <fieldset data-test-form-builder-radio-button-form-component="true">
    <legend><span class="fb-dash-form-element__label"><span aria-hidden="true">${s.q}</span><span class="visually-hidden">${s.q}</span></span><span class="visually-hidden">Required</span></legend>
    ${s.o.map((t, i) => `<div data-test-text-selectable-option="${i}">
      <input data-test-text-selectable-option__input="${t}" id="${N}-${i}" name="${N}" aria-required="true" type="radio" value="${UUID[i]}">
      <label data-test-text-selectable-option__label="${t}" for="${N}-${i}">${t}</label></div>`).join("")}
  </fieldset></div>`;
};

// Variants of the surrounding chrome. Each is something a real app plausibly does.
const VARIANTS = {
  "plain modal":
    `<div class="jobs-easy-apply-modal__content"><form>__Q__</form></div>`,
  "modal wrapped in aria-haspopup=listbox":
    `<div class="jobs-easy-apply-modal__content" aria-haspopup="listbox"><form>__Q__</form></div>`,
  "modal wrapped in role=combobox":
    `<div class="jobs-easy-apply-modal__content" role="combobox"><form>__Q__</form></div>`,
  "typeahead present elsewhere on the page":
    `<input id="srch" role="combobox" aria-autocomplete="list">
     <ul><li>Recent search one</li><li>Recent search two</li><li>Recent search three</li><li>Recent search four</li></ul>
     <div class="jobs-easy-apply-modal__content"><form>__Q__</form></div>`,
};

function run(name, shell) {
  const dom = new JSDOM(`<body>${shell.replace("__Q__", QS.map(fieldset).join(""))}</body>`,
                        { url: "https://www.linkedin.com/jobs/" });
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
    ({ width: 180, height: 20, right: 180, bottom: 20, top: 0, left: 0 });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  if (!window.CSS) window.CSS = {};
  if (!window.CSS.escape) window.CSS.escape = (v) => String(v).replace(/[^\w-]/g, (m) => "\\" + m);

  const listeners = [];
  const chrome = { runtime: { onMessage: { addListener: (f) => listeners.push(f),
                                           removeListener: () => {} } }, dom: {} };
  new Function("window", "chrome", "document", "location", "NodeFilter", "CSS", "self",
               "setTimeout", "clearTimeout", "URL", "Event", "KeyboardEvent", "MouseEvent", "Promise",
               "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement",
               "requestAnimationFrame", "cancelAnimationFrame", SRC)(
    window, chrome, window.document, window.location, window.NodeFilter, window.CSS, window,
    window.setTimeout.bind(window), window.clearTimeout.bind(window), URL, window.Event,
    window.KeyboardEvent, window.MouseEvent, Promise, window.HTMLInputElement, window.HTMLTextAreaElement,
    window.HTMLSelectElement, (f) => window.setTimeout(f, 0), () => {});

  let fields = [];
  listeners[0]({ action: "list_fields" }, {}, (r) => { fields = r.fields || []; });
  const radios = fields.filter((f) => f.kind === "radio");
  const combos = fields.filter((f) => f.kind === "combobox");
  const texts = radios.map((f) => (f.options || [])
    .map((o) => (typeof o === "string" ? o : o.text)).join(" | "));

  console.log("\n── " + name);
  console.log("   radio fields:", radios.length, " combobox fields:", combos.length);
  texts.forEach((t, i) => console.log(`   Q${i + 1}: ${t.slice(0, 76)}`));
  for (const c of combos) {
    const o = (c.options || []).map((x) => (typeof x === "string" ? x : x.text));
    if (o.length) console.log(`   [combobox ${JSON.stringify((c.label || "").slice(0, 24))}] ${JSON.stringify(o).slice(0, 76)}`);
  }
  const ok = radios.length === 2
    && texts[0] === "8+ years | 5–8 years | 3–5 years | Less than 3 years"
    && texts[1] === "Production implementations | Internal or proof-of-concept projects | Limited experimentation | No experience";
  console.log("   " + (ok ? "OK" : "*** BROKEN ***"));
  return ok;
}

let allOk = true;
for (const [name, shell] of Object.entries(VARIANTS)) {
  if (!run(name, shell)) allOk = false;
}
console.log("\nRESULT:", allOk ? "OK" : "FAILED");
process.exit(allOk ? 0 : 1);

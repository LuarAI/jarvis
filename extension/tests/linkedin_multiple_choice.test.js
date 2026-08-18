/* LinkedIn Easy Apply, FOUR multiple-choice questions, verbatim shape from the user.
 *
 * Reported: every option came back as a raw UUID instead of its visible text ("8+
 * years"), and all four questions returned the SAME four UUIDs — so Jarvis couldn't
 * tell the questions apart and refused to answer rather than guess. Refusing was
 * right; the enumeration is what's broken.
 *
 * The give-away is in the markup: every question reuses the SAME option `value`
 * UUIDs (c3d079e4… is "8+ years" in Q1 and "Production implementations" in Q3), and
 * the questions differ only by the id/name. So anything keyed on `value` collapses
 * all four together.
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const SRC = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");

const Q = [
  { id: "35391884658", q: "How many years of professional React development experience do you have?",
    opts: ["8+ years", "5–8 years", "3–5 years", "Less than 3 years"] },
  { id: "35391884666", q: "How many years of professional Python development experience do you have?",
    opts: ["8+ years", "5–8 years", "3–5 years", "Less than 3 years"] },
  { id: "35391884650", q: "Have you built chat-based or conversational web applications?",
    opts: ["Production implementations", "Internal or proof-of-concept projects",
           "Limited experimentation", "No experience"] },
  { id: "35394183402", q: "Have you integrated frontend applications with AI or LLM backends?",
    opts: ["Multiple production implementations", "Internal AI projects",
           "Limited experimentation", "No experience"] },
];
// the SHARED uuids — identical across all four questions, which is the trap
const UUID = ["c3d079e4-aa73-4163-beea-0547fff82d95",
              "76696175-b430-4dba-a581-c421375d919f",
              "a7402915-e75e-46e3-aa7f-df466b5667e9",
              "72f309cd-f203-4bf1-b211-e42e9922aff0"];

const block = (spec) => {
  const NAME = `urn:li:fsd_formElement:urn:li:jobs_applyformcommon_easyApplyFormElement:(4455240264,${spec.id},multipleChoice)`;
  const opts = spec.opts.map((t, i) => `
    <div data-test-text-selectable-option="${i}" class="display-flex">
      <input data-test-text-selectable-option__input="${t}" id="${NAME}-${i}"
             class="fb-form-element__checkbox" name="${NAME}" aria-required="true"
             type="radio" value="${UUID[i]}">
      <label data-test-text-selectable-option__label="${t}" for="${NAME}-${i}" class="t-14">
        <!---->${t}<!---->
      </label>
    </div>`).join("");
  return `
  <div class="fb-dash-form-element mt4" style="width:100%" tabindex="-1" data-test-form-element="">
    <fieldset data-test-form-builder-radio-button-form-component="true"
              id="radio-button-form-component-formElement-...-${spec.id}-multipleChoice">
      <legend>
        <span class="fb-dash-form-element__label fb-dash-form-element__label-title--is-required">
          <span aria-hidden="true"><!---->${spec.q}<!----></span><span class="visually-hidden"><!---->${spec.q}<!----></span>
        </span>
        <span class="visually-hidden">Required</span>
      </legend>${opts}
    </fieldset>
  </div>`;
};

const dom = new JSDOM(`<body><form>${Q.map(block).join("")}</form></body>`,
                      { url: "https://www.linkedin.com/jobs/" });
const { window } = dom;
Object.defineProperty(window.HTMLElement.prototype, "innerText", {
  get() {                                   // browser innerText skips hidden nodes
    const c = this.cloneNode(true);
    c.querySelectorAll(".visually-hidden, [aria-hidden='true']").forEach((n) => n.remove());
    return c.textContent;
  },
});
window.HTMLElement.prototype.checkVisibility = () => true;
window.HTMLElement.prototype.getBoundingClientRect = () =>
  ({ width: 200, height: 20, right: 200, bottom: 20, top: 0, left: 0 });
window.HTMLElement.prototype.scrollIntoView = () => {};
// jsdom has no CSS.escape; Chrome does. Provide the spec algorithm so the test
// exercises the SAME path the browser takes.
if (!window.CSS) window.CSS = {};
if (!window.CSS.escape) {
  window.CSS.escape = (v) => String(v).replace(/[^\w-￿-]/g, (m) => "\\" + m);
}

const listeners = [];
const chrome = {
  runtime: { onMessage: { addListener: (f) => listeners.push(f), removeListener: () => {} } },
  dom: {},
};
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

console.log("=== fields ===");
for (const f of fields) {
  console.log(`[${f.kind}] ${JSON.stringify((f.label || "").slice(0, 58))}`);
  for (const o of f.options || []) {
    console.log(`      value=${JSON.stringify(String(o.value).slice(0, 40))}  text=${JSON.stringify(o.text)}`);
  }
}

let pass = true;
const chk = (n, v) => { console.log((v ? "PASS " : "FAIL ") + n); pass = pass && v; };
console.log("\n=== checks ===");
chk("one field per question (4)", fields.length === 4);
const allOpts = fields.flatMap((f) => (f.options || []).map((o) => o.text));
chk("no option text is a raw UUID",
    !allOpts.some((t) => /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(String(t))));
chk("React question offers its real choices",
    !!fields[0] && (fields[0].options || []).map((o) => o.text).join("|")
      === "8+ years|5–8 years|3–5 years|Less than 3 years");
chk("Q3 has its OWN choices, not Q1's",
    !!fields[2] && (fields[2].options || []).map((o) => o.text).join("|")
      === "Production implementations|Internal or proof-of-concept projects|Limited experimentation|No experience");
chk("questions are distinguishable",
    new Set(fields.map((f) => f.label)).size === 4);

// filling by the VISIBLE text must select the right radio
const fill = (ref, value) => new Promise((res) => {
  listeners[0]({ action: "fill_fields", params: { fills: [{ ref, value }] } }, {},
               (r) => res((r.results || [])[0]));
});
(async () => {
  console.log("\n=== fill by visible text ===");
  let r = await fill(fields[0].ref, "Less than 3 years");
  console.log("  React <- 'Less than 3 years':", JSON.stringify(r));
  const NAME0 = 'urn:li:fsd_formElement:urn:li:jobs_applyformcommon_easyApplyFormElement:(4455240264,35391884658,multipleChoice)';
  const picked = Array.from(window.document.querySelectorAll(`input[name="${NAME0}"]`))
    .findIndex((n) => n.checked);
  chk("selected the 4th option (index 3)", picked === 3);
  chk("fill reported ok", !!r && r.ok === true);

  r = await fill(fields[2].ref, "Production implementations");
  console.log("  Chat apps <- 'Production implementations':", JSON.stringify(r));
  chk("Q3 selected its own first option", !!r && r.ok === true);

  console.log("\nRESULT:", pass ? "OK" : "FAILED");
  process.exit(pass ? 0 : 1);
})();

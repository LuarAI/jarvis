/* The question sits ABOVE the control, not beside the input.
 *
 * Recruiterflow (and every react-select form) renders:
 *
 *   <p class="form-label">What is your level of proficiency in English? *</p>
 *   <div class="common-input-wrapper">
 *     <div class="select__control">…<input id="react-select-5-input"></div>
 *   </div>
 *
 * The input carries no accessible name at all — not a broken lookup, genuinely
 * nothing on the element. Its own siblings are react-select's internal chrome, so a
 * sibling walk from the INPUT finds nothing; the label is a sibling of an ANCESTOR.
 * Six such fields came back UNLABELLED and could not be answered.
 *
 * Also covered: the caption is not always a <label>. It is a <p>, a <div>, or a
 * heading — so restricting the climb to label[for] misses all of them.
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const SRC = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");

/* One react-select field, verbatim in shape: caption in a <p>, control nested three
 * levels below it, input with no name/id/aria of its own. */
const select = (question, idx) => `
  <div class="input-wrapper">
    <p class="form-label">${question} <span class="required">*</span></p>
    <div class="common-input-wrapper">
      <div class="select__control">
        <div class="select__value-container">
          <div class="select__placeholder">Click to view options</div>
          <div class="select__input-container">
            <input id="react-select-${idx}-input" type="text" autocomplete="off"
                   role="combobox" aria-expanded="false" aria-autocomplete="list">
          </div>
        </div>
      </div>
    </div>
  </div>`;

// A plain input whose caption also sits above it, in a <p> rather than a <label>.
const plain = (question, ph, id) => `
  <div class="input-wrapper">
    <p class="form-label">${question} <span class="required">*</span></p>
    <div class="common-input-wrapper">
      <input type="text" id="${id}" placeholder="${ph}">
    </div>
  </div>`;

const html = `<body><form>
  ${select("What is your level of proficiency in English?", 5)}
  ${select("How would you rate your experience with Node.js in production environments?", 7)}
  ${plain("How many years of professional experience do you have working with TypeScript?",
          "Enter number here", "years")}
  ${plain("What are your monthly salary expectations in USD?", "Enter amount", "salary")}
  ${plain("If you'd like, feel free to share a brief Loom video highlighting your experience.",
          "Enter text here", "loom")}
</form></body>`;

const dom = new JSDOM(html, { url: "https://recruiterflow.com/jobs/409" });
const { window } = dom;
Object.defineProperty(window.HTMLElement.prototype, "innerText", {
  get() { return this.textContent; },
});
window.HTMLElement.prototype.checkVisibility = () => true;
window.HTMLElement.prototype.getBoundingClientRect = () =>
  ({ width: 200, height: 24, right: 200, bottom: 24, top: 0, left: 0 });
window.HTMLElement.prototype.scrollIntoView = () => {};
if (!window.CSS) window.CSS = {};
if (!window.CSS.escape) window.CSS.escape = (v) => String(v).replace(/[^\w-]/g, (m) => "\\" + m);

const listeners = [];
const chrome = { runtime: { onMessage: { addListener: (f) => listeners.push(f),
                                         removeListener() {} } }, dom: {} };
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

console.log("=== fields ===");
for (const f of fields) {
  console.log(`[${(f.kind || "").padEnd(9)}] src=${(f.labelSource || "-").padEnd(12)} `
              + JSON.stringify((f.label || "").slice(0, 62)));
}

let pass = true;
const chk = (n, v) => { console.log((v ? "PASS " : "FAIL ") + n); pass = pass && v; };
const labelled = (re) => fields.some((f) => re.test(f.label || ""));

console.log("\n=== checks ===");
chk("English proficiency question found", labelled(/level of proficiency in English/));
chk("Node.js question found", labelled(/experience with Node\.js/));
chk("TypeScript years question found", labelled(/years of professional experience/));
chk("salary question found", labelled(/monthly salary expectations/));
chk("Loom question found", labelled(/Loom video/));
chk("no field is left unlabelled",
    fields.every((f) => (f.label || "").trim().length > 0));
chk("no field falls back to its placeholder",
    !fields.some((f) => /^(Enter number here|Enter amount|Enter text here|Click to view options)$/
      .test(f.label || "")));
chk("the required marker is stripped from the question",
    !fields.some((f) => /\*/.test(f.label || "")));
chk("each question is distinct",
    new Set(fields.map((f) => f.label)).size === fields.length);

console.log("\nRESULT:", pass ? "OK" : "FAILED");
process.exit(pass ? 0 : 1);

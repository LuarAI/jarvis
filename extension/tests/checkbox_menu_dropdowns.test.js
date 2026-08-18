/* A dropdown whose menu is a list of CHECKBOXES, and which must be opened first.
 *
 * Recruiterflow's "How would you rate your experience with Node.js?" renders a
 * closed control reading "Click to view options". Nothing exists in the DOM until
 * you click it; the menu that appears is a list of <input type="checkbox"> rows
 * (No experience / Basic / Intermediate / Advanced / Expert).
 *
 * Two failures this covers:
 *
 *  1. The fill typed into the input but never CLICKED the control, so on a widget
 *     whose menu opens on click (not on keystroke) no options ever appeared and the
 *     value was reported as uncommitted.
 *  2. When an option row is a checkbox, clicking the row's text is not guaranteed to
 *     tick it — "clicked 'USD' but the field didn't record it". The tick has to be
 *     verified, and the checkbox itself clicked if the row didn't do it.
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const SRC = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");

const OPTIONS = ["No experience", "Basic", "Intermediate", "Advanced", "Expert"];

const dom = new JSDOM(`<body><form>
  <div class="input-wrapper">
    <p class="form-label">How would you rate your experience with Node.js in production environments? <span class="required">*</span></p>
    <div class="common-input-wrapper">
      <div class="select__control" id="ctl">
        <div class="select__placeholder">Click to view options</div>
        <div class="select__input-container">
          <input id="react-select-7-input" type="text" role="combobox"
                 aria-expanded="false" aria-autocomplete="list" autocomplete="off">
        </div>
      </div>
      <div id="menu-host"></div>
    </div>
  </div>
</form></body>`, { url: "https://recruiterflow.com/jobs/409" });

const { window } = dom;
Object.defineProperty(window.HTMLElement.prototype, "innerText", {
  get() { return this.textContent; },
});
window.HTMLElement.prototype.checkVisibility = () => true;
window.HTMLElement.prototype.getBoundingClientRect = () =>
  ({ width: 220, height: 24, right: 220, bottom: 24, top: 0, left: 0 });
window.HTMLElement.prototype.scrollIntoView = () => {};
if (!window.CSS) window.CSS = {};
if (!window.CSS.escape) window.CSS.escape = (v) => String(v).replace(/[^\w-]/g, (m) => "\\" + m);

/* The widget: the menu exists ONLY after the control is clicked, and each row is a
 * checkbox whose state is what the form records. Clicking the row's text label does
 * NOT tick it — only the checkbox itself does, which is the real-world failure. */
const ctl = window.document.getElementById("ctl");
const host = window.document.getElementById("menu-host");
const committed = [];
let open = false;
ctl.addEventListener("click", () => {
  if (open) return;
  open = true;
  const ul = window.document.createElement("ul");
  ul.setAttribute("role", "listbox");
  for (const t of OPTIONS) {
    const li = window.document.createElement("li");
    li.setAttribute("role", "option");
    const box = window.document.createElement("input");
    box.type = "checkbox";
    box.addEventListener("change", () => {
      if (box.checked) {
        committed.push(t);
        ctl.querySelector(".select__placeholder").textContent = t;
      }
    });
    const span = window.document.createElement("span");
    span.textContent = t;
    li.appendChild(box);
    li.appendChild(span);
    ul.appendChild(li);
  }
  host.appendChild(ul);
});

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

let pass = true;
const chk = (n, v) => { console.log((v ? "PASS " : "FAIL ") + n); pass = pass && v; };

console.log("=== field ===");
const f = fields.find((x) => x.idAttr === "react-select-7-input") || fields[0];
console.log(`[${f && f.kind}] ${JSON.stringify((f && f.label || "").slice(0, 60))}`);
chk("the question is readable", !!f && /experience with Node\.js/.test(f.label || ""));
chk("recognised as a picker, not free text", !!f && f.kind === "combobox");

const fill = (ref, value) => new Promise((res) => {
  listeners[0]({ action: "fill_fields", params: { fills: [{ ref, value }] } }, {},
               (r) => res((r.results || [])[0]));
});

(async () => {
  console.log("\n=== fill ===");
  const r = await fill(f.ref, "Advanced");
  console.log("  result:", JSON.stringify(r));
  chk("the closed menu was opened", open);
  chk("reported success", !!r && r.ok === true);
  chk("the option actually committed", committed.includes("Advanced"));
  chk("committed exactly one option", committed.length === 1);

  /* A value that isn't offered must be refused — re-scan first, because the widget
   * re-rendered on commit and the fingerprint guard would (correctly) refuse a ref
   * captured before that change. */
  let again = [];
  listeners[0]({ action: "list_fields" }, {}, (x) => { again = x.fields || []; });
  const f2 = again.find((x) => x.idAttr === "react-select-7-input") || again[0];
  const bad = await fill(f2.ref, "Wizard");
  console.log("  unmatched:", JSON.stringify(bad));
  chk("an unoffered value is refused", !!bad && bad.ok === false);
  chk("the refusal names the real options",
      !!bad && /Intermediate|Advanced|Expert/.test(String(bad.error || "")));
  chk("a refusal does not change the committed answer",
      committed.length === 1 && committed[0] === "Advanced");

  console.log("\nRESULT:", pass ? "OK" : "FAILED");
  process.exit(pass ? 0 : 1);
})();

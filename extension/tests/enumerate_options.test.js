/* Read a picker's real choices instead of guessing at them.
 *
 * A type-ahead reports optionsDynamic: true, so the schema carries no list and the
 * model was reduced to guessing wording — "Claude Code" happened to match, "Daily"
 * did not — and only ever learned the real strings from a failure message.
 *
 * Also covers two faults seen on the same form:
 *  - when the menu had not rendered, the fill swept the DOCUMENT for anything that
 *    looked like an option and offered the job ad's bullets ("📍 Location: Remote");
 *  - once a picker had a value, the label walker read that VALUE back as the
 *    question, so a field came through labelled "Intermediate".
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const SRC = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");

const OPTIONS = ["Every day (core part of my workflow)", "Several times a week",
                 "Occasionally", "Rarely", "Never"];

const dom = new JSDOM(`<body>
  <ul>
    <li>📍 Location: Remote (LATAM)</li>
    <li>🕒 Time Zone: U.S. West Coast (PST/PDT)</li>
    <li>💼 Employment Type: Full-Time</li>
  </ul>
  <form>
    <div class="input-wrapper">
      <p class="form-label">How frequently do you use AI coding tools in your daily development workflow? <span class="required">*</span></p>
      <div class="common-input-wrapper">
        <div class="select__control" id="ctl">
          <div class="select__placeholder">Click to view options</div>
          <div class="select__input-container">
            <input id="react-select-5-input" type="text" role="combobox"
                   aria-expanded="false" aria-autocomplete="list" autocomplete="off">
          </div>
        </div>
      </div>
    </div>
    <div class="input-wrapper">
      <p class="form-label">How would you rate your experience with Node.js? <span class="required">*</span></p>
      <div class="common-input-wrapper">
        <div class="select__control">
          <div class="select__single-value">Intermediate</div>
          <div class="select__input-container">
            <input id="react-select-4-input" type="text" role="combobox"
                   aria-expanded="false" aria-autocomplete="list" autocomplete="off">
          </div>
        </div>
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

/* The widget: menu exists only once the control is clicked, and it is PORTALLED to
 * <body> — outside the field's own subtree, which is why a strictly scoped lookup
 * finds nothing and a document sweep was reached for in the first place. */
const ctl = window.document.getElementById("ctl");
let open = false, menu = null;
ctl.addEventListener("click", () => {
  if (open) return;
  open = true;
  menu = window.document.createElement("div");
  menu.setAttribute("role", "listbox");
  menu.className = "select__menu-portal";
  for (const t of OPTIONS) {
    const o = window.document.createElement("div");
    o.setAttribute("role", "option");
    o.textContent = t;
    menu.appendChild(o);
  }
  window.document.body.appendChild(menu);
});
// Escape closes it, as a real widget does — the enumeration must leave it closed.
window.document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && menu) { menu.remove(); menu = null; open = false; }
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

console.log("=== labels ===");
for (const f of fields) console.log(`  ${f.idAttr}: ${JSON.stringify((f.label || "").slice(0, 58))}`);
const freq = fields.find((x) => x.idAttr === "react-select-5-input");
const node = fields.find((x) => x.idAttr === "react-select-4-input");
chk("the frequency question is readable", !!freq && /How frequently do you use AI/.test(freq.label));
chk("a picker with a VALUE still reports its QUESTION, not the value",
    !!node && /experience with Node\.js/.test(node.label || ""));
chk("the selected value is not mistaken for the label",
    !!node && !/^Intermediate$/.test(node.label || ""));

const send = (action, params) => new Promise((res) => {
  listeners[0]({ action, params }, {}, (r) => res(r));
});

(async () => {
  console.log("\n=== enumerate (read-only) ===");
  const r = await send("enumerate_options", { ref: freq.ref });
  console.log("  got:", JSON.stringify((r.options || []).map((o) => o.text)));
  chk("reported ok", !!r && r.ok === true);
  chk("returned every real option",
      (r.options || []).map((o) => o.text).join("|") === OPTIONS.join("|"));
  chk("no page text leaked in as an option",
      !(r.options || []).some((o) => /Location: Remote|Time Zone/.test(o.text)));
  chk("the menu was closed again — a read must not leave the page open", !open);
  chk("nothing was typed into the control",
      window.document.getElementById("react-select-5-input").value === "");

  console.log("\n=== fill must not offer page text ===");
  // Point the fill at a value the menu never contains, with the menu shut.
  const bad = await send("fill_fields", { fills: [{ ref: freq.ref, value: "Zzz" }] });
  const res0 = (bad.results || [])[0] || {};
  console.log("  ", JSON.stringify(res0).slice(0, 150));
  chk("a failed fill never offers the job ad's bullets",
      !/Location: Remote|Time Zone|Employment Type/.test(String(res0.error || "")));

  console.log("\nRESULT:", pass ? "OK" : "FAILED");
  process.exit(pass ? 0 : 1);
})();

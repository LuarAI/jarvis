/* "Select all that apply" — a menu that takes SEVERAL values.
 *
 * The AI-tools question on the Recruiterflow form is a checkbox menu where more than
 * one row may be ticked. Two things must hold: adding a second value must not clear
 * the first (these are not mutually exclusive), and enumeration must report what is
 * already ticked so the model can tell what it still needs to add rather than
 * re-proposing something already chosen.
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const SRC = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");

const TOOLS = ["Claude Code", "Cursor", "OpenAI Codex", "GitHub Copilot",
               "Windsurf", "ChatGPT", "Other"];

const dom = new JSDOM(`<body><form>
  <div class="input-wrapper">
    <p class="form-label">Which AI development tools have you used regularly? (Select all that apply) <span class="required">*</span></p>
    <div class="common-input-wrapper">
      <div class="select__control" id="ctl">
        <div class="select__placeholder">Click to view options</div>
        <div class="select__input-container">
          <input id="react-select-6-input" type="text" role="combobox"
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

// A MULTI-select menu: rows are checkboxes and stay ticked independently. It is
// portalled to <body> and persists once opened, as these widgets do.
const ctl = window.document.getElementById("ctl");
let menu = null;
const boxes = {};
ctl.addEventListener("click", () => {
  if (menu) return;
  menu = window.document.createElement("div");
  menu.setAttribute("role", "listbox");
  menu.className = "select__menu";
  for (const t of TOOLS) {
    const row = window.document.createElement("div");
    row.setAttribute("role", "option");
    const box = window.document.createElement("input");
    box.type = "checkbox";
    boxes[t] = box;
    const span = window.document.createElement("span");
    span.textContent = t;
    row.appendChild(box);
    row.appendChild(span);
    menu.appendChild(row);
  }
  window.document.body.appendChild(menu);
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

let pass = true;
const chk = (n, v) => { console.log((v ? "PASS " : "FAIL ") + n); pass = pass && v; };
const send = (action, params) => new Promise((res) => {
  listeners[0]({ action, params }, {}, (r) => res(r));
});
const rescan = () => new Promise((res) => {
  listeners[0]({ action: "list_fields" }, {}, (r) => res(r.fields || []));
});

(async () => {
  let fields = await rescan();
  const f = fields.find((x) => x.idAttr === "react-select-6-input");
  chk("the question is readable", !!f && /Select all that apply/.test(f.label || ""));

  console.log("\n=== first value ===");
  let r = (await send("fill_fields", { fills: [{ ref: f.ref, value: "Claude Code" }] })).results[0];
  console.log(" ", JSON.stringify(r));
  chk("Claude Code committed", !!r && r.ok === true && boxes["Claude Code"].checked);

  console.log("\n=== enumeration reports what is already ticked ===");
  fields = await rescan();
  const f2 = fields.find((x) => x.idAttr === "react-select-6-input");
  const e = await send("enumerate_options", { ref: f2.ref });
  const ticked = (e.options || []).filter((o) => o.checked).map((o) => o.text);
  console.log("  ticked:", JSON.stringify(ticked));
  chk("enumeration says Claude Code is already selected",
      ticked.length === 1 && ticked[0] === "Claude Code");
  chk("enumeration lists every choice", (e.options || []).length === TOOLS.length);

  console.log("\n=== second value must ADD, not replace ===");
  fields = await rescan();
  const f3 = fields.find((x) => x.idAttr === "react-select-6-input");
  r = (await send("fill_fields", { fills: [{ ref: f3.ref, value: "ChatGPT" }] })).results[0];
  console.log(" ", JSON.stringify(r));
  chk("ChatGPT committed", !!r && r.ok === true && boxes["ChatGPT"].checked);
  chk("Claude Code is STILL ticked — multi-select must not clear earlier answers",
      boxes["Claude Code"].checked === true);
  chk("nothing else got ticked",
      TOOLS.filter((t) => boxes[t].checked).length === 2);

  console.log("\nRESULT:", pass ? "OK" : "FAILED");
  process.exit(pass ? 0 : 1);
})();

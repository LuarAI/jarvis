/* A plain text field must be TYPED into, never matched against the page's lists.
 *
 * Reported on a Recruiterflow form: every text field failed with
 *   no option matching "Juan Pablo"
 *   (offered: 📍 Location: Remote (LATAM) | 🕒 Time Zone: … )
 * — i.e. the job description's own bullet points were being offered as if they
 * were the field's choices.
 *
 * Cause: the runtime type-ahead detection added for Strider (whose location box has
 * NO combobox markup until you type) asks visibleOptions() whether a suggestion list
 * appeared. visibleOptions() falls back to a DOCUMENT-WIDE query when it can't find a
 * scoped listbox, and its selector includes a bare `li`. This page has an
 * intl-tel-input country dropdown (~240 <li role="option">) plus <li> bullets in the
 * posting, so every text field "found options" and was hijacked into the commit path.
 *
 * The fix must keep Strider working — a real type-ahead whose list appears next to
 * the input still has to be committed — so the test covers both.
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const SRC = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");

function build(html, url) {
  const dom = new JSDOM(html, { url: url || "https://recruiterflow.com/jobs/409" });
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
  return { window, listeners };
}

// The page's own noise: a country dropdown that is ALWAYS in the DOM, and the job
// description's bullet list. Neither belongs to any text field.
const NOISE = `
  <ul class="iti__country-list" role="listbox">
    ${["Afghanistan", "Albania", "Colombia", "Chile", "Brazil"]
      .map((c) => `<li class="iti__country" role="option"><span>${c}</span></li>`).join("")}
  </ul>
  <ul>
    <li>📍 Location: Remote (LATAM)</li>
    <li>🕒 Time Zone: U.S. West Coast (PST/PDT)</li>
    <li>💼 Employment Type: Full-Time</li>
  </ul>`;

let pass = true;
const chk = (n, v) => { console.log((v ? "PASS " : "FAIL ") + n); pass = pass && v; };

const fill = (L, ref, value) => new Promise((res) => {
  L[0]({ action: "fill_fields", params: { fills: [{ ref, value }] } }, {},
       (r) => res((r.results || [])[0]));
});

(async () => {
  // ── 1. plain text fields on a page full of unrelated <li>s ────────────────
  const { window: w1, listeners: L1 } = build(`<body><form>
    ${NOISE}
    <input type="text" name="personal_info.first_name" id="first" placeholder="First name">
    <input type="email" name="personal_info.email" id="mail" placeholder="Email address">
    <input type="tel" name="personal_info.phone" id="tel" placeholder="Phone">
  </form></body>`);
  let f1 = [];
  L1[0]({ action: "list_fields" }, {}, (r) => { f1 = r.fields || []; });
  const byId = (id) => f1.find((x) => x.idAttr === id);
  console.log("=== plain text page ===");
  console.log("kinds:", JSON.stringify(f1.map((x) => `${x.idAttr}:${x.kind}`)));

  let r = await fill(L1, byId("first").ref, "Juan Pablo");
  console.log("  first name <- 'Juan Pablo':", JSON.stringify(r));
  chk("text field written, not matched against page lists", !!r && r.ok === true);
  chk("the value really landed in the input",
      w1.document.getElementById("first").value === "Juan Pablo");
  chk("no 'no option matching' error",
      !(r && /no option matching/.test(String(r.error || ""))));

  r = await fill(L1, byId("mail").ref, "someone@example.com");
  chk("email field written",
      !!r && r.ok === true && w1.document.getElementById("mail").value === "someone@example.com");

  r = await fill(L1, byId("tel").ref, "5551234567");
  chk("tel field written",
      !!r && r.ok === true && w1.document.getElementById("tel").value === "5551234567");

  // ── 2. a REAL type-ahead must still commit (the Strider case) ─────────────
  const { window: w2, listeners: L2 } = build(`<body><form>
    <label for="loc">Where do you live?</label>
    <div class="wrap"><input type="text" id="loc" name="query" placeholder="e.g. Rio"></div>
  </form></body>`, "https://app.strider.ai/signup");
  const input = w2.document.getElementById("loc");
  const wrap = input.closest(".wrap");
  const ul = w2.document.createElement("ul");
  wrap.appendChild(ul);
  input.addEventListener("input", () => {              // list appears only after typing
    ul.innerHTML = "";
    if (!input.value.trim()) return;
    for (const t of ["Chía, Colombia", "Bogotá, Colombia"]) {
      const li = w2.document.createElement("li");
      li.textContent = t;
      li.addEventListener("click", () => { input.value = t; ul.innerHTML = ""; });
      ul.appendChild(li);
    }
  });
  let f2 = [];
  L2[0]({ action: "list_fields" }, {}, (r2) => { f2 = r2.fields || []; });
  console.log("\n=== real type-ahead ===");
  r = await fill(L2, f2.find((x) => x.idAttr === "loc").ref, "Chía, Colombia");
  console.log("  location <- 'Chía, Colombia':", JSON.stringify(r));
  chk("a genuine type-ahead still commits its option", !!r && r.ok === true);
  chk("committed value is the option text", input.value === "Chía, Colombia");

  console.log("\nRESULT:", pass ? "OK" : "FAILED");
  process.exit(pass ? 0 : 1);
})();

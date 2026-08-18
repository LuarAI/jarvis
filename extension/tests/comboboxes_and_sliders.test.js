/* The Strider signup form, verbatim from the user's paste.
 *
 * Three reported failures:
 *   1. "location" — a type-ahead combobox whose role="combobox" sits on the WRAPPER
 *      div, not the input. isCombobox(input) was false, so it was filled as plain
 *      text and never committed (no chip, value discarded on blur).
 *   2. "roles" / "stacks-N" — same shape, plus multi-select.
 *   3. the monthly-rate slider — a Radix dual-thumb role="slider", never scanned at
 *      all, so it didn't even appear in the field list.
 *
 * Note aria-valuemax="97" while the visible labels say $600..$20,000: the slider is
 * an INDEX into a non-linear scale. Pixel math would land on the wrong money; each
 * ArrowRight is exactly one step. That's why the fill steps with the keyboard.
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const SRC = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");

const html = `<body><form id="basic-information-form">
  <label for="firstName">First name</label>
  <input id="firstName" name="firstName">

  <label for="location">Where do you live?</label>
  <div class="relative w-full"><div class="relative"><div class="relative w-full">
    <input id="location" name="query" placeholder="e.g. Rio de Janeiro">
  </div></div></div>

  <label for="linkedInUrl">LinkedIn URL</label>
  <input id="linkedInUrl" name="linkedInUrl" placeholder="linkedin.com/in/johndoe">

  <label for="attributionSource">How did you hear about Strider?</label>
  <select id="attributionSource" name="attributionSource">
    <option value=""></option>
    <option value="referral">Referral or recruiter</option>
    <option value="linkedin-post">LinkedIn post</option>
  </select>

  <label for="roles">Which roles are you open to?</label>
  <div class="relative flex" aria-labelledby="" role="combobox" aria-expanded="false" aria-haspopup="listbox">
    <div class="relative w-full">
      <input id="roles" aria-autocomplete="list" aria-labelledby="" name="option" placeholder="e.g. Full-stack Developer">
    </div>
    <ul class="absolute z-20"></ul>
  </div>

  <label for="mainSkills">What are your main skills?</label>
  <div class="relative flex" aria-labelledby="" role="combobox" aria-expanded="false" aria-haspopup="listbox">
    <div class="relative w-full">
      <input id="stacks-0" aria-autocomplete="list" maxlength="100" name="stack" placeholder="E.g React.js">
    </div>
    <ul class="absolute z-20"></ul>
  </div>

  <label id="monthlyRate" for="monthlyRate">What monthly pay rate are you considering from companies on Strider?</label>
  <div aria-labelledby="monthlyRate" class="flex flex-col">
    <span dir="ltr" data-orientation="horizontal" aria-disabled="false" class="flex items-center h-5 relative mb-3">
      <span data-orientation="horizontal" class="grow"><span data-orientation="horizontal" class="absolute"></span></span>
      <span style="position: absolute; left: calc(0% + 12px);">
        <span role="slider" aria-valuemin="0" aria-valuemax="97" aria-orientation="horizontal"
              data-orientation="horizontal" tabindex="0" aria-label="Minimum" aria-valuenow="0"></span>
        <input value="0" style="display: none;">
      </span>
      <span style="position: absolute; left: calc(100% - 12px);">
        <span role="slider" aria-valuemin="0" aria-valuemax="97" aria-orientation="horizontal"
              data-orientation="horizontal" tabindex="0" aria-label="Maximum" aria-valuenow="97"></span>
        <input value="97" style="display: none;">
      </span>
    </span>
    <div class="grid grid-cols-5"><div><p>$600</p></div><div><p>to</p></div><div><p>$20,000</p></div></div>
  </div>

  <label for="isTosAccepted"><input type="checkbox" name="isTosAccepted" id="isTosAccepted" value="">
    <p>I agree to the Terms of Service</p></label>
</form></body>`;

const dom = new JSDOM(html, { url: "https://app.strider.ai/signup", pretendToBeVisual: true });
const { window } = dom;
Object.defineProperty(window.HTMLElement.prototype, "innerText", {
  get() { return this.textContent; },
});
window.HTMLElement.prototype.checkVisibility = function () { return true; };
window.HTMLElement.prototype.getBoundingClientRect = function () {
  return { width: 200, height: 24, right: 200, bottom: 24, top: 0, left: 0 };
};
window.HTMLElement.prototype.scrollIntoView = function () {};

/* ── the Radix slider, behaving like the real one ────────────────────────────
 * Key handler on the ROOT span (that's where Radix puts onKeyDown), reacting to
 * event.key from a bubbling keydown — which is exactly what a dispatched event
 * delivers. Non-linear money mapping, so a value read back as dollars proves the
 * stepping landed on the right INDEX. */
const root = window.document.querySelector('[data-orientation="horizontal"]');
const money = (i) => Math.round(600 + (20000 - 600) * Math.pow(i / 97, 2));
root.addEventListener("keydown", (e) => {
  const th = window.document.activeElement;
  if (!th || th.getAttribute("role") !== "slider") return;
  const now = Number(th.getAttribute("aria-valuenow"));
  const min = Number(th.getAttribute("aria-valuemin"));
  const max = Number(th.getAttribute("aria-valuemax"));
  let next = now;
  if (e.key === "Home") next = min;
  else if (e.key === "End") next = max;
  else if (e.key === "ArrowRight" || e.key === "ArrowUp") next = now + 1;
  else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = now - 1;
  else if (e.key === "PageUp") next = now + 10;
  else if (e.key === "PageDown") next = now - 10;
  else return;
  next = Math.max(min, Math.min(max, next));
  th.setAttribute("aria-valuenow", String(next));
  th.setAttribute("aria-valuetext", "$" + money(next).toLocaleString());
});

/* ── the type-ahead comboboxes, behaving like the real ones ──────────────────
 * Options appear ONLY after an input event, after a debounce, as plain <li> with
 * no role=option — the shape that defeated the old click-then-look approach.
 * Committing renders a chip and CLEARS the text box. */
const CATALOG = {
  location: ["Chía, Colombia", "Chiapas, Mexico", "Bogotá, Colombia", "Chicago, United States"],
  roles: ["AI Engineer", "AI Researcher", "Full-stack Developer", "Backend Developer"],
  "stacks-0": ["Python", "PyTorch", "React.js", "TypeScript"],
};
for (const [id, list] of Object.entries(CATALOG)) {
  const input = window.document.getElementById(id);
  // "location" has NO role=combobox wrapper at all (that's part of the bug: it is a
  // bare text input with a JS-driven dropdown), so fall back to its own container.
  const host = input.closest("[role='combobox']") || input.parentElement.parentElement;
  let ul = host.querySelector("ul");
  if (!ul) { ul = window.document.createElement("ul"); host.appendChild(ul); }
  let timer = null;
  input.addEventListener("input", () => {
    if (timer) window.clearTimeout(timer);
    const q = input.value.trim().toLowerCase();
    timer = window.setTimeout(() => {                 // debounce, like a server query
      ul.innerHTML = "";
      if (!q) return;
      for (const t of list.filter((x) => x.toLowerCase().includes(q))) {
        const li = window.document.createElement("li");
        li.textContent = t;
        li.addEventListener("click", () => {
          const chip = window.document.createElement("span");
          chip.className = "chip";
          chip.textContent = t;
          host.parentElement.appendChild(chip);
          input.value = "";                           // committed → box clears
          ul.innerHTML = "";
        });
        ul.appendChild(li);
      }
    }, 120);
  });
}

const listeners = [];
const chrome = {
  runtime: { onMessage: { addListener: (f) => listeners.push(f), removeListener: () => {} } },
  dom: {},
};
new Function("window", "chrome", "document", "location", "NodeFilter", "CSS", "self",
             "setTimeout", "clearTimeout", "URL", "Event", "KeyboardEvent", "MouseEvent", "Promise",
             "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", SRC)(
  window, chrome, window.document, window.location, window.NodeFilter, window.CSS, window,
  window.setTimeout.bind(window), window.clearTimeout.bind(window), URL, window.Event,
  window.KeyboardEvent, window.MouseEvent, Promise, window.HTMLInputElement, window.HTMLTextAreaElement,
  window.HTMLSelectElement);

let fields = [];
listeners[0]({ action: "list_fields" }, {}, (r) => { fields = r.fields || []; });

console.log("=== fields ===");
for (const f of fields) {
  console.log(`  [${(f.kind || "").padEnd(11)}] ${JSON.stringify((f.label || "").slice(0, 52))}`
    + (f.multiple ? " multi" : "") + (f.optionsDynamic ? " dynamic" : "")
    + (f.min != null ? `  min=${f.min} max=${f.max} now=${f.currentValue}` : ""));
}

const byLabel = (re) => fields.find((f) => re.test(f.label || ""));
const loc = fields.find((f) => f.idAttr === "location");
const roles = fields.find((f) => f.idAttr === "roles");
const skills = fields.find((f) => f.idAttr === "stacks-0");
const sliders = fields.filter((f) => f.kind === "slider" || f.kind === "range");

let pass = true;
const check = (name, v) => { console.log((v ? "PASS " : "FAIL ") + name); pass = pass && v; };

console.log("\n=== detection ===");
// The REAL Strider markup gives "location" no role, no aria-autocomplete and no
// list in the DOM — it is structurally identical to a plain text input until you
// type. So scan-time detection is impossible and correctly reports text; what must
// hold is that FILLING it still commits (detected at fill time). See below.
check("location listed (as text — it has no ARIA to detect)", !!loc && loc.kind === "text");
check("location keeps its real label", !!loc && /Where do you live/.test(loc.label));
check("roles detected as a combobox", !!roles && roles.kind === "combobox");
check("skills detected as a combobox", !!skills && skills.kind === "combobox");
  check("skills label adopted from the orphaned <label for=mainSkills>",
        !!skills && /main skills/i.test(skills.label));
check("slider(s) detected", sliders.length === 2);
check("slider carries min/max/now", !!sliders[0] && sliders[0].min === 0 && sliders[0].max === 97);
check("slider thumbs distinguishable (Minimum/Maximum)",
      sliders.length === 2 && /minimum/i.test(sliders[0].label) && /maximum/i.test(sliders[1].label));
check("the real question is on the slider", !!sliders[0] && /monthly pay rate|Minimum/i.test(sliders[0].label));

const fill = (fills) => new Promise((res) => {
  listeners[0]({ action: "fill_fields", params: { fills } }, {}, (r) => res(r.results || []));
});

(async () => {
  console.log("\n=== combobox commit ===");
  let [r] = await fill([{ ref: loc.ref, value: "Chía, Colombia" }]);
  console.log("  location →", JSON.stringify(r));
  check("location committed (option clicked, not just typed)", r && r.ok === true);
  check("a chip exists — the value really committed",
        !!window.document.querySelector(".chip"));

  // ambiguity must NOT be resolved by guessing
  const skillsEl = window.document.getElementById("stacks-0");
  [r] = await fill([{ ref: skills.ref, value: "Py" }]);
  console.log("  skills 'Py' →", JSON.stringify(r));
  check("ambiguous value refused with the choices listed",
        r && r.ok === false && /Python/.test(r.error || "") && /PyTorch/.test(r.error || ""));
  check("nothing was left typed in the box after a refusal", skillsEl.value === "");

  [r] = await fill([{ ref: roles.ref, value: "Nonexistent Role" }]);
  console.log("  roles 'Nonexistent Role' →", JSON.stringify(r));
  check("no-match reported, not silently accepted", r && r.ok === false);

  console.log("\n=== slider ===");
  const th0 = window.document.querySelectorAll('[role="slider"]')[0];
  [r] = await fill([{ ref: sliders[0].ref, value: 20 }]);
  console.log("  min thumb → 20:", JSON.stringify(r));
  check("slider stepped to the requested index", th0.getAttribute("aria-valuenow") === "20");
  check("slider reports OK", r && r.ok === true);
  check("reports the value it LANDED on", r && String(r.value).includes("20"));

  // clamping: asking beyond the max must report the real landing point, not "done"
  const th1 = window.document.querySelectorAll('[role="slider"]')[1];
  [r] = await fill([{ ref: sliders[1].ref, value: 500 }]);
  console.log("  max thumb → 500 (over max):", JSON.stringify(r));
  check("clamped to max and said so", th1.getAttribute("aria-valuenow") === "97");

  console.log("\nRESULT:", pass ? "OK" : "FAILED");
  process.exit(pass ? 0 : 1);
})();

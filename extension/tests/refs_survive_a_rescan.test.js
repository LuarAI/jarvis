/* A ref must keep meaning the SAME field, even after another scan.
 *
 * Worst bug of the set: on a JazzHR form, read 1 returned 11 fields starting at the
 * cover letter (the eight personal-info fields above it were missed), the model
 * proposed against those refs, a second read returned all 19 — and the fill wrote
 * the cover letter into First Name, the email field got a LinkedIn URL, and all
 * seven writes reported OK.
 *
 * There IS a fingerprint guard meant to catch exactly this. It could not fire,
 * because scanFields() clears FIELDS and resets refSeq on every scan: the second
 * read reassigned f1..fN to different elements AND overwrote their fingerprints, so
 * the guard compared the new element against the new fingerprint and agreed.
 *
 * The fix must make a ref a durable handle on ONE element, so a stale ref either
 * still resolves to its original field or fails loudly — never silently retargets.
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const SRC = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");

/* The JazzHR shape: personal info first, then the long-form questions. The personal
 * block starts hidden, which is what made read 1 short and read 2 complete. */
const dom = new JSDOM(`<body><form>
  <div id="personal">
    <label for="fn">First Name</label><input id="fn" name="resumator-firstname-value">
    <label for="ln">Last Name</label><input id="ln" name="resumator-lastname-value">
    <label for="em">Email Address</label><input id="em" name="resumator-email-value" type="email">
    <label for="ph">Phone</label><input id="ph" name="resumator-phone-value" type="tel">
  </div>
  <label for="cl">Cover Letter</label>
  <textarea id="cl" name="resumator-coverletter-value"></textarea>
  <label for="li">LinkedIn Profile URL:</label>
  <input id="li" name="resumator-linkedin-value">
</form></body>`, { url: "https://talentwwinc.applytojob.com/apply/b1kML7fPvy" });

const { window } = dom;
Object.defineProperty(window.HTMLElement.prototype, "innerText", {
  get() { return this.textContent; },
});
window.HTMLElement.prototype.scrollIntoView = () => {};
if (!window.CSS) window.CSS = {};
if (!window.CSS.escape) window.CSS.escape = (v) => String(v).replace(/[^\w-]/g, (m) => "\\" + m);

// Hide the personal block for the FIRST scan only — the race that produced a short
// list. Everything else is visible throughout.
let personalVisible = false;
window.HTMLElement.prototype.checkVisibility = function () {
  if (this.closest && this.closest("#personal")) return personalVisible;
  return true;
};
window.HTMLElement.prototype.getBoundingClientRect = function () {
  const on = !(this.closest && this.closest("#personal")) || personalVisible;
  return on ? { width: 200, height: 24, right: 200, bottom: 24, top: 0, left: 0 }
            : { width: 0, height: 0, right: 0, bottom: 0, top: 0, left: 0 };
};

const listeners = [];
const chrome = { runtime: { onMessage: { addListener: (f) => listeners.push(f),
                                         removeListener() {} } }, dom: {} };
new Function("window", "chrome", "document", "location", "NodeFilter", "CSS", "self",
             "setTimeout", "clearTimeout", "URL", "Event", "KeyboardEvent", "MouseEvent", "Promise",
             "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement",
             "requestAnimationFrame", "cancelAnimationFrame", SRC)(
  window, chrome, window.document, window.location, window.NodeFilter, window.CSS, window,
  window.setTimeout.bind(window), window.clearTimeout.bind(window), URL, window.Event,
  window.KeyboardEvent, window.MouseEvent, Promise, window.HTMLInputElement,
  window.HTMLTextAreaElement, window.HTMLSelectElement,
  (f) => window.setTimeout(f, 0), () => {});

const scan = () => new Promise((res) => {
  listeners[0]({ action: "list_fields" }, {}, (r) => res(r.fields || []));
});
const fill = (ref, value) => new Promise((res) => {
  listeners[0]({ action: "fill_fields", params: { fills: [{ ref, value }] } }, {},
               (r) => res((r.results || [])[0]));
});

let pass = true;
const chk = (n, v) => { console.log((v ? "PASS " : "FAIL ") + n); pass = pass && v; };

(async () => {
  const first = await scan();
  console.log("=== read 1 (personal block hidden) ===");
  console.log("  ", JSON.stringify(first.map((f) => f.label)));
  const cover = first.find((f) => /Cover Letter/.test(f.label || ""));
  chk("cover letter found in read 1", !!cover);

  // the page settles; the personal fields appear; something triggers a second read
  personalVisible = true;
  const second = await scan();
  console.log("\n=== read 2 (everything visible) ===");
  console.log("  ", JSON.stringify(second.map((f) => f.label)));
  chk("read 2 sees more fields", second.length > first.length);

  // NOW fill using the ref captured in read 1 — the exact sequence that corrupted
  // the live application.
  console.log("\n=== fill with a ref from read 1 ===");
  const LETTER = "You wrote that you want people for whom AI-native development…";
  const r = await fill(cover.ref, LETTER);
  console.log("  ", JSON.stringify(r).slice(0, 130));

  const fn = window.document.getElementById("fn");
  const cl = window.document.getElementById("cl");
  chk("the cover letter did NOT land in First Name", fn.value !== LETTER);
  chk("First Name is untouched", fn.value === "");
  if (r && r.ok) {
    chk("if it reported success, it wrote the RIGHT field", cl.value === LETTER);
  } else {
    chk("otherwise it failed loudly rather than writing anywhere",
        cl.value === "" && /changed|gone|re-read/i.test(String(r.error || "")));
  }

  console.log("\nRESULT:", pass ? "OK" : "FAILED");
  process.exit(pass ? 0 : 1);
})();

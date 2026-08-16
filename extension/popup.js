/* Jarvis Bridge popup — the HARD switch.
 *
 * Off is not "the overlay politely stops asking": it closes the native messaging
 * port, so nothing can reach Jarvis from the browser at all, and no page content
 * can leave. That distinction is the whole point of having it here rather than
 * only in the overlay (which has its own, softer, per-chat collector toggle).
 */
const $ = (id) => document.getElementById(id);

function paint(state) {
  const on = !!state.enabled;
  $("enabled").checked = on;
  $("dot").className = "dot" + (on && state.connected ? " on" : "");
  if (!on) {
    $("title").textContent = "Disconnected";
    $("sub").textContent = "Jarvis cannot see your browser.";
    $("hint").innerHTML = "Nothing is sent while this is off — the connection to "
      + "Jarvis is closed, not just paused.";
  } else if (state.connected) {
    $("title").textContent = "Connected to Jarvis";
    $("sub").textContent = state.tab || "";
    $("hint").innerHTML = "Jarvis reads the tab you're viewing, when you ask. "
      + "Page collecting is controlled in Jarvis (📄).";
  } else {
    $("title").textContent = "Jarvis isn't running";
    $("sub").textContent = "Start the Jarvis overlay; this reconnects on its own.";
    $("hint").textContent = "";
  }
}

async function refresh() {
  const state = await chrome.runtime.sendMessage({ popup: "status" }).catch(() => null);
  paint(state || { enabled: true, connected: false });
}

$("enabled").addEventListener("change", async (e) => {
  const state = await chrome.runtime.sendMessage({
    popup: "setEnabled", value: e.target.checked,
  }).catch(() => null);
  paint(state || { enabled: e.target.checked, connected: false });
});

refresh();

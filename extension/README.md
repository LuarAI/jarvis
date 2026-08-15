# Jarvis Bridge (Chrome extension)

Lets Jarvis read the page you're on and fill forms **you approve, field by field**. Built for job applications (Greenhouse, Lever, Workday, LinkedIn) but works on any form.

## Why an extension?

Chrome 136+ blocks external automation (CDP/`--remote-debugging`) of your real, signed-in profile — that's a security fix, not an obstacle to route around. An extension is the sanctioned way to work *inside* your everyday profile, and it's also cheaper and more precise than screenshots: Jarvis gets the actual field labels instead of guessing from pixels.

## Setup (one time, ~2 minutes)

1. **Load the extension**
   - Open `chrome://extensions`, turn on **Developer mode** (top right)
   - **Load unpacked** → select this `extension` folder
   - Copy the **ID** Chrome shows under "Jarvis Bridge" (32 letters)
2. **Register the native host** — in a terminal:
   ```
   cd ..\host
   install.cmd <paste-the-extension-id>
   ```
3. **Restart Chrome**, make sure Jarvis is running.

## Using it

1. Open the job posting / form in Chrome.
2. Press **Ctrl+Shift+J** (or click the Jarvis toolbar icon) to **arm that tab**. The icon shows `ON`. This is the consent step: Jarvis can only touch a tab you armed.
3. In Jarvis, ask for what you want:
   - *"What does this job ask for?"* → it reads the page
   - *"Fill this application from my CV"* → it proposes values
4. Jarvis shows **every proposed field and value** with **Fill** / **Cancel**. Nothing is typed until you click Fill.
5. Review the page and **submit it yourself** — Jarvis never submits forms.

## What it can and can't touch

**Never, structurally** (enforced in code, not by asking the model nicely):

- Password fields, one-time codes, and anything that looks like a credential
- Payment fields (card number, CVV, expiry)
- Hidden and invisible fields — job forms plant these as bot traps, and filling one flags your application
- Submit / Apply / Next buttons — the fill code refuses to click any submitter, and never sends an Enter key

**Also:** page content is handed to Claude clearly labelled as untrusted. If a page contains text like "ignore your instructions and…", Claude is told to report it to you rather than obey it.

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest — permissions and entry points |
| `background.js` | Service worker: the one long-lived native-messaging port; tracks the armed tab |
| `content.js` | Runs in the page: field extraction, safety filters, and the fill routine |
| `../host/jarvis_host.py` | Native host proxy Chrome spawns; relays to the running Jarvis overlay |
| `../host/install.cmd` | Writes the host manifest + registry key |

## Troubleshooting

- **"No tab is armed"** — press Ctrl+Shift+J on the tab you want.
- **"Jarvis isn't running"** — start the overlay; the proxy finds it via `%LOCALAPPDATA%\Jarvis\ipc.json`.
- **Nothing connects** — check the extension ID in `host/com.jarvis.host.json` matches `chrome://extensions`, then restart Chrome. Host errors go to Chrome's log (`chrome://extensions` → the extension's "service worker" link → Console).
- **A field wouldn't fill** — some sites (Workday especially) use custom dropdowns; Jarvis reports which fields failed so you can finish them by hand.

# Handsfree

Browse the web without a mouse or keyboard. Handsfree is a Chrome extension that turns head movement, hand gestures and
speech into cursor movement, clicks, scrolling, typing and tab control, using an ordinary webcam and microphone.

It has three modes, and everything in the interface is organised around them:

| Mode | How you steer | How you click |
| --- | --- | --- |
| **Head mode** | Turn your head; a 9-point calibration fits the mapping to you | Rest on a target (dwell), or say "click" |
| **Hand mode** | Point or open your hand | Pinch; hold the pinch to drag; two fingers scroll |
| **Voice mode** | No cursor: every link and button gets a number | Say the number, or "click sign in" |

- **Head-controlled cursor** with a 9-point calibration (second-order polynomial fit, with a measured accuracy),
  One Euro smoothing, a dead zone and no jumps after tracking is lost.
- **Hand tracking** of both hands (21 landmarks each), with a gesture registry: pinch, point, open palm, fist, two and
  three fingers, thumbs up / down, swipes, hand raise, open-hand-to-fist, two-hand spread / squeeze.
- **Live camera view** on the Head and Hand pages and during calibration, with the landmarks drawn on top.
- **Works in new tabs**: new tabs open a Handsfree start page, and links that open a new tab are followed.
- **Deliberate clicking**: dwell (with a countdown ring), pinch tap, voice, or opt-in facial gestures. Passing over an
  element never clicks it.
- **Voice** commands, dictation into text fields, and Vimium-style numbered labels ("show numbers", "click 14").
- **Safety**: startup grace period, real pause / resume, automatic pause when tracking is lost, confirmation for
  risky-looking buttons, and three ways to stop at any moment.
- **Dashboard** with onboarding, a live tracking lab, gesture / cursor / voice settings, calibration and a benchmark.

Camera frames are processed on your computer by models packaged with the extension. See [Privacy](#privacy).

## Quick start

Requirements: Node.js 20 or newer, and Chrome or Edge 116 or newer on a desktop.

```bash
npm install
npm run build
```

`npm run build` copies the MediaPipe runtime out of `node_modules`, downloads the two landmark models once (about
11 MB, from Google's public MediaPipe model storage) into `public/models/`, type-checks, and writes the extension to
`dist/`.

### Load it into Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `dist` folder inside this project.
4. The Handsfree welcome page opens. Follow the three setup steps: pick a mode, allow the camera and microphone, and
   press **Start Handsfree**.
5. If you picked head mode, the 9-point calibration starts next. Point your nose at each dot and hold still; it takes
   about 17 seconds and then shows its measured accuracy.

With voice on (the default), Handsfree starts in **"Listening · Actions paused"**: it hears you but does nothing until
you say **"start"** (or "resume"), press **Start** in the dashboard or popup, or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>.
With voice switched off there is nothing to wait for, and it starts after the short grace period as before.

Tabs that were already open are picked up automatically when Handsfree is switched on. After rebuilding, press the
reload icon on the extension's card in `chrome://extensions`.

### Everyday use

| To do this | Do this |
| --- | --- |
| Move the cursor | Turn your head (head mode) or point with one hand (hand mode) |
| Click | Rest the cursor on a link or button until the ring completes; or pinch thumb and index and release; or say "click" |
| Click without a cursor | Say "show numbers", then "click 14" (or just the number). In voice mode the numbers are always on |
| Click something by name | Say "click sign in" or "click images". If several match, they are numbered for you to choose |
| Open a site | "open youtube" (new tab), "go to wikipedia dot org" (this tab) |
| Search | "search for train times" (this tab), "open tab and search train times" (new tab), "search this tab for train times" (the page's own search box if it has one, otherwise a web search in this tab). Only the words after the command are searched for |
| Browser | "open browser settings", "open incognito window" |
| Video | "play video", "pause video", "mute video" |
| Keep reading | "keep scrolling", then "stop scrolling" |
| See what you can say | "what can I say" |
| Scroll | Say "scroll down" / "scroll up"; or hold up two fingers and move the hand up or down |
| Drag | Pinch and hold, move, release; or say "start dragging" then "release" |
| Type (dictation) | Dictation types what you say into a text box instead of treating it as commands. Focus a field ("show fields", then its number), say "start dictation" (or just "dictation"), speak, then say "stop dictation". "undo that" removes the last phrase. For one short phrase, "type hello world" does it without entering dictation |
| Email addresses | A spoken address is written as one lower-case word wherever it is searched or typed: "Arnav 14 Ghagare@gmail.com" or "arnav fourteen ghagare at gmail dot com" becomes `arnav14ghagare@gmail.com` |
| Go back, tabs | "go back", "go forward", "open new tab", "close tab" (asks to confirm). Next / previous: "switch tabs", "next tab", "change tab", "previous tab". By position: "go to tab 2", "tab 2", "open tab 2", "first tab", "switch to the second tab" |
| Pause at once | Say "pause" or "stop", raise an open hand for a second, or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>. The microphone stays on so "start" still works; nothing is clicked, scrolled, typed or opened |
| Start / resume | Say "start" or "resume", raise an open hand again, or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> |
| Microphone off | Say "stop listening", press **Stop listening**, or <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd>. It cannot be turned back on by voice |
| Turn off | "turn off handsfree" then "confirm", the toolbar popup, or <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd> |

The full command list is on the dashboard's **Voice** page; every gesture and its mapping is on the **Gestures** page.

## Commands

| Command | What it does |
| --- | --- |
| `npm run build` | Fetch assets if missing, type-check, build `dist/` |
| `npm run dev` | Rebuild `dist/` on every change (reload the extension in Chrome afterwards) |
| `npm test` | Unit and integration tests (Vitest) |
| `npm run typecheck` | TypeScript only |
| `npm run test:e2e` | Loads `dist/` in Chromium with a fake camera and exercises the real pipeline (see below) |
| `npm run setup` | Only copy the WASM runtime and download the models |

## How it is built

```
 web page                         extension pages                       service worker
┌──────────────────┐   port     ┌────────────────────────────┐  runtime  ┌──────────────────────┐
│ content.js       │◄──────────►│ offscreen.html  (engine)   │◄─────────►│ service-worker.js    │
│  page agent:     │ hf-agent   │  camera → MediaPipe Face + │  messages │  offscreen lifecycle │
│  cursor, dwell,  │            │  Hand Landmarker → core    │           │  tabs, zoom, back    │
│  clicks, hints,  │            │  speech recognition        │           │  settings storage    │
│  text entry, HUD │            └────────────▲───────────────┘           └──────────────────────┘
└──────────────────┘                         │ port hf-status
                                ┌────────────┴───────────────┐
                                │ dashboard.html / popup.html│
                                └────────────────────────────┘
```

- **Engine** (`src/engine`, runs in an offscreen document): owns the camera, the two MediaPipe models and speech
  recognition for as long as Handsfree is on. Closing the document releases the camera and microphone. Frames are read
  with `MediaStreamTrackProcessor`, which keeps working in a document that is never visible.
- **Core** (`src/core`): everything that decides what happens, with no browser APIs, so it is driven by mocked landmarks
  and transcripts in tests. Gesture recognition, head pose, cursor mapping, calibration, dwell, safety, voice parsing and
  dictation live here. `HandsfreeCore.execute()` is the single path by which any input causes any action.
- **Page agent** (`src/agent`, injected as `content.js`, also imported by the dashboard): draws the overlay in a closed
  shadow root, performs synthetic pointer and keyboard input, numbered labels and text insertion. It never sees camera or
  audio data.
- **Service worker** (`src/background`): privileged browser APIs only. It keeps no state in memory; "is Handsfree on?" is
  whether the offscreen document exists.
- **Dashboard** (`src/dashboard`, React): onboarding, a page per mode (Head, Hand, Voice), playground and settings.
- **New tab page** (`src/newtab`): replaces Chrome's new tab page, which no extension can control, with one that
  Handsfree can.

Offscreen documents can only use `chrome.runtime`, so the engine reads and writes settings through the service worker.

### Design decisions worth knowing

- **Mirror view everywhere.** The camera image is not mirrored, so the vision layer flips x and swaps the model's
  handedness label once, at the boundary. Everything after that works as if you were looking in a mirror.
- **Head pose** comes from the face transformation matrix. A landmark-based estimate with known sign conventions runs
  alongside it and corrects the matrix-derived sign if the two consistently disagree.
- **Calibration is a fitted model, not a guess.** Nine targets in a 3 x 3 grid are fitted with a second-order polynomial
  (the standard approach in gaze and pointer calibration), which captures cross-coupling between the axes and the
  non-linear response near the extremes. The reported accuracy is the leave-one-out error: each dot is predicted by a
  fit that never saw it. The mapping is built from measured readings, not from an assumed direction.
- **Links that open a new tab are opened by the browser.** A synthetic click on a `target="_blank"` link counts as a
  pop-up and is blocked, so after the page's own handlers have run, the service worker opens the URL (http and https only).
- **No fusion by averaging.** Head and hand never blend. One source drives the cursor at a time; switching sources, or
  getting tracking back, holds the cursor for a settling period and then glides at a bounded speed.
- **The grace period starts after the first processed frame**, so the neutral head position is never taken from a model
  that is still warming up.
- **A pinch clicks on release**, and the cursor is frozen from the moment the pointing pose ends, so the click lands
  where you aimed. A long pinch becomes a drag instead.
- **Risk detection is a heuristic** over a button's own text and attributes. It asks for confirmation on things like
  "Delete", "Buy now" or a submit button in a form with a password field. It cannot recognise every dangerous control.

## Testing

### Automated

```bash
npm test
```

463 tests. Pure logic is tested directly; DOM behaviour uses jsdom with declared element boxes; the whole core is driven
end to end with synthetic landmarks and transcripts (`tests/integration/core.test.ts`).

Covered: finger extension, pinch, every pose on both hands, activation / release / debounce / cooldown, conflicting pose
priority, swipes and their lock-out, two-hand gestures, facial gesture timing (natural blinks ignored), head pose signs,
axis mapping, smoothing, dead zone, sensitivity, glide after tracking recovery, the polynomial fit and 9-point
calibration (accuracy on and between the dots, moving head, gaps, timeout, too-small range), site names and spoken
addresses, click-by-name matching, voice-mode numbering, dwell (fire, cancel on move / tracking loss / request, no repeat), safety transitions, voice
parsing (exact, fuzzy, ambiguous, low confidence, wake word), dictation state and duplicate suppression, numbered label
discovery and stable numbering, text insertion (including framework-controlled fields) and undo, click confirmation,
pause / resume, shutdown clean-up, message and settings validation.

### In a real browser

```bash
npm run build
npm run test:e2e            # all three scenarios
node tests/e2e/run.mjs face # one scenario: blank | face | hand
```

This loads the built extension into Playwright's Chromium with Chromium's fake camera device:

- `blank`: the default synthetic test pattern. Checks onboarding, model loading, frame processing, overlay injection,
  that no face or hand is invented, automatic pause after tracking loss, refusal to click while suspended, and clean
  shutdown.
- `face`: a portrait photograph from MediaPipe's public test assets is fed through the fake camera, so the real model
  runs on a real face. Checks detection, the calibration screen (nine targets plus camera view, and that it refuses a
  head that never moves), a centred steady cursor, a single dwell click, numbered labels, click by name, a
  `target="_blank"` link opening and being followed into its new tab, the controllable new tab page, typing,
  continuous scrolling, pause, voice mode (camera released, numbers shown automatically), every dashboard page and the popup.
- `hand`: a photograph containing two hands, in hand mode. Checks that both are detected, that the hand drives the
  cursor, and that the reach box can be centred on the hand.

The photographs are downloaded on first run into `tests/e2e/.fixtures/` (git-ignored). Screenshots are written to
`tests/e2e/.fixtures/screenshots/`.

A still image cannot show that tracking follows *movement*, and the test injects actions rather than speaking, so head
movement, gestures in motion and real speech are covered by the manual checklist: [docs/MANUAL_TESTING.md](docs/MANUAL_TESTING.md).

## Privacy

- Camera frames are analysed in memory by models shipped inside the extension. No frame, image or landmark is stored or
  sent anywhere, and no model code is fetched at runtime.
- The Lab preview is a live view only.
- Lighting is judged from the average brightness of a 32 x 24 thumbnail that is discarded immediately.
- The microphone level meter measures loudness only.
- **Voice uses Chrome's Web Speech API. While listening, Chrome sends microphone audio to Google's speech service.** It
  needs an internet connection and does not work offline. This is stated during setup and on the Voice page. Turn voice
  off to stop microphone use entirely. No offline recogniser is included.
- Settings and calibration are stored locally with `chrome.storage.local`.
- The camera and microphone are opened only while Handsfree is on, and both the on-page status bar and the dashboard
  show when they are in use.

### Permissions

| Permission | Why |
| --- | --- |
| `offscreen` | Run camera tracking and speech recognition while no extension page is visible |
| `storage` | Save settings and calibration locally |
| `scripting` | Add the page agent to tabs that were already open when Handsfree was switched on |
| `<all_urls>` host access | The cursor has to work on whatever site you browse |

## Known limitations

- **Synthetic input.** Clicks and key presses made by an extension are not "trusted" browser events. Links, buttons,
  form controls and most script-driven widgets respond normally. Things that demand a real user gesture do not: file
  pickers, native `<select>` popups (Handsfree shows its own option list instead), fullscreen, some pop-up windows and
  some video players. CSS `:hover` styles are not triggered, so Handsfree outlines the element under the cursor itself.
- **New tab page.** Handsfree replaces Chrome's new tab page with its own start page, because the built-in one cannot
  be controlled. Chrome may ask once whether you want to keep it. To get Chrome's page back, remove the
  `chrome_url_overrides` block from `public/manifest.json` and rebuild.
- **Protected pages.** `chrome://` pages, the Chrome Web Store, other extensions' pages and the
  browser's own toolbar cannot be controlled by any extension. Voice tab commands ("go back", "open new tab", "switch
  tab") still work there. Local `file://` pages need "Allow access to file URLs" enabled for the extension.
- **Frames.** The cursor works in the top page and in same-origin iframes. Content inside cross-origin iframes (some
  embedded widgets and editors) cannot be clicked or typed into.
- **"Play video"** can be refused by the browser when a page has not been interacted with yet (autoplay rules);
  Handsfree says so when that happens. "Pause" and "mute" always work.
- **Calibration accuracy was measured on synthetic head models**, not on people. The method is standard, but the
  number you see after your own calibration is the one that matters.
- **"Start" has to be heard.** With voice on, nothing happens until "start" is recognised or Start is pressed. In a
  noisy room use the Start button or <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>. If the microphone is blocked or
  missing in head or hand mode, Handsfree starts without waiting; in voice mode it stays paused and shows the error.
- **Recognition restarts.** Chrome ends a recognition session by itself after about eight seconds of silence.
  Handsfree starts the next one in the same instant (and, after a real error, with a growing delay), so listening
  carries on through any length of silence. A word spoken in the very moment of a restart can still be clipped.
- **Other people talking.** Chrome joins everything it hears into one phrase, so a command spoken over chatter comes
  back with extra words and is not matched. In a noisy room use the wake word mode (Voice page), which only acts on
  phrases that begin with the wake word.
- **Incognito.** "open incognito window" opens one, but Handsfree only works inside it after you enable **Allow in
  Incognito** for Handsfree on `chrome://extensions`. If incognito is disabled by policy, Chrome refuses and
  Handsfree says so.
- **Browser settings** open on request, but `chrome://settings` is a protected page: the cursor and numbers do not work on it.
- **"Search this tab"** uses the page's own search box when it finds one (an input of type search, or named `q`,
  `search` or `query`). Sites with unusual search widgets fall back to a web search in the same tab.
- **Hand tracking checks are automated only on synthetic landmarks and one still photograph.** Pinch reliability,
  left / right labelling and reach calibration with a moving hand need the live checks in `docs/MANUAL_TESTING.md`.
- **Voice** depends on Chrome's online speech service, its accuracy and its language support. Commands are English.
  Background noise is measured and raises the confidence required, but nothing removes noise.
- **Wake-word mode** filters transcripts by a spoken prefix; the recogniser still runs. It is not a low-power wake-word
  engine.
- **Single RGB camera.** Depth is not measured. "Toward the camera" is inferred from apparent hand size and is marked as
  less reliable; that gesture is off by default. Wrist rotation is reported in the Lab but not used as a gesture.
- **No eye-gaze tracking.** The cursor follows the head, not the eyes.
- **Facial gestures** conflict with speaking ("mouth open" will fire while you talk) and are off by default.
- **Thresholds are defaults, not personal tuning.** Gesture thresholds were chosen from hand geometry and verified with
  synthetic landmarks and still photographs. Expect to adjust sensitivity, dwell time and a few gesture thresholds on
  the Gestures and Cursor pages for your own hands, camera and lighting.
- **Left / right hand labels** depend on the model's handedness output and should be checked once with a live camera
  (see the manual checklist).

## Licences

Handsfree is MIT licensed (see `LICENSE`). It uses:

- [MediaPipe Tasks Vision](https://www.npmjs.com/package/@mediapipe/tasks-vision) and the Face Landmarker and Hand
  Landmarker models, Apache-2.0, Google.
- React and React DOM, MIT.
- The One Euro Filter is implemented here from the published algorithm (Casiez, Roussel and Vogel, CHI 2012).

The reference projects listed in the hackathon material (Tracky Mouse, CursorViaCam, Handsfree.js, Project Gameface,
Vimium and others) were used as background reading only. No code was copied from them.

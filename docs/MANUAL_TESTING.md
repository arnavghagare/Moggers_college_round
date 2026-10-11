# Manual test checklist

Automated tests cover the logic, and the browser test covers the pipeline with still photographs. The items below need
a person, a live webcam and a microphone. Tick each one and note what you saw; "works with adjustment" is a useful
result, so write down the setting you changed.

Setup: `npm run build`, load `dist/` in `chrome://extensions`, finish onboarding. Keep the dashboard's **Head mode** or
**Hand mode** page open in one window for the first sections: both show your camera with the tracking drawn on top.

## 0. First things to verify with a live camera

These depend on conventions that still images cannot confirm.

- [ ] Turn your head to your **right**: the cursor moves **right**. Look **up**: the cursor moves **up**.
      If either is reversed, use "Invert left / right" or "Invert up / down" on the Cursor page, and please report it.
- [ ] Hold up your **right** hand: the Hand mode page labels its box "RIGHT". Same for the left.
- [ ] The landmark dots sit on your face and fingers, and move with them without visible lag.
- [ ] The camera view behaves like a mirror.
- [ ] In head mode the pink arrow from your nose points the way you are facing.

## 1. Lighting

- [ ] **Good lighting** (light in front of you): Face tracking reads "Good", frame rate is steady, the cursor holds
      still when you hold still.
- [ ] **Low lighting** (dim the room): the Lighting alert appears with advice; tracking quality drops to Fair or Poor
      rather than the cursor behaving wildly. Dwell clicking becomes harder or stops; it must not misfire.
- [ ] **Backlight** (window behind you): an overexposure or dim warning appears, or tracking degrades visibly.
- [ ] Cover the lens: "Face not detected" within a second, cursor frozen, Handsfree pauses after about 5 seconds.

## 2. Face and posture

- [ ] **Face partly outside the frame**: tracking is lost cleanly (cursor holds, no jump). Coming back in, the cursor
      waits briefly and then glides to its new position.
- [ ] **Lean back / forward / shift sideways**: the cursor stays usable; say "recenter" and it returns to the middle.
- [ ] Sit off-centre for a minute: the "resting position seems to have moved" notice appears (drift = suggest).
- [ ] Run the **9-point calibration** on the Head mode page. You see yourself in the middle; each of the nine dots
      fills its ring only while you hold still; it finishes in under 30 seconds and shows an accuracy figure.
- [ ] Afterwards, pointing your nose at each corner puts the cursor in that corner. Note the accuracy shown.
- [ ] Calibrate twice and compare the two accuracy figures: they should be similar.
- [ ] During calibration, look away or move continuously on one step: it waits, then times out with a clear message
      and the old calibration is kept.
- [ ] Glasses, hat, or a second person walking behind you: note any effect.

## 3. Cursor feel

- [ ] Sensitivity, smoothing, dead zone and acceleration on the Cursor page each change the cursor's behaviour
      immediately (use the practice targets on that page).
- [ ] With the default settings you can rest the cursor on a normal-sized link.
- [ ] Switch "Pointer behaviour" to mouse-like and back.
- [ ] Switch "Driven by" to nose position and back.

## 4. Hands

- [ ] **One hand visible**: open palm, point, fist, two fingers, three fingers, thumbs up, thumbs down are each named
      in the Lab while held, and the fingers display matches your hand.
- [ ] **Pinch**: tap (touch and release) clicks once. Holding longer starts a drag; releasing drops.
- [ ] **Two hands visible**: both are tracked and labelled; moving them apart / together zooms in / out.
- [ ] **Fast movement**: swipe left / right with an open hand goes back / forward (head mode). Slow movements do not.
- [ ] **Hand raise** (open hand high for about a second) pauses; again resumes.
- [ ] Rest a hand on your chin or scratch your face: nothing is triggered. Note anything that is.
- [ ] Hand mode ("use hand control"): pointing moves the cursor, a fist freezes it, lowering the hand out of view
      leaves the cursor where it was, and bringing it back does not make the cursor jump.
- [ ] Hand at the very edge of the frame: tracking drops out without a false gesture.
- [ ] **Reach calibration** (Hand page, "Calibrate my reach"): holding the hand still for about a second succeeds and
      the dashed box moves to the hand; the cursor glides, it does not jump. Waving the hand, hiding it, or holding it
      half out of the picture fails with advice that matches what you did. Cancel changes nothing. "Reset to default" works.
- [ ] **Poor lighting**: calibration fails with a lighting message rather than saving a bad position.
- [ ] Bring a hand into view already pinched, or sweep a loosely closed hand across the picture: no click.
- [ ] Hold a pinch and watch the "Right now" panel: the Left / Right label does not flicker, and the pinch is not dropped.
- [ ] Say "pause" while pinching to drag: the drag is released and nothing is dropped on the page.

## 5. Clicking safety

- [ ] Moving the cursor across links and buttons clicks nothing.
- [ ] **Dwell**: the ring fills and clicks. Moving away before it completes cancels it. Staying on the button does
      not click it a second time.
- [ ] **Tracking loss during a click**: start a dwell, then cover the camera before the ring completes. No click.
- [ ] **Recovery after tracking loss**: uncover the camera. The cursor does not jump, and nothing can be clicked until
      the grace period has passed.
- [ ] Dwell on a button labelled Delete / Buy / Submit: a confirmation appears. "cancel" or thumbs down dismisses it;
      "confirm" or thumbs up proceeds; ignoring it for 10 seconds dismisses it.
- [ ] Say "cancel click" during a dwell countdown: it stops.
- [ ] For the first 3 seconds after switching on or resuming, the cursor moves but nothing can be activated.

## 6. Pause and exit

- [ ] Switch Handsfree on with voice enabled: the banner and dashboard say "Listening · Actions paused". Say "open
      youtube", "click", "scroll down": each is shown as heard, and nothing happens.
- [ ] Say "start": after the grace period the dashboard says "Voice active · Browsing enabled" and "scroll down" works.
- [ ] Say words that only sound like it ("star", "smart", "started") while paused: browsing stays paused.
- [ ] "pause" (and "stop") pauses instantly. While paused: head movement, pinches, dwell and "click" do nothing; the
      banner says so; the microphone indicator stays on.
- [ ] Say "open youtube" while paused, then "resume": YouTube does **not** open after resuming.
- [ ] "resume" or "start" continues after the grace period.
- [ ] Pause and resume quickly several times in a row: the microphone indicator never doubles up or goes dead.
- [ ] <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> pauses and resumes from any tab.
- [ ] "turn off handsfree" then "confirm": the overlay disappears from pages and the camera light goes off.
- [ ] Turning off from the popup or dashboard does the same.

## 7. Voice

- [ ] The Voice page shows "Listening" and the level meter moves when you speak. Heard / Understood as / Value /
      Result update for every phrase.
- [ ] Stay silent for two minutes, then say "scroll down": it still works (recognition restarted by itself).
- [ ] "Open tab and search" followed by an email address: a new tab opens with only the address in the search box.
- [ ] "Search for accessibility tools": the current tab shows the results. "Search this tab for cats" on YouTube uses
      YouTube's own search box.
- [ ] "open browser settings" opens chrome://settings and Handsfree says it cannot control that page.
- [ ] "open incognito window": a window opens and Handsfree explains the "Allow in Incognito" setting. After enabling
      it on chrome://extensions, the cursor works in the incognito window.
- [ ] Start dictation, say "open youtube": the words are typed, nothing opens. Say "pause" while dictating: dictation
      ends and later speech is not typed.
- [ ] "scroll down", "scroll up", "scroll to top", "scroll to bottom", "go back", "go forward", "reload page".
- [ ] "open new tab", "switch tab", "switch to tab 2", "close tab" (asks first).
- [ ] "show numbers" then "click 7" (and a bare "7"). "show links", "show buttons", "show fields". "hide numbers".
- [ ] Say something that is not a command: nothing happens, and the HUD says it was not a command.
- [ ] **Background noise** (music or a video playing): the "room is noisy" notice appears; commands still need to be
      clear; note any command that fired by mistake.
- [ ] Wake-word mode: commands only work after the wake word.
- [ ] Push-to-talk mode: nothing is heard until <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd>; listening stops by itself
      after about 8 seconds.
- [ ] "stop listening": the microphone indicator goes off. <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd> brings it back.
- [ ] **Missing microphone** (unplug or disable it, then switch Handsfree on): a clear microphone error with advice;
      head and hand control still work.
- [ ] Disconnect from the internet: voice reports that it needs a connection; tracking continues.

## 8. Text entry

- [ ] Focus a text field with "show fields" + its number. "start dictation", speak two sentences, "stop dictation".
      The text appears once, with existing text preserved.
- [ ] "comma", "full stop", "question mark", "new line" produce punctuation.
- [ ] "undo that" removes the last phrase only.
- [ ] While dictating, "scroll down" is typed, not executed. After "stop dictation" it scrolls.
- [ ] "type hello world" inserts once without entering dictation mode.
- [ ] "start dictation" with no field focused: a message explains what to do.
- [ ] Try a search box, a `<textarea>`, a rich text editor (for example a webmail compose box) and a React form.
      Note which accept dictated text.
- [ ] "press enter" submits a search box. "press tab" moves to the next field.

## 8b. Things people ask for

- [ ] "open youtube" opens it in a new tab; "go to wikipedia dot org" loads it in the current tab.
- [ ] "open" followed by something that is not a site searches for it instead.
- [ ] "click" plus the visible name of a link or button clicks it. With several matches, only those get numbers.
- [ ] On a page with a video: "pause video", "play video", "mute video", "unmute video".
- [ ] "keep scrolling" scrolls slowly; "stop scrolling" or "stop" ends it.
- [ ] "what can I say" shows the cheat sheet; "hide help" closes it.
- [ ] "next field" and "previous field" move between form fields.

## 8c. The three modes

- [ ] **Head mode**: only your head moves the cursor; hands are ignored unless "Hand gestures too" is on.
- [ ] **Hand mode**: the dashed "YOUR SCREEN" box on the Hand page maps to the screen. "Centre the box on my hand"
      moves it to where your hand is. Pinch clicks.
- [ ] **Voice mode**: the camera light goes off. Numbers appear on every page by themselves, and come back after each
      click. "hide numbers" removes them until "show numbers".
- [ ] Switch between all three by voice: "use head control", "use hand control", "use voice mode".

## 9. Browser behaviour

- [ ] **New tab**: say "open new tab". The Handsfree start page opens and the cursor (or numbers) work on it.
      Typing a site name in its box and saying "press enter" goes there.
- [ ] Click a link that opens in a new tab: the new tab opens and Handsfree works in it straight away.

- [ ] **Denied camera permission** (block the camera for the extension, switch Handsfree on): a clear error with
      recovery steps on the dashboard and in the popup; no endless spinner.
- [ ] **Browser tab changes**: switch tabs. The cursor appears in the new tab and disappears from the old one.
      Numbered labels and any drag in the old tab are cleared.
- [ ] Open `chrome://settings` or the new tab page: the dashboard and popup say the page cannot be controlled and why;
      "go back" and "switch tab" still work by voice.
- [ ] **Scrolling**: voice scroll works on a long article, inside a scrollable panel under the cursor, and with the
      two-finger gesture. No click happens while scrolling.
- [ ] A native `<select>`: clicking it opens Handsfree's own option list; choosing an option changes the value.
- [ ] A range slider: clicking along it and dragging change its value.
- [ ] Leave Handsfree running for 15 minutes with the tab in the background: it is still responsive, and memory in
      Chrome's task manager is not climbing steadily.
- [ ] Reload the extension while a page is open: the old overlay disappears and the page keeps working.

## 10. Benchmark

- [ ] Run all six tasks on the Benchmark page with Handsfree. Each completes, counts look right, and CSV and JSON
      export produce files containing the same numbers as the table.
- [ ] Optionally run it once with a mouse for your own baseline (task 6 needs Handsfree; skip it).

## Reporting

For anything that fails, note: Chrome version, camera model and resolution, lighting, control mode, the relevant
settings, and what the Lab showed (pose, candidate gesture, confidence) at the moment it went wrong.

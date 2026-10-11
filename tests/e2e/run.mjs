// End-to-end check of the built extension in Chromium.
//
// What this does and does not prove:
// - It loads dist/ as a real extension, with Chromium's fake camera device.
// - Scenario "blank" uses the default synthetic test pattern (no face in it).
// - Scenarios "face" and "hand" feed a still photograph through the fake
//   camera, so the real MediaPipe models run on a real image of a face / hand.
// - A still image cannot show that tracking follows movement, and the test
//   injects actions instead of speaking, so head movement, gestures in motion
//   and real speech still need the manual checklist.
//
// Usage: node tests/e2e/run.mjs [blank] [face] [hand]
import { realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const dist = join(root, 'dist');
const fixtures = join(here, '.fixtures');
const shots = join(here, '.fixtures', 'screenshots');

const IMAGES = {
  face: 'https://storage.googleapis.com/mediapipe-assets/portrait.jpg',
  hand: 'https://storage.googleapis.com/mediapipe-tasks/hand_landmarker/woman_hands.jpg',
};

const results = [];
function check(scenario, name, pass, detail = '') {
  results.push({ scenario, name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  [${scenario}] ${name}${detail ? `  (${detail})` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, intervalMs = 250) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  return last;
}

async function exists(path) {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

/** Download a test photo and re-encode it as a 640x480 JPEG, which Chromium accepts as a one-frame MJPEG "video". */
async function prepareImage(kind) {
  const target = join(fixtures, `${kind}.mjpeg`);
  if (await exists(target)) return target;
  await mkdir(fixtures, { recursive: true });
  const res = await fetch(IMAGES[kind]);
  if (!res.ok) throw new Error(`Could not download ${IMAGES[kind]}: HTTP ${res.status}`);
  const source = Buffer.from(await res.arrayBuffer());

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const dataUrl = await page.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/jpeg;base64,${b64}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 480;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#808080';
      ctx.fillRect(0, 0, 640, 480);
      const scale = Math.min(640 / img.width, 480 / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      ctx.drawImage(img, (640 - w) / 2, (480 - h) / 2, w, h);
      return canvas.toDataURL('image/jpeg', 0.92);
    }, source.toString('base64'));
    await writeFile(target, Buffer.from(dataUrl.split(',')[1], 'base64'));
  } finally {
    await browser.close();
  }
  return target;
}

function serve() {
  return new Promise((resolve) => {
    const server = createServer(async (_req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(await readFile(join(here, 'fixtures', 'page.html')));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }));
  });
}

/** Read one engine status through the same port the dashboard uses. */
function readStatus(dashboard) {
  return dashboard.evaluate(
    () =>
      new Promise((resolve) => {
        let port;
        const timer = setTimeout(() => {
          try {
            port?.disconnect();
          } catch {}
          resolve(null);
        }, 1500);
        try {
          port = chrome.runtime.connect({ name: 'hf-status' });
          port.onMessage.addListener((msg) => {
            if (msg.t !== 'status') return;
            clearTimeout(timer);
            port.disconnect();
            resolve(msg.status);
          });
          port.onDisconnect.addListener(() => void chrome.runtime.lastError);
        } catch {
          clearTimeout(timer);
          resolve(null);
        }
      }),
  );
}

/** Run an engine action exactly as a dashboard button would. */
function act(dashboard, action, params) {
  return dashboard.evaluate(
    ([a, p]) =>
      new Promise((resolve) => {
        const port = chrome.runtime.connect({ name: 'hf-status' });
        port.postMessage({ t: 'action', action: a, params: p });
        setTimeout(() => {
          port.disconnect();
          resolve(true);
        }, 250);
      }),
    [action, params ?? null],
  );
}

/** Change settings the way the dashboard does: through extension storage. */
function patchSettings(worker, patch) {
  return worker.evaluate(async (p) => {
    const merge = (a, b) => {
      if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return b;
      const out = { ...a };
      for (const k of Object.keys(b)) out[k] = merge(a[k], b[k]);
      return out;
    };
    const stored = (await chrome.storage.local.get('hf:settings'))['hf:settings'] ?? {};
    await chrome.storage.local.set({ 'hf:settings': merge(stored, p) });
  }, patch);
}

async function launch(scenario, videoFile) {
  const profile = join(tmpdir(), `handsfree-e2e-${scenario}-${Date.now()}`);
  const args = [
    `--disable-extensions-except=${dist}`,
    `--load-extension=${dist}`,
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
  ];
  if (videoFile) args.push(`--use-file-for-fake-video-capture=${videoFile}`);
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    // Resolve the real location of the browser. When Node runs inside a
    // packaged (MSIX) app, %LOCALAPPDATA% is redirected and Windows cannot
    // load Chromium's side-by-side manifest through the redirected path.
    executablePath: realpathSync.native(chromium.executablePath()),
    headless: true,
    viewport: { width: 1280, height: 800 },
    args,
  });
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(worker.url()).host;
  return { context, worker, extensionId, profile };
}

async function onboard(scenario, context, extensionId, modeName) {
  // Installing the extension opens the welcome page by itself.
  const dashboard = await waitFor(
    async () => context.pages().find((p) => p.url().startsWith(`chrome-extension://${extensionId}/dashboard.html`)),
    8000,
  );
  check(scenario, 'welcome page opens on install', Boolean(dashboard), dashboard?.url() ?? 'no dashboard tab');
  const page = dashboard ?? (await context.newPage());
  if (!dashboard) await page.goto(`chrome-extension://${extensionId}/dashboard.html`);
  await page.bringToFront();
  page.setDefaultTimeout(8000);

  try {
    await page.screenshot({ path: join(shots, `${scenario}-welcome-1.png`) });
    await page.getByRole('button', { name: "Let's go" }).click();
    const pick = page.getByRole('button', { name: `Pick ${modeName}` });
    if (await pick.isVisible().catch(() => false)) await pick.click();
    await page.screenshot({ path: join(shots, `${scenario}-welcome-2.png`) });
    await page.getByRole('button', { name: 'Continue' }).click();
    // With the fake permission UI a device may already count as allowed, in which case no button is shown.
    for (const name of ['Allow camera', 'Allow microphone']) {
      const button = page.getByRole('button', { name });
      if (await button.isVisible().catch(() => false)) await button.click();
    }
  } catch (err) {
    await page.screenshot({ path: join(shots, `${scenario}-onboarding-failure.png`) });
    throw err;
  }
  const start = page.getByRole('button', { name: 'Start Handsfree' });
  await start.waitFor({ state: 'visible' });
  const enabledButton = await waitFor(async () => start.isEnabled(), 8000);
  check(scenario, 'camera and microphone permission flow completes', Boolean(enabledButton));
  await start.click();
  return page;
}

async function runScenario(scenario, pageUrl) {
  const videoFile = scenario === 'blank' ? null : await prepareImage(scenario);
  const { context, worker, extensionId, profile } = await launch(scenario, videoFile);
  const base = `chrome-extension://${extensionId}`;
  const pageErrors = [];
  context.on('weberror', (e) => pageErrors.push(String(e.error())));

  try {
    const dashboard = await onboard(scenario, context, extensionId, scenario === 'hand' ? 'Hand mode' : 'Head mode');
    dashboard.on('console', (m) => {
      if (m.type() === 'error') pageErrors.push(`dashboard console: ${m.text()}`);
    });

    // ---- engine start-up -------------------------------------------------------
    const hasOffscreen = await waitFor(async () => worker.evaluate(() => chrome.offscreen.hasDocument()), 10000);
    check(scenario, 'offscreen engine document is created', Boolean(hasOffscreen));

    const ready = await waitFor(async () => {
      const s = await readStatus(dashboard);
      return s && s.phase !== 'loading' ? s : null;
    }, 60000, 500);
    check(scenario, 'engine leaves the loading phase', Boolean(ready), ready ? `phase=${ready.phase}` : 'timed out');
    if (!ready) {
      const last = await readStatus(dashboard);
      const stored = await worker.evaluate(() => chrome.storage.local.get(['hf:engine-error', 'hf:runtime']));
      console.log('  last status:', JSON.stringify(last && { phase: last.phase, error: last.error, camera: last.camera, models: last.models }));
      console.log('  stored:', JSON.stringify(stored));
      return;
    }
    check(scenario, 'no engine error', ready.error === null, ready.error ? `${ready.error.code}: ${ready.error.message}` : '');
    check(scenario, 'camera is on', ready.camera.state === 'on', `${ready.camera.state} ${ready.camera.width}x${ready.camera.height}`);
    if (scenario === 'hand') {
      check(scenario, 'hand mode loads only the hand model', ready.models.hand === 'ready' && ready.models.face === 'off', `face=${ready.models.face} hand=${ready.models.hand}`);
    } else {
      check(scenario, 'head mode loads only the face model', ready.models.face === 'ready' && ready.models.hand === 'off', `face=${ready.models.face} hand=${ready.models.hand}`);
    }

    if (scenario !== 'hand') {
      // Onboarding in head mode lands on the calibration, which starts by itself.
      const calibrating = await waitFor(async () => (await readStatus(dashboard))?.calibration.active, 8000);
      check(scenario, 'head mode setup goes straight into calibration', Boolean(calibrating));
      await sleep(1200);
      await dashboard.screenshot({ path: join(shots, `${scenario}-calibration.png`) });
      if (scenario === 'face') {
        const dots = await dashboard.locator('.cal-dot').count();
        check(scenario, 'calibration shows nine targets and the camera view', dots === 9 && (await dashboard.locator('.cal-center .stage video').count()) === 1, `dots=${dots}`);
        // A photograph cannot turn its head: the run must refuse to produce a calibration.
        const ended = await waitFor(async () => {
          const s = await readStatus(dashboard);
          return s && !s.calibration.active ? s : null;
        }, 40000, 500);
        check(scenario, 'calibration rejects a head that does not move', ended?.calibration.phase === 'failed' && ended.calibrated === false, ended ? `${ended.calibration.phase}: ${ended.calibration.message.slice(0, 60)}` : 'still running');
        await sleep(600);
        await dashboard.screenshot({ path: join(shots, 'dashboard-head-after-calibration.png') });
      }
      // Leaving the page abandons a run in progress.
      await dashboard.goto(`${base}/dashboard.html#/`);
      const stopped = await waitFor(async () => (await readStatus(dashboard))?.calibration.active === false, 5000);
      check(scenario, 'leaving the page stops calibration', Boolean(stopped));
    }

    await sleep(2500);
    const running = await readStatus(dashboard);
    check(scenario, 'frames are being processed', running.perf.fps > 3, `${running.perf.fps.toFixed(1)} fps, face ${running.perf.faceMs.toFixed(1)} ms, hand ${running.perf.handMs.toFixed(1)} ms`);
    check(scenario, 'lighting is measured from the image', running.lighting.rating !== 'unknown', `luma ${running.lighting.luma.toFixed(0)}, ${running.lighting.rating}`);

    // ---- a normal web page -------------------------------------------------------
    const page = await context.newPage();
    await page.goto(pageUrl);
    await page.bringToFront();
    const overlay = await waitFor(async () => page.evaluate(() => document.querySelector('[data-handsfree-overlay]') !== null), 8000);
    check(scenario, 'overlay is injected into an ordinary web page', Boolean(overlay));
    const connected = await waitFor(async () => {
      const s = await readStatus(dashboard);
      return s?.page.controllable ? s : null;
    }, 8000);
    check(scenario, 'page agent connects and the tab is reported controllable', Boolean(connected), connected ? `agents=${connected.page.agents}` : '');

    if (scenario === 'blank') {
      const s = await readStatus(dashboard);
      check(scenario, 'no face is reported for a frame without one', s.face.present === false, `quality=${s.face.quality}`);
      const suspended = await waitFor(async () => {
        const st = await readStatus(dashboard);
        return st?.phase === 'suspended' ? st : null;
      }, 15000, 500);
      check(scenario, 'pauses automatically after sustained tracking loss', Boolean(suspended), suspended ? `autoPauses=${suspended.stats.autoPauses}` : 'never suspended');
      await sleep(3000);
      const clicks = await page.evaluate(() => window.__clicks);
      check(scenario, 'nothing is clicked while there is no tracking', Object.keys(clicks).length === 0, JSON.stringify(clicks));
      await act(dashboard, 'click');
      await sleep(400);
      const after = await page.evaluate(() => window.__clicks);
      check(scenario, 'an explicit click is refused while suspended', Object.keys(after).length === 0, JSON.stringify(after));
      await page.screenshot({ path: join(shots, 'blank-page.png') });
    }

    if (scenario === 'face') {
      const s = await waitFor(async () => {
        const st = await readStatus(dashboard);
        return st?.face.present ? st : null;
      }, 10000);
      check(scenario, 'a face is detected in the photograph', Boolean(s), s ? `yaw ${s.face.yaw.toFixed(1)}, pitch ${s.face.pitch.toFixed(1)}, source ${s.face.poseSource}, quality ${s.face.quality}` : 'no face');

      // A still head should give a still cursor, and resting on the centre button should dwell-click it once.
      const clicked = await waitFor(async () => (await page.evaluate(() => window.__clicks.center ?? 0)) >= 1, 15000);
      const status = await readStatus(dashboard);
      check(scenario, 'cursor rests at the screen centre for a neutral head', Math.abs(status.cursor.x - 0.5) < 0.05 && Math.abs(status.cursor.y - 0.5) < 0.05, `x=${status.cursor.x.toFixed(3)} y=${status.cursor.y.toFixed(3)}`);
      check(scenario, 'dwell click fires on the button under the resting cursor', Boolean(clicked), JSON.stringify(await page.evaluate(() => window.__clicks)));
      await page.screenshot({ path: join(shots, 'face-page.png') });
      await sleep(4000);
      const again = await page.evaluate(() => window.__clicks.center ?? 0);
      check(scenario, 'resting on the button does not click it repeatedly', again === 1, `clicks=${again}`);

      // Numbered labels.
      await act(dashboard, 'show_numbers');
      const shown = await waitFor(async () => (await readStatus(dashboard))?.hintsShown, 5000);
      check(scenario, 'numbered labels are shown', Boolean(shown));
      await page.screenshot({ path: join(shots, 'face-hints.png') });
      await act(dashboard, 'click_number', { number: 1 });
      const first = await waitFor(async () => (await page.evaluate(() => window.__clicks.first ?? 0)) === 1, 4000);
      check(scenario, '"click 1" activates the first element in reading order', Boolean(first), JSON.stringify(await page.evaluate(() => window.__clicks)));
      const hidden = await waitFor(async () => (await readStatus(dashboard))?.hintsShown === false, 4000);
      check(scenario, 'labels are removed after the click', Boolean(hidden));

      // Click by name.
      await act(dashboard, 'click_text', { text: 'centre button' });
      const byName = await waitFor(async () => (await page.evaluate(() => window.__clicks.center ?? 0)) === again + 1, 4000);
      check(scenario, '"click centre button" clicks the control with that name', Boolean(byName));
      await act(dashboard, 'click_text', { text: 'unicorn' });
      const missing = await waitFor(async () => /unicorn/.test((await readStatus(dashboard))?.voice.lastMessage ?? ''), 4000);
      check(scenario, 'a name that is not on the page is reported, not guessed', Boolean(missing));

      // A link that wants a new tab.
      const before = context.pages().length;
      await act(dashboard, 'click_text', { text: 'new window link' });
      const popup = await waitFor(async () => context.pages().find((p) => p.url().includes('second=1')), 6000);
      check(scenario, 'a target="_blank" link opens in a new tab', Boolean(popup) && context.pages().length === before + 1, popup?.url() ?? 'no new tab');
      if (popup) {
        const there = await waitFor(async () => popup.evaluate(() => document.querySelector('[data-handsfree-overlay]') !== null), 6000);
        const followed = await waitFor(async () => (await readStatus(dashboard))?.page.controllable, 6000);
        check(scenario, 'Handsfree follows into the new tab and works there', Boolean(there) && Boolean(followed));
        await act(dashboard, 'scroll_down');
        const scrolledThere = await waitFor(async () => (await popup.evaluate(() => window.scrollY)) > 100, 4000);
        check(scenario, 'commands act on the new tab, not the old one', Boolean(scrolledThere) && (await page.evaluate(() => window.scrollY)) === 0);
        await popup.close();
        await page.bringToFront();
        await sleep(600);
      }

      // Fields: focus by number, then type.
      await act(dashboard, 'show_numbers', { filter: 'fields' });
      await sleep(600);
      await act(dashboard, 'click_number', { number: 1 });
      const focused = await waitFor(async () => page.evaluate(() => document.activeElement?.id === 'field'), 4000);
      check(scenario, '"show fields" then its number focuses the text field', Boolean(focused));
      await act(dashboard, 'type_text', { text: 'hello from handsfree' });
      const typed = await waitFor(async () => page.evaluate(() => document.getElementById('field').value), 4000);
      check(scenario, 'text is inserted into the focused field', typed === 'Hello from handsfree', `value="${typed}"`);

      // Scrolling.
      await act(dashboard, 'scroll_down');
      const scrolled = await waitFor(async () => (await page.evaluate(() => window.scrollY)) > 100, 4000);
      check(scenario, '"scroll down" scrolls the page', Boolean(scrolled));
      await act(dashboard, 'scroll_top');
      await waitFor(async () => (await page.evaluate(() => window.scrollY)) === 0, 4000);
      await act(dashboard, 'scroll_auto_down');
      await sleep(1500);
      const auto1 = await page.evaluate(() => window.scrollY);
      await act(dashboard, 'scroll_stop');
      await sleep(400);
      const auto2 = await page.evaluate(() => window.scrollY);
      await sleep(900);
      const auto3 = await page.evaluate(() => window.scrollY);
      check(scenario, '"keep scrolling" scrolls continuously and "stop scrolling" stops it', auto1 > 40 && auto3 === auto2, `y=${auto1} then ${auto2} then ${auto3}`);
      await act(dashboard, 'scroll_top');
      await sleep(700);

      // Help sheet.
      await act(dashboard, 'show_help');
      await sleep(500);
      await page.screenshot({ path: join(shots, 'face-help.png') });
      await act(dashboard, 'hide_help');

      // Pause really stops interaction.
      await act(dashboard, 'pause');
      await sleep(400);
      check(scenario, 'pause takes effect', (await readStatus(dashboard)).phase === 'paused');
      const beforePause = await page.evaluate(() => ({ ...window.__clicks, y: window.scrollY }));
      for (const [a, p] of [['click'], ['scroll_down'], ['show_numbers'], ['click_text', { text: 'centre button' }], ['scroll_auto_down']]) await act(dashboard, a, p);
      await sleep(2500);
      const afterPause = await page.evaluate(() => ({ ...window.__clicks, y: window.scrollY }));
      check(scenario, 'no click, scroll or labels while paused', JSON.stringify(beforePause) === JSON.stringify(afterPause) && (await readStatus(dashboard)).hintsShown === false, `${JSON.stringify(beforePause)} -> ${JSON.stringify(afterPause)}`);
      await act(dashboard, 'resume');
      const activeAgain = await waitFor(async () => (await readStatus(dashboard))?.phase === 'active', 8000);
      check(scenario, 'resume unlocks interaction again after the grace period', Boolean(activeAgain));

      // A brand new tab.
      const tabsBefore = context.pages().length;
      await act(dashboard, 'new_tab');
      const newTab = await waitFor(async () => (context.pages().length === tabsBefore + 1 ? context.pages()[context.pages().length - 1] : null), 6000);
      check(scenario, '"open new tab" opens a tab', Boolean(newTab));
      if (newTab) {
        const controllable = await waitFor(async () => {
          const st = await readStatus(dashboard);
          return st?.page.controllable ? st : null;
        }, 8000);
        const hasOverlay = await waitFor(async () => newTab.evaluate(() => document.querySelector('[data-handsfree-overlay]') !== null).catch(() => false), 6000);
        check(scenario, 'the new tab page is controllable and shows the cursor', Boolean(controllable) && Boolean(hasOverlay), await newTab.title());
        await sleep(800);
        await newTab.screenshot({ path: join(shots, 'newtab.png') });
        await act(dashboard, 'show_numbers');
        const labelled = await waitFor(async () => (await readStatus(dashboard))?.hintsShown, 5000);
        check(scenario, 'numbers work on the new tab page', Boolean(labelled));
        await act(dashboard, 'hide_numbers');
        await newTab.close();
      }
      await page.bringToFront();
      await sleep(500);

      // Voice mode: the camera is released and numbers appear by themselves.
      await patchSettings(worker, { controlMode: 'voice' });
      const voiceMode = await waitFor(async () => {
        const st = await readStatus(dashboard);
        return st && st.controlMode === 'voice' && st.camera.state === 'off' && st.phase === 'active' ? st : null;
      }, 12000, 500);
      check(scenario, 'voice mode releases the camera', Boolean(voiceMode), voiceMode ? `camera=${voiceMode.camera.state}` : '');
      const autoNumbers = await waitFor(async () => (await readStatus(dashboard))?.hintsShown, 6000);
      check(scenario, 'voice mode numbers the page by itself', Boolean(autoNumbers));
      await page.screenshot({ path: join(shots, 'voice-page.png') });
      const firstBefore = await page.evaluate(() => window.__clicks.first ?? 0);
      await act(dashboard, 'click_number', { number: 1 });
      const voiceClick = await waitFor(async () => (await page.evaluate(() => window.__clicks.first ?? 0)) === firstBefore + 1, 4000);
      check(scenario, 'saying a number clicks it in voice mode', Boolean(voiceClick));
      const backAgain = await waitFor(async () => (await readStatus(dashboard))?.hintsShown, 6000);
      check(scenario, 'numbers come back after the click', Boolean(backAgain));
      await patchSettings(worker, { controlMode: 'head' });
      await waitFor(async () => (await readStatus(dashboard))?.camera.state === 'on', 15000, 500);

      // Every dashboard page.
      for (const route of ['', 'head', 'hand', 'voice', 'playground', 'settings']) {
        await dashboard.goto(`${base}/dashboard.html#/${route}`);
        await dashboard.bringToFront();
        await sleep(1000);
        await dashboard.screenshot({ path: join(shots, `dashboard-${route || 'home'}.png`), fullPage: false });
        const heading = await dashboard.locator('h1').first().textContent();
        check(scenario, `dashboard page "${route || 'home'}" renders`, Boolean(heading), (heading ?? '').slice(0, 40));
      }
      await dashboard.goto(`${base}/dashboard.html#/`);

      const toolbar = await context.newPage();
      await toolbar.goto(`${base}/popup.html`);
      const off = await waitFor(async () => toolbar.getByRole('button', { name: 'Turn off' }).isVisible(), 5000);
      await toolbar.screenshot({ path: join(shots, 'popup.png') });
      check(scenario, 'popup shows the running state and its controls', Boolean(off));
      await toolbar.close();
      await page.bringToFront();
      await sleep(300);
    }

    if (scenario === 'hand') {
      const s = await waitFor(async () => {
        const st = await readStatus(dashboard);
        return st?.hands.length ? st : null;
      }, 12000);
      check(scenario, 'hands are detected in the photograph', Boolean(s), s ? s.hands.map((h) => `${h.handedness} ${(h.score * 100).toFixed(0)}% pose=${h.pose} fingers=${h.extension.map((e) => (e > 0.6 ? 1 : 0)).join('')}`).join(' | ') : 'no hands');
      check(scenario, 'the cursor is driven by the hand', s?.cursorSource === 'hand', s?.cursorSource ?? '');
      await dashboard.goto(`${base}/dashboard.html#/hand`);
      await dashboard.bringToFront();
      await sleep(2500);
      await dashboard.screenshot({ path: join(shots, 'hand-page.png') });
      const centred = dashboard.getByRole('button', { name: 'Centre the box on my hand' });
      if (await centred.isEnabled().catch(() => false)) {
        await centred.click();
        await sleep(500);
        const stored = await worker.evaluate(async () => (await chrome.storage.local.get('hf:settings'))['hf:settings'].cursor);
        check(scenario, '"centre the box on my hand" stores where the hand is', Math.abs(stored.handCenterX - 0.5) > 0.001 || Math.abs(stored.handCenterY - 0.55) > 0.001, `x=${stored.handCenterX.toFixed(2)} y=${stored.handCenterY.toFixed(2)}`);
      }
    }

    // ---- shutdown ------------------------------------------------------------------
    await dashboard.goto(`${base}/dashboard.html#/`);
    await dashboard.bringToFront();
    await dashboard.getByRole('button', { name: 'Turn off' }).click();
    const closed = await waitFor(async () => !(await worker.evaluate(() => chrome.offscreen.hasDocument())), 8000);
    check(scenario, 'turning off closes the engine document (camera and microphone released)', Boolean(closed));
    const removed = await waitFor(async () => page.evaluate(() => document.querySelector('[data-handsfree-overlay]') === null), 5000);
    check(scenario, 'the overlay is removed from the web page', Boolean(removed));
    check(scenario, 'no uncaught errors in extension pages', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
}

const wanted = process.argv.slice(2).filter((a) => ['blank', 'face', 'hand'].includes(a));
const scenarios = wanted.length ? wanted : ['blank', 'face', 'hand'];

if (!(await exists(join(dist, 'manifest.json')))) {
  console.error('dist/ is missing. Run "npm run build" first.');
  process.exit(2);
}
await mkdir(shots, { recursive: true });
const { server, url } = await serve();
try {
  for (const scenario of scenarios) {
    try {
      await runScenario(scenario, url);
    } catch (err) {
      check(scenario, 'scenario ran to completion', false, err instanceof Error ? err.message.split('\n')[0] : String(err));
    }
  }
} finally {
  server.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);

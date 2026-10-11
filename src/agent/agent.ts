import { DwellDetector } from '../core/dwell';
import { HELP_SECTIONS } from '../core/voice/commands';
import { needsConfirmation } from '../core/risk';
import type { HintFilter } from '../shared/actions';
import {
  AGENT_PORT,
  type AgentEventName,
  type AgentToEngine,
  type EngineToAgent,
  type HudState,
  type PageAction,
  type PageActionParams,
} from '../shared/messages';
import { DEFAULT_SETTINGS, type Settings } from '../shared/settings';
import { loadSettings, onSettingsChanged } from '../shared/storage';
import {
  deepActiveElement,
  deepElementFromPoint,
  describeTarget,
  elementLabel,
  interactiveAncestor,
  isEditable,
  isTextField,
  labelMatchScore,
  normalizeLabel,
} from './dom';
import { HintNumbering, collectHintTargets, placeLabels, type HintEnv } from './hints';
import { Overlay } from './overlay';
import { SyntheticPointer } from './pointer';
import { TextEntry } from './text';

export interface AgentEvent {
  name: AgentEventName | 'confirm-request' | 'confirm-declined';
  detail?: string;
  /** The element involved, for in-page consumers such as the benchmark. */
  element?: Element | null;
}

export interface AgentOptions {
  kind: 'content' | 'extension';
  /** Local observer for agent events (used by the benchmark page). */
  onEvent?: (event: AgentEvent) => void;
}

interface PendingClick {
  id: string;
  target: Element;
  x: number;
  y: number;
  kind: 'single' | 'double' | 'right';
}

const RECONNECT_MS = 1000;
const TARGET_PROBE_MS = 60;
const HOVER_MS = 40;

/**
 * The part of Handsfree that lives in a web page. It draws the cursor and
 * HUD, turns engine commands into page interactions, and reports back what
 * happened. It holds no tracking logic and never sees camera or audio data.
 */
export class PageAgent {
  private settings: Settings = DEFAULT_SETTINGS;
  private overlay: Overlay | null = null;
  private pointer: SyntheticPointer | null = null;
  private readonly dwell = new DwellDetector({ dwellMs: 1100, radiusPx: 34, armDelayMs: 180 });
  private readonly text = new TextEntry();
  private readonly numbering = new HintNumbering();

  private port: chrome.runtime.Port | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private cleanup: Array<() => void> = [];

  private hud: HudState | null = null;
  private cursor = { x: 0.5, y: 0.5, show: false, ok: false };
  private frameRequested = false;
  private lastProbe = 0;
  private lastHover = 0;
  private target: Element | null = null;
  private dwellTarget: Element | null = null;

  private hintsShown = false;
  private hintFilter: HintFilter = 'all';
  /** When set, only these elements are numbered (several matches for a spoken name). */
  private hintSubset: Set<Element> | null = null;
  /** Earliest time numbers may reappear by themselves in voice mode. */
  private autoHintsAt = 0;
  private scrollTimer: ReturnType<typeof setInterval> | null = null;
  private hintTimer: ReturnType<typeof setTimeout> | null = null;
  private observer: MutationObserver | null = null;

  private pendingClick: PendingClick | null = null;
  private clickSeq = 0;
  private pickerSelect: HTMLSelectElement | null = null;
  private startAttempt = 0;

  constructor(private readonly options: AgentOptions) {}

  // ---- lifecycle --------------------------------------------------------------

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    // A quick off-and-on can leave an earlier start() still waiting below; only the latest may mount.
    const attempt = ++this.startAttempt;
    try {
      this.settings = await loadSettings();
    } catch {
      this.settings = DEFAULT_SETTINGS;
    }
    if (!this.running || attempt !== this.startAttempt) return;

    this.overlay = new Overlay({
      onConfirm: (ok) => {
        if (this.hud?.pending) this.post({ t: 'confirm-answer', id: this.hud.pending.id, ok });
      },
      onPick: (index) => this.pickOption(index),
    });
    this.overlay.mount();
    this.pointer = new SyntheticPointer(new Map([[this.overlay.host, this.overlay.shadow]]));
    this.applySettings();

    this.cleanup.push(
      onSettingsChanged((settings) => {
        this.settings = settings;
        this.applySettings();
      }),
    );
    const visibility = () => this.reportVisibility();
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('focus', visibility);
    window.addEventListener('blur', visibility);
    const reflow = () => this.scheduleHintRefresh(true);
    window.addEventListener('scroll', reflow, { capture: true, passive: true });
    window.addEventListener('resize', reflow, { passive: true });
    this.cleanup.push(() => {
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('focus', visibility);
      window.removeEventListener('blur', visibility);
      window.removeEventListener('scroll', reflow, { capture: true });
      window.removeEventListener('resize', reflow);
    });

    this.connect();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.hintTimer) clearTimeout(this.hintTimer);
    this.reconnectTimer = this.hintTimer = null;
    this.stopAutoScroll();
    this.observer?.disconnect();
    this.observer = null;
    for (const fn of this.cleanup.splice(0)) fn();
    this.pointer?.reset();
    this.pointer = null;
    this.dwell.reset();
    this.text.clearHistory();
    this.numbering.reset();
    this.hintsShown = false;
    this.pendingClick = null;
    this.pickerSelect = null;
    try {
      this.port?.disconnect();
    } catch {
      /* already closed */
    }
    this.port = null;
    this.overlay?.unmount();
    this.overlay = null;
    this.hud = null;
  }

  private applySettings(): void {
    const s = this.settings;
    this.overlay?.applyAppearance(s.cursor.size, s.cursor.color, s.textScale);
    this.dwell.configure({ dwellMs: s.click.dwellMs, radiusPx: s.click.dwellRadiusPx, armDelayMs: 180 });
  }

  // ---- connection -------------------------------------------------------------

  private connect(): void {
    if (!this.running || this.port) return;
    let port: chrome.runtime.Port;
    try {
      port = chrome.runtime.connect({ name: AGENT_PORT });
    } catch {
      // The extension was reloaded or removed: this script instance is orphaned.
      this.stop();
      return;
    }
    this.port = port;
    port.onMessage.addListener((msg: EngineToAgent) => this.onMessage(msg));
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (this.port !== port) return;
      this.port = null;
      // The engine went away: show nothing interactive until it is back.
      this.cursor = { ...this.cursor, show: false, ok: false };
      this.dwell.reset();
      this.pointer?.reset();
      this.requestFrame();
      if (this.running) this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_MS);
    });
    this.post({ t: 'hello', kind: this.options.kind, href: location.href });
    this.reportVisibility();
  }

  private post(msg: AgentToEngine): void {
    try {
      this.port?.postMessage(msg);
    } catch {
      this.port = null;
    }
  }

  private emit(name: AgentEventName, detail?: string, requestId?: string, element?: Element | null): void {
    this.post({ t: 'event', name, detail, requestId });
    this.options.onEvent?.({ name, detail, element });
  }

  private reportVisibility(): void {
    this.post({ t: 'visibility', visible: document.visibilityState === 'visible', focused: document.hasFocus() });
  }

  // ---- messages from the engine -------------------------------------------------

  private onMessage(msg: EngineToAgent): void {
    if (!this.running || !msg || typeof msg !== 'object') return;
    if (msg.t === 'cursor') {
      this.cursor = { x: msg.x, y: msg.y, show: msg.show, ok: msg.ok };
      this.requestFrame();
    } else if (msg.t === 'hud') {
      this.hud = msg.hud;
      this.overlay?.setHud(msg.hud);
      if (!msg.hud.pending && this.pendingClick) this.pendingClick = null;
      // Voice mode: numbers stay up, coming back shortly after each click.
      if (msg.hud.autoHints && !this.hintsShown && performance.now() >= this.autoHintsAt) this.showHints('all', true);
      this.requestFrame();
    } else if (msg.t === 'do') {
      this.perform(msg.action, msg.params ?? {});
    }
  }

  private px(): { x: number; y: number } {
    // Voice-only mode has no cursor: act at the centre of the viewport.
    if (!this.cursor.show) return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    return { x: this.cursor.x * window.innerWidth, y: this.cursor.y * window.innerHeight };
  }

  private requestFrame(): void {
    if (this.frameRequested) return;
    this.frameRequested = true;
    requestAnimationFrame((t) => {
      this.frameRequested = false;
      this.render(t);
    });
  }

  private render(t: number): void {
    const overlay = this.overlay;
    const pointer = this.pointer;
    if (!overlay || !pointer) return;
    const { x, y } = this.px();
    const paused = this.hud?.phase === 'paused' || this.hud?.phase === 'suspended';
    overlay.setCursor(x, y, this.cursor.show, paused ? 'paused' : this.cursor.ok ? 'ok' : 'idle', pointer.dragging);

    if (!this.cursor.show || paused) {
      overlay.setTarget(null);
      overlay.setDwellProgress(0);
      this.target = null;
      this.runDwell(t, x, y, false);
      return;
    }

    if (t - this.lastHover >= HOVER_MS) {
      this.lastHover = t;
      pointer.move(x, y);
    }
    if (t - this.lastProbe >= TARGET_PROBE_MS) {
      this.lastProbe = t;
      this.target = this.probe(x, y);
      const box = this.target && !overlay.owns(this.target) ? this.target.getBoundingClientRect() : null;
      overlay.setTarget(box && box.width < window.innerWidth * 0.9 ? box : null);
    }
    this.runDwell(t, x, y, this.cursor.ok);
    // Keep the countdown animating while the cursor rests.
    if (this.cursor.ok && this.settings.click.dwellEnabled) this.requestFrame();
  }

  /** What would be activated at this point: an overlay button, or an interactive page element. */
  private probe(x: number, y: number): Element | null {
    const hit = this.pointer?.hitTest(x, y);
    if (!hit) return null;
    if (this.overlay?.owns(hit.element)) return hit.element.closest('button');
    // While a confirmation is open, only its own buttons can be activated.
    if (this.hud?.pending) return null;
    const interactive = interactiveAncestor(hit.element);
    if (interactive) return interactive;
    return this.settings.click.dwellInteractiveOnly ? null : hit.element;
  }

  private runDwell(t: number, x: number, y: number, ok: boolean): void {
    const enabled = ok && this.settings.click.dwellEnabled && document.visibilityState === 'visible';
    const { state, events } = this.dwell.update(t, x, y, this.target, enabled);
    this.overlay?.setDwellProgress(state.progress);
    for (const ev of events) {
      if (ev.type === 'start') {
        this.dwellTarget = this.target;
        this.emit('dwell-start', undefined, undefined, this.dwellTarget);
      } else if (ev.type === 'cancel') {
        this.emit('dwell-cancel', ev.reason, undefined, this.dwellTarget);
      } else {
        this.click('single');
      }
    }
  }

  // ---- clicking -----------------------------------------------------------------

  private click(kind: 'single' | 'double' | 'right', explicit?: Element): void {
    const pointer = this.pointer;
    const overlay = this.overlay;
    if (!pointer || !overlay) return;
    let { x, y } = this.px();
    let target: Element | null;

    if (explicit) {
      const r = explicit.getBoundingClientRect();
      x = Math.min(Math.max(r.left + r.width / 2, 1), window.innerWidth - 1);
      y = Math.min(Math.max(r.top + r.height / 2, 1), window.innerHeight - 1);
      target = explicit;
    } else {
      const hit = pointer.hitTest(x, y);
      if (!hit) {
        this.emit('click-blocked', 'nothing here');
        return;
      }
      if (overlay.owns(hit.element)) {
        // Our own confirm / picker buttons: activate directly.
        (hit.element.closest('button') as HTMLButtonElement | null)?.click();
        return;
      }
      if (this.hud?.pending) {
        this.emit('click-blocked', 'confirmation open');
        return;
      }
      target = hit.element;
    }

    if (overlay.pickerOpen) this.closePicker();

    const subject = interactiveAncestor(target) ?? target;
    const prompt = kind === 'right' ? null : needsConfirmation(this.settings.click.confirmPolicy, describeTarget(subject));
    if (prompt) {
      const id = `c${Date.now().toString(36)}${++this.clickSeq}`;
      this.pendingClick = { id, target, x, y, kind };
      this.post({ t: 'confirm-request', id, prompt });
      this.options.onEvent?.({ name: 'confirm-request', detail: prompt, element: subject });
      return;
    }
    this.doClick(target, x, y, kind, explicit !== undefined);
  }

  private doClick(target: Element, x: number, y: number, kind: 'single' | 'double' | 'right', explicit: boolean): void {
    const pointer = this.pointer;
    if (!pointer) return;
    const subject = interactiveAncestor(target) ?? target;

    // Native select popups ignore synthetic clicks: offer the options in the overlay instead.
    if (subject instanceof HTMLSelectElement && !subject.multiple && kind === 'single') {
      subject.focus({ preventScroll: true });
      this.openPicker(subject);
      this.emit('click', elementLabel(subject), undefined, subject);
      return;
    }

    // A link that opens a new tab or window. A synthetic click counts as a pop-up
    // and is blocked, so after the page's own handlers have run the browser is asked to open it.
    const anchor = kind === 'single' ? (subject.closest('a[href]') as HTMLAnchorElement | null) : null;
    const wantsNewTab = anchor !== null && /^https?:/i.test(anchor.href) && anchor.target !== '' && !/^_(self|top|parent)$/i.test(anchor.target);
    const openInstead = (e: Event): void => {
      if (e.defaultPrevented || !anchor) return;
      e.preventDefault();
      this.post({ t: 'open-tab', url: anchor.href });
    };
    if (wantsNewTab) window.addEventListener('click', openInstead, { once: true });
    pointer.click(x, y, explicit ? target : undefined, kind);
    if (wantsNewTab) window.removeEventListener('click', openInstead);
    if (explicit && isEditable(subject)) (subject as HTMLElement).focus({ preventScroll: true });
    this.emit('click', elementLabel(subject), undefined, subject);
  }

  private openPicker(select: HTMLSelectElement): void {
    this.pickerSelect = select;
    const rect = select.getBoundingClientRect();
    this.overlay?.showPicker(
      Array.from(select.options).map((o) => ({ label: o.label || o.text, selected: o.selected, disabled: o.disabled })),
      { left: rect.left, bottom: rect.bottom },
    );
  }

  private closePicker(): void {
    this.pickerSelect = null;
    this.overlay?.hidePicker();
  }

  private pickOption(index: number): void {
    const select = this.pickerSelect;
    this.closePicker();
    if (!select || !select.isConnected || index < 0 || index >= select.options.length) return;
    if (select.selectedIndex === index) return;
    select.selectedIndex = index;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ---- numbered hints -------------------------------------------------------------

  private hintEnv(): HintEnv {
    return {
      viewport: () => ({ width: window.innerWidth, height: window.innerHeight }),
      rect: (el) => el.getBoundingClientRect(),
      style: (el) => getComputedStyle(el),
      hitTest: (x, y) => deepElementFromPoint(x, y)?.element ?? null,
    };
  }

  private showHints(filter: HintFilter, quiet = false): void {
    this.hintFilter = filter;
    this.hintSubset = null;
    this.numbering.reset();
    this.hintsShown = true;
    const count = this.refreshHints();
    if (!this.observer) {
      this.observer = new MutationObserver(() => this.scheduleHintRefresh(false));
      this.observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'disabled', 'aria-hidden', 'open'],
      });
    }
    this.emit('hints-shown', String(count));
    if (count === 0 && !quiet) this.overlay?.showToast(filter === 'all' ? 'Nothing to click in view' : `No ${filter} in view`, 'warn');
  }

  private hideHints(): void {
    if (!this.hintsShown) return;
    this.hintsShown = false;
    this.observer?.disconnect();
    this.observer = null;
    if (this.hintTimer) clearTimeout(this.hintTimer);
    this.hintTimer = null;
    this.numbering.reset();
    this.hintSubset = null;
    this.overlay?.setHints([]);
    this.emit('hints-hidden');
  }

  private refreshHints(): number {
    if (!this.hintsShown || !this.overlay) return 0;
    const env = this.hintEnv();
    const subset = this.hintSubset;
    const targets = collectHintTargets(document, this.hintFilter, this.settings.hints.maxLabels, env).filter(
      (el) => !subset || subset.has(el),
    );
    this.overlay.setHints(placeLabels(this.numbering.assign(targets), env));
    return targets.length;
  }

  /**
   * @param renumber after scrolling the view is new, so numbers restart at 1;
   *   after a DOM change existing elements keep their numbers.
   */
  private scheduleHintRefresh(renumber: boolean): void {
    if (!this.hintsShown) return;
    if (this.hintTimer) clearTimeout(this.hintTimer);
    // Hide stale labels immediately: a label must never sit on the wrong element.
    if (renumber) this.overlay?.setHints([]);
    this.hintTimer = setTimeout(
      () => {
        this.hintTimer = null;
        if (renumber) this.numbering.reset();
        this.refreshHints();
      },
      renumber ? 180 : 350,
    );
  }

  private clickHint(number: number): void {
    const el = this.hintsShown ? this.numbering.get(number) : undefined;
    if (!el || !el.isConnected) {
      this.emit('hint-missing', String(number));
      return;
    }
    this.hideHints();
    // Give the page a moment to react before numbering it again (voice mode).
    this.autoHintsAt = performance.now() + 900;
    this.click('single', el);
  }

  /** "click sign in": activate the control whose label matches, or number the candidates if several do. */
  private clickText(text: string): void {
    const wanted = normalizeLabel(text);
    const candidates = collectHintTargets(document, 'all', 400, this.hintEnv())
      .map((el) => ({ el, score: labelMatchScore(normalizeLabel(elementLabel(el)), wanted) }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score);
    if (candidates.length === 0) {
      this.emit('target-missing', `Nothing in view is called "${text}". Try "show numbers".`);
      return;
    }
    const best = candidates.filter((c) => c.score >= candidates[0].score - 1e-6);
    if (best.length === 1) {
      if (this.hintsShown) this.hideHints();
      this.autoHintsAt = performance.now() + 900;
      this.click('single', best[0].el);
      return;
    }
    // Several equally good matches: never guess. Number just those and let the user choose.
    this.showHints('all', true);
    this.hintSubset = new Set(best.map((c) => c.el));
    this.numbering.reset();
    this.refreshHints();
    this.overlay?.showToast(`${best.length} things are called "${text}". Say the number.`, 'info', 5000);
  }

  // ---- media and continuous scrolling ---------------------------------------------

  /** The video or audio element the user most plausibly means: one that is playing, else the largest in view. */
  private mediaElement(): HTMLMediaElement | null {
    const all = Array.from(document.querySelectorAll<HTMLMediaElement>('video, audio'));
    if (all.length === 0) return null;
    const area = (m: HTMLMediaElement): number => {
      const r = m.getBoundingClientRect();
      const w = Math.max(0, Math.min(r.right, window.innerWidth) - Math.max(r.left, 0));
      const h = Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0));
      return w * h;
    };
    return all.find((m) => !m.paused && !m.ended) ?? all.sort((a, b) => area(b) - area(a))[0];
  }

  private media(command: 'play' | 'pause' | 'toggle' | 'mute' | 'unmute'): void {
    const m = this.mediaElement();
    if (!m) {
      this.emit('target-missing', 'There is no video or audio on this page.');
      return;
    }
    const play = command === 'play' || (command === 'toggle' && m.paused);
    if (command === 'mute') m.muted = true;
    else if (command === 'unmute') m.muted = false;
    else if (play) {
      // Browsers may refuse to start sound without a real click; say so instead of failing silently.
      void m.play().catch(() => this.overlay?.showToast("The browser would not start playback. Try clicking the player.", 'warn'));
    } else m.pause();
  }

  private startAutoScroll(viewportsPerSecond: number): void {
    this.stopAutoScroll();
    const started = performance.now();
    this.scrollTimer = setInterval(() => {
      // A safety stop, and no scrolling behind the user's back in a hidden tab or while paused.
      const paused = this.hud?.phase !== 'active';
      if (paused || document.visibilityState !== 'visible' || performance.now() - started > 5 * 60_000) {
        this.stopAutoScroll();
        return;
      }
      const { x, y } = this.px();
      this.pointer?.scrollBy(x, y, 0, viewportsPerSecond * 0.04, false);
    }, 40);
  }

  private stopAutoScroll(): void {
    if (this.scrollTimer) clearInterval(this.scrollTimer);
    this.scrollTimer = null;
  }

  // ---- keys -----------------------------------------------------------------------

  /**
   * Synthetic key events do not trigger browser default actions, so the
   * common ones are carried out explicitly after dispatching the events.
   */
  private pressKey(pressed: string): void {
    const backwards = pressed === 'ShiftTab';
    const key = backwards ? 'Tab' : pressed;
    const el = (deepActiveElement() ?? document.body) as HTMLElement;
    const init = { key, code: key === ' ' ? 'Space' : key, shiftKey: backwards, bubbles: true, cancelable: true, composed: true };
    const proceed = el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
    this.emit('key-pressed', key);
    if (!proceed) return;

    const editable = isEditable(el);
    switch (key) {
      case 'Enter':
        if (el instanceof HTMLTextAreaElement || (editable && !isTextField(el))) this.text.insert('\n');
        else if (el instanceof HTMLInputElement && el.form) el.form.requestSubmit();
        else if (el !== document.body) el.click();
        break;
      case ' ':
        if (editable) this.text.insert(' ');
        else if (el !== document.body) el.click();
        else this.pointer?.scrollBy(window.innerWidth / 2, window.innerHeight / 2, 0, 0.8, true);
        break;
      case 'Tab': {
        const focusables = Array.from(
          document.querySelectorAll<HTMLElement>(
            'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"]), [contenteditable=""], [contenteditable="true"]',
          ),
        ).filter((f) => !(f as HTMLButtonElement).disabled && f.getClientRects().length > 0);
        if (focusables.length === 0) break;
        const at = focusables.indexOf(el);
        const next = focusables[(at + (backwards ? -1 : 1) + focusables.length) % focusables.length];
        next.focus();
        break;
      }
      case 'Escape':
        if (this.overlay?.pickerOpen) this.closePicker();
        else if (el !== document.body) el.blur();
        break;
      case 'Backspace':
      case 'Delete':
        if (editable) document.execCommand?.(key === 'Backspace' ? 'delete' : 'forwardDelete');
        break;
      case 'ArrowUp':
      case 'ArrowDown': {
        const dir = key === 'ArrowDown' ? 1 : -1;
        if (el instanceof HTMLSelectElement) {
          const index = Math.min(el.options.length - 1, Math.max(0, el.selectedIndex + dir));
          if (index !== el.selectedIndex) {
            el.selectedIndex = index;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        } else if (!editable) {
          this.pointer?.scrollBy(window.innerWidth / 2, window.innerHeight / 2, 0, dir * 0.15, true);
        }
        break;
      }
      case 'ArrowLeft':
      case 'ArrowRight':
        if (!editable) {
          this.pointer?.scrollBy(window.innerWidth / 2, window.innerHeight / 2, key === 'ArrowRight' ? 0.15 : -0.15, 0, true);
        }
        break;
      case 'Home':
        if (!editable) this.pointer?.scrollTo(window.innerWidth / 2, window.innerHeight / 2, 'top');
        break;
      case 'End':
        if (!editable) this.pointer?.scrollTo(window.innerWidth / 2, window.innerHeight / 2, 'bottom');
        break;
    }
  }

  // ---- engine commands ------------------------------------------------------------

  private perform(action: PageAction, params: PageActionParams): void {
    const pointer = this.pointer;
    const overlay = this.overlay;
    if (!pointer || !overlay) return;
    const { x, y } = this.px();

    switch (action) {
      case 'click':
        this.click('single');
        break;
      case 'doubleClick':
        this.click('double');
        break;
      case 'rightClick':
        this.click('right');
        break;
      case 'dragStart': {
        const el = pointer.dragStart(x, y);
        this.emit('drag-start', el ? elementLabel(el) : '', undefined, el);
        break;
      }
      case 'dragEnd':
        if (pointer.dragging) {
          pointer.dragEnd(x, y);
          this.emit('drag-end', 'dropped');
        }
        break;
      case 'dragCancel':
        if (pointer.dragging) {
          pointer.dragCancel();
          this.emit('drag-end', 'cancelled');
        }
        break;
      case 'cancelClick':
        for (const ev of this.dwell.cancel(performance.now())) {
          if (ev.type === 'cancel') this.emit('dwell-cancel', ev.reason, undefined, this.dwellTarget);
        }
        overlay.setDwellProgress(0);
        if (overlay.pickerOpen) this.closePicker();
        break;
      case 'scrollBy': {
        const dx = params.dx ?? 0;
        const dy = params.dy ?? 0;
        // An explicit step replaces continuous scrolling.
        if (Math.abs(dx) + Math.abs(dy) >= 0.2) this.stopAutoScroll();
        pointer.scrollBy(x, y, dx, dy, Math.abs(dx) + Math.abs(dy) >= 0.2);
        break;
      }
      case 'scrollTo':
        this.stopAutoScroll();
        pointer.scrollTo(x, y, params.to === 'bottom' ? 'bottom' : 'top');
        break;
      case 'showHints':
        this.showHints(params.filter ?? 'all');
        break;
      case 'hideHints':
        this.hideHints();
        break;
      case 'toggleHints':
        if (this.hintsShown) this.hideHints();
        else this.showHints('all');
        break;
      case 'clickHint':
        this.clickHint(params.number ?? -1);
        break;
      case 'clickText':
        if (params.text) this.clickText(params.text);
        break;
      case 'media':
        if (params.media) this.media(params.media);
        break;
      case 'autoScroll':
        this.startAutoScroll(params.dy ?? 0.3);
        break;
      case 'stopScroll':
        this.stopAutoScroll();
        break;
      case 'showHelp':
        overlay.showHelp(HELP_SECTIONS);
        break;
      case 'hideHelp':
        overlay.hideHelp();
        break;
      case 'insertText': {
        const outcome = this.text.insert(params.text ?? '');
        if (outcome.ok) this.emit('text-inserted', undefined, params.requestId, this.text.target());
        else this.emit('text-failed', outcome.reason, params.requestId);
        break;
      }
      case 'undoText': {
        const result = this.text.undo(Math.max(1, params.number ?? 1));
        if (result.removed > 0) this.emit('text-undone', String(result.removed));
        if (result.reason) overlay.showToast(result.reason, 'warn');
        break;
      }
      case 'pressKey':
        if (params.key) this.pressKey(params.key);
        break;
      case 'confirmed': {
        const pending = this.pendingClick;
        if (!pending || pending.id !== params.id) break;
        this.pendingClick = null;
        if (pending.target.isConnected) this.doClick(pending.target, pending.x, pending.y, pending.kind, true);
        break;
      }
      case 'declined':
        if (this.pendingClick && this.pendingClick.id === params.id) {
          this.pendingClick = null;
          this.options.onEvent?.({ name: 'confirm-declined' });
        }
        break;
      case 'toast':
        if (params.text) overlay.showToast(params.text, params.tone ?? 'info');
        break;
    }
  }
}

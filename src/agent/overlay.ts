import type { HudState } from '../shared/messages';
import type { HintLabelPlacement } from './hints';

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.root {
  position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;
  font: 700 calc(13px * var(--hf-scale, 1))/1.35 "Segoe UI", system-ui, -apple-system, Roboto, sans-serif;
  color: #0c0c0c; -webkit-font-smoothing: antialiased;
  --lime: #ccff00; --pink: #ff4fa3; --violet: #b388ff; --orange: #ff8a00;
  --ink: #0c0c0c; --paper: #fffbea; --bad: #ff3b3b;
}
.cursor {
  position: absolute; left: 0; top: 0; width: var(--hf-size, 28px); height: var(--hf-size, 28px);
  margin: calc(var(--hf-size, 28px) / -2) 0 0 calc(var(--hf-size, 28px) / -2);
  will-change: transform; display: none;
}
.cursor.show { display: block; }
.cursor .ring {
  position: absolute; inset: 0; border-radius: 50%;
  border: 3.5px solid var(--hf-color, #ccff00);
  box-shadow: 0 0 0 2px var(--ink), inset 0 0 0 2px var(--ink);
  background: rgba(204, 255, 0, 0.12);
}
.cursor .dot {
  position: absolute; left: 50%; top: 50%; width: 7px; height: 7px; margin: -3.5px 0 0 -3.5px; border-radius: 50%;
  background: var(--hf-color, #ccff00); box-shadow: 0 0 0 2px var(--ink);
}
.cursor.idle .ring { border-style: dashed; opacity: 0.8; }
.cursor.paused .ring { border-color: #9a9a9a; background: none; }
.cursor.paused .dot { background: #9a9a9a; }
.cursor.dragging .ring { border-width: 5px; background: rgba(255, 79, 163, 0.35); border-color: var(--pink); }
.cursor svg { position: absolute; inset: -10px; width: calc(100% + 20px); height: calc(100% + 20px); transform: rotate(-90deg); }
.cursor circle { fill: none; stroke: var(--pink); stroke-width: 6; stroke-linecap: round; filter: drop-shadow(0 0 1px #000); }
.target {
  position: absolute; left: 0; top: 0; display: none; border-radius: 8px;
  outline: 3px solid var(--hf-color, #ccff00); outline-offset: 2px; box-shadow: 0 0 0 6px rgba(12, 12, 12, 0.55);
}
.target.show { display: block; }

.pill {
  position: absolute; right: 14px; bottom: 14px; display: flex; align-items: center; gap: 10px;
  padding: 7px 12px; border-radius: 14px; background: var(--ink); color: var(--paper);
  border: 2.5px solid var(--lime); box-shadow: 4px 4px 0 var(--pink); max-width: calc(100vw - 28px);
  flex-wrap: wrap; justify-content: flex-end; row-gap: 4px;
  text-transform: uppercase; letter-spacing: 0.04em; font-size: calc(11.5px * var(--hf-scale, 1)); font-weight: 800;
}
.pill .brand { color: var(--lime); font-weight: 900; }
.pill .sep { width: 2px; height: 14px; background: #3a3a3a; }
.chip { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.chip i { width: 9px; height: 9px; border-radius: 50%; background: #6b6b6b; flex: none; }
.chip.on i { background: var(--lime); } .chip.warn i { background: var(--orange); } .chip.bad i { background: var(--bad); }
.chip.live i { background: var(--pink); box-shadow: 0 0 0 3px rgba(255, 79, 163, 0.3); }

.banner {
  position: absolute; right: 14px; bottom: 62px; transform: rotate(-1deg); display: none;
  padding: 10px 18px; border-radius: 14px; background: var(--lime); color: var(--ink);
  border: 3px solid var(--ink); box-shadow: 5px 5px 0 var(--ink); text-align: left; max-width: min(calc(100vw - 28px), 520px);
  font-size: calc(14.5px * var(--hf-scale, 1)); font-weight: 800;
}
.banner.show { display: block; }
.banner.paused { background: var(--pink); }

.speech {
  position: absolute; left: 14px; bottom: 14px; display: none;
  padding: 8px 14px; border-radius: 14px 14px 14px 2px; background: var(--ink); color: var(--paper);
  border: 2.5px solid var(--violet); box-shadow: 4px 4px 0 var(--violet);
  max-width: min(46vw, 520px); font-size: calc(14px * var(--hf-scale, 1));
}
.speech.show { display: block; }
.speech .label { color: var(--violet); margin-right: 8px; font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 900; }
.speech.dictating { border-color: var(--lime); box-shadow: 4px 4px 0 var(--lime); }
.speech.dictating .label { color: var(--lime); }

.toast {
  position: absolute; left: 50%; top: 16px; transform: translateX(-50%); display: none;
  padding: 9px 15px; border-radius: 12px; background: var(--paper); color: var(--ink);
  border: 2.5px solid var(--ink); box-shadow: 4px 4px 0 var(--ink); max-width: min(90vw, 560px); text-align: center;
}
.toast.show { display: block; }
.toast.ok { background: var(--lime); } .toast.warn { background: var(--orange); }

.dialog {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); display: none;
  width: min(92vw, 470px); padding: 22px; border-radius: 20px; background: var(--paper); color: var(--ink);
  border: 3px solid var(--ink); box-shadow: 9px 9px 0 var(--pink); text-align: center;
}
.dialog.show { display: block; }
.dialog h2 { margin: 0 0 6px; font-size: calc(19px * var(--hf-scale, 1)); font-weight: 900; overflow-wrap: anywhere; }
.dialog p { margin: 0 0 16px; font-weight: 600; color: #3a3a3a; }
.dialog .row { display: flex; gap: 14px; justify-content: center; }
.dialog .bar { height: 8px; margin-top: 16px; border-radius: 99px; background: #e6dfc4; border: 2px solid var(--ink); overflow: hidden; }
.dialog .bar span { display: block; height: 100%; background: var(--pink); width: 100%; }
button.hf {
  pointer-events: auto; cursor: pointer; min-width: 136px; min-height: 54px; padding: 10px 18px;
  border-radius: 14px; border: 3px solid var(--ink); background: #fff; color: var(--ink);
  box-shadow: 4px 4px 0 var(--ink); font: 900 calc(15px * var(--hf-scale, 1)) "Segoe UI", system-ui, sans-serif;
  text-transform: uppercase; letter-spacing: 0.03em;
}
button.hf.primary { background: var(--lime); }
button.hf:focus-visible { outline: 3px solid var(--pink); outline-offset: 3px; }

.picker {
  position: absolute; display: none; max-height: 70vh; overflow: auto; padding: 10px; border-radius: 16px;
  background: var(--paper); border: 3px solid var(--ink); box-shadow: 7px 7px 0 var(--violet);
  pointer-events: auto; min-width: 230px;
}
.picker.show { display: grid; gap: 8px; }
.picker button.hf { min-height: 46px; text-align: left; width: 100%; text-transform: none; box-shadow: 3px 3px 0 var(--ink); }
.picker button.hf.selected { background: var(--lime); }

.help {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); display: none;
  width: min(94vw, 880px); max-height: 86vh; overflow: auto; padding: 22px; border-radius: 22px;
  background: var(--paper); color: var(--ink); border: 3px solid var(--ink); box-shadow: 10px 10px 0 var(--lime);
}
.help.show { display: block; }
.help h2 { margin: 0 0 4px; font-size: calc(24px * var(--hf-scale, 1)); font-weight: 900; text-transform: uppercase; }
.help .sub { margin: 0 0 16px; font-weight: 600; color: #3a3a3a; }
.help .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 14px; }
.help h3 { margin: 0 0 8px; font-size: calc(12px * var(--hf-scale, 1)); text-transform: uppercase; letter-spacing: 0.08em; font-weight: 900; }
.help .say {
  display: inline-block; margin: 0 6px 6px 0; padding: 3px 9px; border-radius: 9px; background: #fff;
  border: 2px solid var(--ink); font-weight: 700; font-size: calc(13px * var(--hf-scale, 1));
}
.help section:nth-child(3n+1) .say { background: var(--lime); }
.help section:nth-child(3n+2) .say { background: #ffd1e8; }
.help section:nth-child(3n) .say { background: #e3d5ff; }

.hints { position: absolute; inset: 0; }
.hint {
  position: absolute; min-width: 24px; padding: 1px 6px; border-radius: 7px; text-align: center;
  background: var(--lime); color: var(--ink); border: 2px solid var(--ink); box-shadow: 2px 2px 0 var(--ink);
  font: 900 calc(12.5px * var(--hf-scale, 1))/1.25 ui-monospace, "Cascadia Mono", Consolas, monospace;
}
@media (prefers-reduced-motion: no-preference) {
  .toast.show, .banner.show, .dialog.show, .help.show { animation: hf-in 160ms cubic-bezier(.2, 1.4, .4, 1); }
  @keyframes hf-in { from { opacity: 0; scale: 0.94; } to { opacity: 1; scale: 1; } }
}
`;

const SVG_NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export interface OverlayCallbacks {
  onConfirm(ok: boolean): void;
  onPick(index: number): void;
}

const PHASE_TEXT: Record<string, string> = {
  loading: 'Starting',
  grace: 'Starting',
  active: 'Active',
  paused: 'Paused',
  suspended: 'Paused',
  error: 'Error',
};

const MODE_TEXT: Record<string, string> = { head: 'Head', hand: 'Hand', none: 'Voice' };

/**
 * Everything Handsfree draws on a page, inside one closed shadow root so page
 * styles cannot affect it and it cannot affect the page. All text is set with
 * textContent; no HTML is ever built from page or speech content.
 */
export class Overlay {
  readonly host: HTMLElement;
  readonly shadow: ShadowRoot;
  private readonly root: HTMLElement;
  private readonly cursor: HTMLElement;
  private readonly progress: SVGCircleElement;
  private readonly targetBox: HTMLElement;
  private readonly pill: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly speech: HTMLElement;
  private readonly toast: HTMLElement;
  private readonly dialog: HTMLElement;
  private readonly dialogTitle: HTMLElement;
  private readonly dialogBar: HTMLElement;
  private readonly picker: HTMLElement;
  private readonly help: HTMLElement;
  private helpTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly hints: HTMLElement;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private circumference = 0;

  constructor(private readonly callbacks: OverlayCallbacks) {
    this.host = el('div');
    this.host.setAttribute('data-handsfree-overlay', '');
    this.host.setAttribute('aria-hidden', 'false');
    this.shadow = this.host.attachShadow({ mode: 'closed' });

    const style = el('style');
    style.textContent = CSS;
    this.root = el('div', 'root');

    this.hints = el('div', 'hints');
    this.targetBox = el('div', 'target');

    this.cursor = el('div', 'cursor');
    this.cursor.append(el('div', 'ring'), el('div', 'dot'));
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    this.progress = document.createElementNS(SVG_NS, 'circle');
    this.progress.setAttribute('cx', '50');
    this.progress.setAttribute('cy', '50');
    this.progress.setAttribute('r', '44');
    this.circumference = 2 * Math.PI * 44;
    this.progress.setAttribute('stroke-dasharray', String(this.circumference));
    this.progress.setAttribute('stroke-dashoffset', String(this.circumference));
    svg.append(this.progress);
    this.cursor.append(svg);

    this.pill = el('div', 'pill');
    this.pill.setAttribute('role', 'status');
    this.banner = el('div', 'banner');
    this.banner.setAttribute('role', 'alert');
    this.speech = el('div', 'speech');
    this.speech.setAttribute('aria-live', 'polite');
    this.toast = el('div', 'toast');
    this.toast.setAttribute('role', 'status');

    this.dialog = el('div', 'dialog');
    this.dialog.setAttribute('role', 'alertdialog');
    this.dialog.setAttribute('aria-label', 'Confirm action');
    this.dialogTitle = el('h2');
    const help = el('p', undefined, 'Say "confirm" or "cancel", show a thumbs up or down, or rest the cursor on a button.');
    const row = el('div', 'row');
    const yes = el('button', 'hf primary', 'Confirm');
    const no = el('button', 'hf', 'Cancel');
    yes.type = no.type = 'button';
    yes.addEventListener('click', () => this.callbacks.onConfirm(true));
    no.addEventListener('click', () => this.callbacks.onConfirm(false));
    row.append(no, yes);
    const bar = el('div', 'bar');
    this.dialogBar = el('span');
    bar.append(this.dialogBar);
    this.dialog.append(this.dialogTitle, help, row, bar);

    this.picker = el('div', 'picker');
    this.picker.setAttribute('role', 'listbox');

    this.help = el('div', 'help');
    this.help.setAttribute('role', 'dialog');
    this.help.setAttribute('aria-label', 'Things you can say');

    this.root.append(this.hints, this.targetBox, this.pill, this.banner, this.speech, this.toast, this.picker, this.help, this.dialog, this.cursor);
    this.shadow.append(style, this.root);
  }

  mount(): void {
    if (!this.host.isConnected) (document.documentElement ?? document.body).append(this.host);
  }

  unmount(): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    if (this.helpTimer) clearTimeout(this.helpTimer);
    this.host.remove();
  }

  /** True when the element belongs to this overlay (its confirm buttons, option picker). */
  owns(node: Element | null): boolean {
    return node !== null && node.getRootNode() === this.shadow;
  }

  applyAppearance(size: number, color: string, scale: number): void {
    this.root.style.setProperty('--hf-size', `${size}px`);
    this.root.style.setProperty('--hf-color', color);
    this.root.style.setProperty('--hf-scale', String(scale));
  }

  setCursor(x: number, y: number, show: boolean, state: 'ok' | 'idle' | 'paused', dragging: boolean): void {
    this.cursor.className = `cursor${show ? ' show' : ''} ${state}${dragging ? ' dragging' : ''}`;
    this.cursor.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }

  setDwellProgress(progress: number): void {
    this.progress.setAttribute('stroke-dashoffset', String(this.circumference * (1 - Math.min(1, Math.max(0, progress)))));
  }

  setTarget(box: { left: number; top: number; width: number; height: number } | null): void {
    if (!box) {
      this.targetBox.classList.remove('show');
      return;
    }
    this.targetBox.classList.add('show');
    this.targetBox.style.transform = `translate3d(${box.left}px, ${box.top}px, 0)`;
    this.targetBox.style.width = `${box.width}px`;
    this.targetBox.style.height = `${box.height}px`;
  }

  private chip(text: string, tone: '' | 'on' | 'warn' | 'bad' | 'live'): HTMLElement {
    const chip = el('span', `chip ${tone}`.trim());
    chip.append(el('i'), document.createTextNode(text));
    return chip;
  }

  setHud(hud: HudState): void {
    const source = MODE_TEXT[hud.cursorSource] ?? 'Head';
    const phaseTone = hud.phase === 'active' ? 'on' : hud.phase === 'error' ? 'bad' : 'warn';
    const trackTone = hud.tracking === 'good' ? 'on' : hud.tracking === 'fair' ? 'warn' : hud.tracking === 'off' ? '' : 'bad';
    const sep = () => el('span', 'sep');

    const items: HTMLElement[] = [el('span', 'brand', 'Handsfree'), sep(), this.chip(`${source} · ${PHASE_TEXT[hud.phase] ?? hud.phase}`, phaseTone)];
    if (hud.tracking !== 'off') items.push(this.chip(`Track ${hud.tracking}`, trackTone));
    items.push(sep(), this.chip(hud.cameraOn ? 'Cam on' : 'Cam off', hud.cameraOn ? 'live' : ''));
    items.push(this.chip(hud.listening ? 'Mic live' : hud.micOn ? 'Mic on' : 'Mic off', hud.listening || hud.micOn ? 'live' : ''));
    this.pill.replaceChildren(...items);

    // Banner: the one thing the user most needs to know right now.
    let banner = '';
    let paused = false;
    if (hud.phase === 'paused' || hud.phase === 'suspended') {
      paused = true;
      banner =
        hud.phase === 'suspended'
          ? 'Handsfree paused: tracking lost. Move back into view, or say "resume".'
          : 'Handsfree is paused. Say "resume" or raise an open hand to continue.';
    } else if (hud.phase === 'grace') {
      banner = `Getting ready... clicks unlock in ${Math.ceil(hud.graceRemainingMs / 1000)} s`;
    } else if (hud.phase === 'loading') {
      banner = 'Handsfree is starting the camera and tracking models...';
    } else if (hud.phase === 'error') {
      banner = `Handsfree stopped: ${hud.pausedReason ?? 'an error occurred'}. Open the dashboard for details.`;
    } else if (hud.dragging) {
      banner = 'Dragging. Release the pinch or say "release" to drop.';
    }
    this.banner.textContent = banner;
    this.banner.className = `banner${banner ? ' show' : ''}${paused ? ' paused' : ''}`;

    // Live transcript: what the recogniser is hearing right now.
    const speaking = hud.interim.trim();
    if (hud.dictating || speaking) {
      const label = el('span', 'label', hud.dictating ? 'Dictating' : 'Heard');
      this.speech.replaceChildren(label, document.createTextNode(speaking || 'Listening for text...'));
      this.speech.className = `speech show${hud.dictating ? ' dictating' : ''}`;
    } else {
      this.speech.className = 'speech';
    }

    if (hud.pending) {
      this.dialogTitle.textContent = hud.pending.prompt;
      this.dialogBar.style.width = `${Math.min(100, (hud.pending.remainingMs / 10000) * 100)}%`;
      this.dialog.classList.add('show');
    } else {
      this.dialog.classList.remove('show');
    }
  }

  showToast(text: string, tone: 'info' | 'ok' | 'warn' = 'info', ms = 3200): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toast.textContent = text;
    this.toast.className = `toast show ${tone}`;
    this.toastTimer = setTimeout(() => {
      this.toast.className = 'toast';
    }, ms);
  }

  setHints(labels: HintLabelPlacement[]): void {
    const nodes = labels.map((label) => {
      const node = el('div', 'hint', String(label.number));
      node.style.transform = `translate3d(${label.left}px, ${label.top}px, 0)`;
      return node;
    });
    this.hints.replaceChildren(...nodes);
  }

  /** The "what can I say" cheat sheet. It closes by itself after a while. */
  showHelp(sections: Array<{ title: string; phrases: string[] }>, ms = 25000): void {
    const title = el('h2', undefined, 'Say it out loud');
    const sub = el('p', 'sub', 'These work right now. Say "hide help" to close this.');
    const cols = el('div', 'cols');
    for (const section of sections) {
      const block = el('section');
      block.append(el('h3', undefined, section.title));
      for (const phrase of section.phrases) block.append(el('span', 'say', phrase));
      cols.append(block);
    }
    this.help.replaceChildren(title, sub, cols);
    this.help.classList.add('show');
    if (this.helpTimer) clearTimeout(this.helpTimer);
    this.helpTimer = setTimeout(() => this.hideHelp(), ms);
  }

  hideHelp(): void {
    if (this.helpTimer) clearTimeout(this.helpTimer);
    this.helpTimer = null;
    this.help.classList.remove('show');
  }

  /** A dwell-clickable replacement for a native select popup. */
  showPicker(options: Array<{ label: string; selected: boolean; disabled: boolean }>, anchor: { left: number; bottom: number }): void {
    const buttons = options.map((option, index) => {
      const button = el('button', `hf${option.selected ? ' selected' : ''}`, option.label || '(empty)');
      button.type = 'button';
      button.disabled = option.disabled;
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(option.selected));
      button.addEventListener('click', () => this.callbacks.onPick(index));
      return button;
    });
    const close = el('button', 'hf', 'Close');
    close.type = 'button';
    close.addEventListener('click', () => this.callbacks.onPick(-1));
    this.picker.replaceChildren(...buttons, close);
    this.picker.classList.add('show');
    const width = 260;
    this.picker.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8))}px`;
    this.picker.style.top = `${Math.max(8, Math.min(anchor.bottom + 6, window.innerHeight * 0.3))}px`;
  }

  hidePicker(): void {
    this.picker.classList.remove('show');
    this.picker.replaceChildren();
  }

  get pickerOpen(): boolean {
    return this.picker.classList.contains('show');
  }
}

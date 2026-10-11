import { composedParent, deepElementFromPoint, scrollableAncestor, type HitResult } from './dom';

/**
 * Synthetic pointer input for the page.
 *
 * Events created by a content script are "untrusted" (`isTrusted === false`).
 * Ordinary links, buttons, form controls and most script-driven widgets
 * respond to them; a few browser features that demand a real user gesture
 * (file pickers, native select popups, fullscreen, pop-up windows) do not.
 * Native controls that ignore synthetic events are handled explicitly where
 * practical (range inputs here, selects in the overlay).
 */

type Roots = Map<Element, ShadowRoot>;

function eventInit(hit: HitResult, x: number, y: number, button: number, buttons: number, detail = 1) {
  const view = hit.element.ownerDocument.defaultView ?? window;
  return {
    bubbles: true,
    cancelable: true,
    composed: true,
    view,
    detail,
    clientX: x - hit.offsetX,
    clientY: y - hit.offsetY,
    screenX: x + window.screenX,
    screenY: y + window.screenY,
    button,
    buttons,
  };
}

function fire(
  hit: HitResult,
  type: string,
  x: number,
  y: number,
  button = 0,
  buttons = 0,
  detail = 1,
): boolean {
  const init = eventInit(hit, x, y, button, buttons, detail);
  const view = init.view as Window & typeof globalThis;
  const isPointer = type.startsWith('pointer');
  const event =
    isPointer && typeof view.PointerEvent === 'function'
      ? new view.PointerEvent(type, { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true })
      : new view.MouseEvent(type, init);
  return hit.element.dispatchEvent(event);
}

function focusable(el: Element): HTMLElement | null {
  for (let n: Element | null = el; n; n = composedParent(n)) {
    const h = n as HTMLElement;
    if (typeof h.focus !== 'function') continue;
    if (h.tabIndex >= 0 || h.isContentEditable) return h;
  }
  return null;
}

/** Set a range input from a horizontal position, since it ignores synthetic drags. */
function setRangeFromPoint(input: HTMLInputElement, clientX: number): void {
  const rect = input.getBoundingClientRect();
  if (rect.width <= 0) return;
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const step = Number(input.step) || 1;
  const rtl = getComputedStyle(input).direction === 'rtl';
  let ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  if (rtl) ratio = 1 - ratio;
  const value = Math.round((min + ratio * (max - min)) / step) * step;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  const text = String(Number(value.toFixed(6)));
  if (input.value === text) return;
  if (setter) setter.call(input, text);
  else input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

const isRange = (el: Element): el is HTMLInputElement => el instanceof HTMLInputElement && el.type === 'range';

export class SyntheticPointer {
  private hovered: Element | null = null;
  private drag:
    | { mode: 'mouse'; source: HitResult; startX: number; startY: number }
    | { mode: 'html5'; source: HitResult; data: DataTransfer; over: Element | null }
    | { mode: 'range'; input: HTMLInputElement }
    | null = null;

  constructor(private readonly overlayRoots: Roots) {}

  hitTest(x: number, y: number): HitResult | null {
    return deepElementFromPoint(x, y, this.overlayRoots);
  }

  get dragging(): boolean {
    return this.drag !== null;
  }

  /** Report pointer movement so hover menus and drag targets react. */
  move(x: number, y: number): void {
    const hit = this.hitTest(x, y);
    if (!hit) return;
    const el = hit.element;

    if (this.drag?.mode === 'range') {
      setRangeFromPoint(this.drag.input, x);
      return;
    }
    if (this.drag?.mode === 'html5') {
      const view = el.ownerDocument.defaultView ?? window;
      if (this.drag.over !== el) {
        if (this.drag.over) {
          this.drag.over.dispatchEvent(new view.DragEvent('dragleave', { ...eventInit(hit, x, y, 0, 1), dataTransfer: this.drag.data }));
        }
        el.dispatchEvent(new view.DragEvent('dragenter', { ...eventInit(hit, x, y, 0, 1), dataTransfer: this.drag.data }));
        this.drag.over = el;
      }
      el.dispatchEvent(new view.DragEvent('dragover', { ...eventInit(hit, x, y, 0, 1), dataTransfer: this.drag.data }));
      return;
    }

    const buttons = this.drag ? 1 : 0;
    if (this.hovered !== el) {
      if (this.hovered?.isConnected) {
        const prev: HitResult = { element: this.hovered, offsetX: hit.offsetX, offsetY: hit.offsetY };
        fire(prev, 'pointerout', x, y, 0, buttons);
        fire(prev, 'mouseout', x, y, 0, buttons);
      }
      fire(hit, 'pointerover', x, y, 0, buttons);
      fire(hit, 'mouseover', x, y, 0, buttons);
      this.hovered = el;
    }
    fire(hit, 'pointermove', x, y, 0, buttons);
    fire(hit, 'mousemove', x, y, 0, buttons);
  }

  /** A complete click on `target` (or whatever is under the point). */
  click(x: number, y: number, target?: Element | null, kind: 'single' | 'double' | 'right' = 'single'): Element | null {
    const hit = target ? { element: target, offsetX: 0, offsetY: 0 } : this.hitTest(x, y);
    if (!hit) return null;
    const el = hit.element;

    if (kind === 'right') {
      fire(hit, 'pointerdown', x, y, 2, 2);
      fire(hit, 'mousedown', x, y, 2, 2);
      fire(hit, 'pointerup', x, y, 2, 0);
      fire(hit, 'mouseup', x, y, 2, 0);
      fire(hit, 'contextmenu', x, y, 2, 0);
      return el;
    }

    const press = (detail: number): void => {
      fire(hit, 'pointerdown', x, y, 0, 1, detail);
      const proceed = fire(hit, 'mousedown', x, y, 0, 1, detail);
      // A real mousedown moves focus unless the page prevents it.
      if (proceed) focusable(el)?.focus({ preventScroll: true });
      fire(hit, 'pointerup', x, y, 0, 0, detail);
      fire(hit, 'mouseup', x, y, 0, 0, detail);
      fire(hit, 'click', x, y, 0, 0, detail);
    };

    if (isRange(el)) setRangeFromPoint(el, x - hit.offsetX);
    press(1);
    if (kind === 'double') {
      press(2);
      fire(hit, 'dblclick', x, y, 0, 0, 2);
    }
    return el;
  }

  dragStart(x: number, y: number): Element | null {
    if (this.drag) return null;
    const hit = this.hitTest(x, y);
    if (!hit) return null;
    const el = hit.element;

    if (isRange(el)) {
      this.drag = { mode: 'range', input: el };
      setRangeFromPoint(el, x - hit.offsetX);
      return el;
    }

    const draggable = el.closest('[draggable="true"]');
    const view = el.ownerDocument.defaultView ?? window;
    if (draggable && typeof view.DataTransfer === 'function' && typeof view.DragEvent === 'function') {
      const source: HitResult = { ...hit, element: draggable };
      const data = new view.DataTransfer();
      fire(hit, 'pointerdown', x, y, 0, 1);
      fire(hit, 'mousedown', x, y, 0, 1);
      draggable.dispatchEvent(new view.DragEvent('dragstart', { ...eventInit(source, x, y, 0, 1), dataTransfer: data }));
      this.drag = { mode: 'html5', source, data, over: null };
      return draggable;
    }

    fire(hit, 'pointerdown', x, y, 0, 1);
    fire(hit, 'mousedown', x, y, 0, 1);
    this.drag = { mode: 'mouse', source: hit, startX: x, startY: y };
    return el;
  }

  dragEnd(x: number, y: number): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    const hit = this.hitTest(x, y);
    if (drag.mode === 'range') {
      setRangeFromPoint(drag.input, x);
      return;
    }
    if (drag.mode === 'html5') {
      const view = drag.source.element.ownerDocument.defaultView ?? window;
      if (hit) {
        hit.element.dispatchEvent(new view.DragEvent('drop', { ...eventInit(hit, x, y, 0, 0), dataTransfer: drag.data }));
      }
      drag.source.element.dispatchEvent(
        new view.DragEvent('dragend', { ...eventInit(drag.source, x, y, 0, 0), dataTransfer: drag.data }),
      );
      return;
    }
    const target = hit ?? drag.source;
    fire(target, 'pointerup', x, y, 0, 0);
    fire(target, 'mouseup', x, y, 0, 0);
  }

  /** Abandon a drag without dropping at the current position. */
  dragCancel(): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    if (drag.mode === 'range') return;
    if (drag.mode === 'html5') {
      const view = drag.source.element.ownerDocument.defaultView ?? window;
      // No `drop` event: the page sees a cancelled drag.
      drag.source.element.dispatchEvent(
        new view.DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: drag.data }),
      );
      return;
    }
    // Script-driven drags: most libraries cancel on Escape; then release where the drag began.
    drag.source.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    fire(drag.source, 'pointerup', drag.startX, drag.startY, 0, 0);
    fire(drag.source, 'mouseup', drag.startX, drag.startY, 0, 0);
  }

  /** Scroll whatever is under the point. Amounts are fractions of the viewport. */
  scrollBy(x: number, y: number, dx: number, dy: number, smooth: boolean): void {
    const hit = this.hitTest(x, y);
    const vertical = Math.abs(dy) >= Math.abs(dx);
    const target = scrollableAncestor(hit?.element ?? null, vertical);
    const root = document.scrollingElement ?? document.documentElement;
    const h = target === root ? window.innerHeight : target.clientHeight;
    const w = target === root ? window.innerWidth : target.clientWidth;
    target.scrollBy({ left: dx * w, top: dy * h, behavior: smooth ? 'smooth' : 'auto' });
  }

  scrollTo(x: number, y: number, to: 'top' | 'bottom'): void {
    const hit = this.hitTest(x, y);
    const target = scrollableAncestor(hit?.element ?? null, true);
    target.scrollTo({ top: to === 'top' ? 0 : target.scrollHeight, behavior: 'smooth' });
  }

  reset(): void {
    if (this.drag) this.dragCancel();
    this.hovered = null;
  }
}

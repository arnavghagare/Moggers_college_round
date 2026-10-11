import type { HintFilter } from '../shared/actions';
import { INTERACTIVE_SELECTOR, composedContains, composedParent, hintKind } from './dom';

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/** Geometry and style lookups, injectable so the logic can be tested without a layout engine. */
export interface HintEnv {
  viewport(): { width: number; height: number };
  rect(el: Element): Box;
  style(el: Element): { display: string; visibility: string; opacity: string; pointerEvents: string };
  /** Topmost element at a viewport point (deep), or null. */
  hitTest(x: number, y: number): Element | null;
}

const MIN_SIZE = 4;
const MAX_CANDIDATES = 4000;

function isDisabled(el: Element): boolean {
  return (
    (el as HTMLButtonElement).disabled === true ||
    el.getAttribute('aria-disabled') === 'true' ||
    el.closest('fieldset[disabled]') !== null ||
    el.closest('[inert]') !== null
  );
}

function isHidden(el: Element, env: HintEnv): boolean {
  if (el.closest('[aria-hidden="true"]') || el.closest('[hidden]')) return true;
  for (let n: Element | null = el, depth = 0; n && depth < 40; n = composedParent(n), depth++) {
    const s = env.style(n);
    if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse') return true;
    if (Number(s.opacity) === 0) return true;
  }
  return false;
}

/** All shadow roots reachable from `root`, so web components are included. */
function withShadowRoots(root: Document | ShadowRoot, out: Array<Document | ShadowRoot> = [], budget = { n: MAX_CANDIDATES }) {
  out.push(root);
  for (const el of root.querySelectorAll('*')) {
    if (budget.n-- <= 0) break;
    if (el.shadowRoot) withShadowRoots(el.shadowRoot, out, budget);
  }
  return out;
}

/**
 * Find the elements worth numbering: interactive, enabled, visible, inside
 * the viewport and not covered by something else. Results are in reading
 * order (top to bottom, then left to right).
 */
export function collectHintTargets(doc: Document, filter: HintFilter, max: number, env: HintEnv): Element[] {
  const { width, height } = env.viewport();
  const found: Array<{ el: Element; box: Box }> = [];
  const seen = new Set<Element>();

  for (const root of withShadowRoots(doc)) {
    for (const el of root.querySelectorAll(INTERACTIVE_SELECTOR)) {
      if (seen.has(el) || seen.size > MAX_CANDIDATES) continue;
      seen.add(el);
      if (filter !== 'all' && hintKind(el) !== filter) continue;
      if (isDisabled(el)) continue;

      const box = env.rect(el);
      if (box.width < MIN_SIZE || box.height < MIN_SIZE) continue;
      if (box.bottom <= 0 || box.right <= 0 || box.top >= height || box.left >= width) continue;
      if (isHidden(el, env)) continue;

      // Probe the visible part of the element: skip it if something else is on top.
      const x = (Math.max(0, box.left) + Math.min(width, box.right)) / 2;
      const y = (Math.max(0, box.top) + Math.min(height, box.bottom)) / 2;
      const top = env.hitTest(x, y);
      if (!top || !(composedContains(el, top) || composedContains(top, el))) continue;
      // An ancestor on top only counts if it is this element's own label.
      if (top !== el && !composedContains(el, top) && !(top instanceof HTMLLabelElement && top.control === el)) continue;

      found.push({ el, box });
    }
  }

  // Drop wrappers that merely contain another target of the same footprint
  // (e.g. a clickable card around a single link): one number is enough.
  const targets = found.filter(
    (outer) =>
      !found.some(
        (inner) =>
          inner !== outer &&
          composedContains(outer.el, inner.el) &&
          inner.box.width * inner.box.height > outer.box.width * outer.box.height * 0.6,
      ),
  );

  targets.sort((a, b) => (Math.abs(a.box.top - b.box.top) > 8 ? a.box.top - b.box.top : a.box.left - b.box.left));
  return targets.slice(0, max).map((t) => t.el);
}

/**
 * Stable number assignment for one "show numbers" session. An element keeps
 * its number for as long as it stays on screen, so a number never silently
 * moves to a different control while the user is about to say it.
 */
export class HintNumbering {
  private byElement = new Map<Element, number>();
  private byNumber = new Map<number, Element>();
  private next = 1;

  /** Assign numbers to the current targets. Elements no longer present lose theirs. */
  assign(targets: Element[]): Array<{ el: Element; number: number }> {
    const current = new Set(targets);
    for (const [el, n] of this.byElement) {
      if (!current.has(el)) {
        this.byElement.delete(el);
        this.byNumber.delete(n);
      }
    }
    const out: Array<{ el: Element; number: number }> = [];
    for (const el of targets) {
      let n = this.byElement.get(el);
      if (n === undefined) {
        n = this.next++;
        this.byElement.set(el, n);
        this.byNumber.set(n, el);
      }
      out.push({ el, number: n });
    }
    return out;
  }

  get(n: number): Element | undefined {
    return this.byNumber.get(n);
  }

  /** Start numbering from 1 again (a new session, or a completely new view). */
  reset(): void {
    this.byElement.clear();
    this.byNumber.clear();
    this.next = 1;
  }

  get size(): number {
    return this.byElement.size;
  }
}

export interface HintLabelPlacement {
  number: number;
  left: number;
  top: number;
}

/** Position each label at its target's top-left corner, kept inside the viewport. */
export function placeLabels(
  assigned: Array<{ el: Element; number: number }>,
  env: HintEnv,
  labelWidth = 26,
  labelHeight = 18,
): HintLabelPlacement[] {
  const { width, height } = env.viewport();
  return assigned.map(({ el, number }) => {
    const box = env.rect(el);
    return {
      number,
      left: Math.min(Math.max(0, box.left - 4), Math.max(0, width - labelWidth)),
      top: Math.min(Math.max(0, box.top - 4), Math.max(0, height - labelHeight)),
    };
  });
}

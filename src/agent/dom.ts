import type { HintFilter } from '../shared/actions';
import type { ClickTargetInfo } from '../core/risk';

/** Elements a user can meaningfully activate or type into. */
export const INTERACTIVE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'summary',
  'label[for]',
  'video[controls]',
  'audio[controls]',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="option"]',
  '[role="combobox"]',
  '[role="textbox"]',
  '[role="searchbox"]',
  '[role="slider"]',
  '[role="treeitem"]',
  '[onclick]',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', '']);

export function isTextField(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement {
  if (!el) return false;
  if (el.tagName === 'TEXTAREA') return !(el as HTMLTextAreaElement).disabled && !(el as HTMLTextAreaElement).readOnly;
  if (el.tagName === 'INPUT') {
    const input = el as HTMLInputElement;
    return TEXT_INPUT_TYPES.has((input.getAttribute('type') ?? '').toLowerCase()) && !input.disabled && !input.readOnly;
  }
  return false;
}

export function isContentEditable(el: Element | null): el is HTMLElement {
  if (!el || !(el as HTMLElement).isContentEditable) {
    // jsdom does not implement isContentEditable; fall back to the attribute.
    const attr = el?.closest?.('[contenteditable]')?.getAttribute('contenteditable');
    return attr === '' || attr === 'true' || attr === 'plaintext-only';
  }
  return true;
}

export function isEditable(el: Element | null): boolean {
  return isTextField(el) || isContentEditable(el);
}

/** Parent in the flattened tree: crosses shadow-root boundaries. */
export function composedParent(node: Node): Element | null {
  if (node.parentElement) return node.parentElement;
  const root = node.getRootNode?.();
  return root instanceof ShadowRoot ? root.host : null;
}

export function composedContains(ancestor: Element, node: Element | null): boolean {
  for (let n: Element | null = node; n; n = composedParent(n)) if (n === ancestor) return true;
  return false;
}

export interface HitResult {
  element: Element;
  /** Offset of the element's document relative to the top viewport (non-zero inside iframes). */
  offsetX: number;
  offsetY: number;
}

/**
 * elementFromPoint that descends into open shadow roots and same-origin
 * iframes. `extraRoots` lets the overlay's own (closed) shadow root be searched.
 */
export function deepElementFromPoint(x: number, y: number, extraRoots: Map<Element, ShadowRoot> = new Map()): HitResult | null {
  let doc: Document = document;
  let offsetX = 0;
  let offsetY = 0;
  let el = doc.elementFromPoint(x, y);
  for (let depth = 0; el && depth < 12; depth++) {
    const root = el.shadowRoot ?? extraRoots.get(el) ?? null;
    if (root) {
      const inner = root.elementFromPoint(x - offsetX, y - offsetY);
      if (inner && inner !== el) {
        el = inner;
        continue;
      }
    }
    if (el instanceof HTMLIFrameElement) {
      let innerDoc: Document | null = null;
      try {
        innerDoc = el.contentDocument;
      } catch {
        innerDoc = null;
      }
      if (innerDoc) {
        const r = el.getBoundingClientRect();
        const ox = offsetX + r.left + el.clientLeft;
        const oy = offsetY + r.top + el.clientTop;
        const inner = innerDoc.elementFromPoint(x - ox, y - oy);
        if (inner) {
          doc = innerDoc;
          offsetX = ox;
          offsetY = oy;
          el = inner;
          continue;
        }
      }
    }
    break;
  }
  return el ? { element: el, offsetX, offsetY } : null;
}

/** The nearest interactive ancestor of `el` (crossing shadow boundaries), or null. */
export function interactiveAncestor(el: Element | null): Element | null {
  for (let n: Element | null = el; n; n = composedParent(n)) {
    if (n.matches(INTERACTIVE_SELECTOR)) {
      if ((n as HTMLButtonElement).disabled || n.getAttribute('aria-disabled') === 'true') return null;
      return n;
    }
  }
  // Fall back to the outermost element styled as clickable.
  let pointer: Element | null = null;
  for (let n: Element | null = el; n && n !== document.body && n !== document.documentElement; n = composedParent(n)) {
    const view = n.ownerDocument.defaultView;
    if (view && view.getComputedStyle(n).cursor === 'pointer') pointer = n;
    else if (pointer) break;
  }
  return pointer;
}

export function deepActiveElement(): Element | null {
  let el: Element | null = document.activeElement;
  for (let depth = 0; el && depth < 12; depth++) {
    if (el.shadowRoot?.activeElement) {
      el = el.shadowRoot.activeElement;
      continue;
    }
    if (el instanceof HTMLIFrameElement) {
      try {
        const inner = el.contentDocument?.activeElement;
        if (inner && inner !== el.contentDocument?.body) {
          el = inner;
          continue;
        }
      } catch {
        /* cross-origin frame */
      }
    }
    break;
  }
  return el;
}

export function elementLabel(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria) return aria.trim();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    if (el instanceof HTMLInputElement && ['submit', 'button', 'reset'].includes(el.type) && el.value) return el.value;
    const label = el.labels?.[0]?.textContent?.replace(/\s+/g, ' ').trim();
    if (label) return label.slice(0, 80);
    const placeholder = 'placeholder' in el ? el.placeholder : '';
    return placeholder || el.getAttribute('title') || el.name || el.type;
  }
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (text) return text.slice(0, 80);
  return el.getAttribute('title') ?? el.getAttribute('alt') ?? el.querySelector('img[alt]')?.getAttribute('alt') ?? '';
}

export function describeTarget(el: Element): ClickTargetInfo {
  const form = el.closest('form');
  return {
    tag: el.tagName.toLowerCase(),
    type: (el.getAttribute('type') ?? '').toLowerCase(),
    role: (el.getAttribute('role') ?? '').toLowerCase(),
    label: elementLabel(el),
    inForm: form !== null,
    formSensitive:
      form !== null &&
      form.querySelector('input[type="password"], input[autocomplete^="cc-"], input[name*="card" i], input[name*="cvv" i]') !== null,
  };
}

export function hintKind(el: Element): Exclude<HintFilter, 'all'> {
  const tag = el.tagName;
  const role = (el.getAttribute('role') ?? '').toLowerCase();
  if (tag === 'A' || tag === 'AREA' || role === 'link') return 'links';
  if (tag === 'TEXTAREA' || tag === 'SELECT' || ['textbox', 'searchbox', 'combobox'].includes(role)) return 'fields';
  if (tag === 'INPUT') {
    const type = (el.getAttribute('type') ?? 'text').toLowerCase();
    return ['button', 'submit', 'reset', 'image', 'checkbox', 'radio', 'file', 'color', 'range'].includes(type)
      ? 'buttons'
      : 'fields';
  }
  const ce = el.getAttribute('contenteditable');
  if (ce === '' || ce === 'true' || ce === 'plaintext-only') return 'fields';
  return 'buttons';
}

/** The nearest ancestor that can actually scroll in the given direction. */
export function scrollableAncestor(el: Element | null, vertical: boolean): Element {
  for (let n: Element | null = el; n && n !== document.documentElement && n !== document.body; n = composedParent(n)) {
    const view = n.ownerDocument.defaultView;
    if (!view) break;
    const style = view.getComputedStyle(n);
    const overflow = vertical ? style.overflowY : style.overflowX;
    const scrolls = overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay';
    const room = vertical ? n.scrollHeight - n.clientHeight : n.scrollWidth - n.clientWidth;
    if (scrolls && room > 4) return n;
  }
  return document.scrollingElement ?? document.documentElement;
}

/** Lower-case words only, so a spoken name can be compared with a visible label. */
export function normalizeLabel(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * How well a spoken name matches a label: 1 = identical, lower for looser
 * matches, 0 = no match. Both arguments must already be normalized.
 */
export function labelMatchScore(label: string, wanted: string): number {
  if (!label || !wanted) return 0;
  if (label === wanted) return 1;
  if (label.startsWith(`${wanted} `)) return 0.8;
  if (` ${label} `.includes(` ${wanted} `)) return 0.65;
  if (label.startsWith(wanted)) return 0.5;
  const words = wanted.split(' ');
  const have = new Set(label.split(' '));
  if (words.length > 1 && words.every((w) => have.has(w))) return 0.4;
  if (wanted.length >= 4 && label.includes(wanted)) return 0.3;
  return 0;
}

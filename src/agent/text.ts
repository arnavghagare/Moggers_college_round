import { joinDictation } from '../core/voice/dictation';
import { deepActiveElement, isContentEditable, isTextField } from './dom';

export type InsertOutcome = { ok: true; inserted: string } | { ok: false; reason: string };

interface Insertion {
  element: Element;
  text: string;
}

function nativeValueSetter(el: HTMLInputElement | HTMLTextAreaElement): ((value: string) => void) | null {
  const view = el.ownerDocument.defaultView ?? window;
  const proto = el.tagName === 'TEXTAREA' ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  return setter ? (value) => setter.call(el, value) : null;
}

/** Selection offsets, tolerating input types (email, number) that do not expose them. */
function selectionOf(el: HTMLInputElement | HTMLTextAreaElement): { start: number; end: number; supported: boolean } {
  try {
    if (el.selectionStart !== null && el.selectionEnd !== null) {
      return { start: el.selectionStart, end: el.selectionEnd, supported: true };
    }
  } catch {
    /* selection not supported for this input type */
  }
  return { start: el.value.length, end: el.value.length, supported: false };
}

function inputEvent(el: Element, inputType: string, data: string | null): void {
  const view = el.ownerDocument.defaultView ?? window;
  const event =
    typeof view.InputEvent === 'function'
      ? new view.InputEvent('input', { bubbles: true, composed: true, inputType, data })
      : new view.Event('input', { bubbles: true });
  el.dispatchEvent(event);
}

/**
 * Replace the range [start, end) of a text field with `text`.
 *
 * Writing through the prototype's native value setter (rather than
 * `el.value = ...`) and then dispatching an `input` event is what makes
 * framework-controlled fields (React and similar) notice the change.
 */
function replaceInField(el: HTMLInputElement | HTMLTextAreaElement, start: number, end: number, text: string): void {
  const next = el.value.slice(0, start) + text + el.value.slice(end);
  const set = nativeValueSetter(el);
  if (set) set(next);
  else el.value = next;
  try {
    el.setSelectionRange(start + text.length, start + text.length);
  } catch {
    /* selection not supported for this input type */
  }
  inputEvent(el, text ? 'insertText' : 'deleteContentBackward', text || null);
}

function textBeforeCaret(el: HTMLElement): string {
  const selection = el.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0 || !el.contains(selection.anchorNode)) return el.textContent ?? '';
  const range = selection.getRangeAt(0).cloneRange();
  range.collapse(true);
  range.setStart(el, 0);
  return range.toString();
}

function insertIntoEditable(el: HTMLElement, text: string): boolean {
  const doc = el.ownerDocument;
  const before = el.textContent ?? '';
  // execCommand keeps the editor's own undo history and fires the events rich editors expect.
  if (typeof doc.execCommand === 'function') {
    try {
      if (doc.execCommand('insertText', false, text) && (el.textContent ?? '') !== before) return true;
    } catch {
      /* fall through */
    }
  }
  const selection = doc.getSelection();
  if (!selection) return false;
  if (selection.rangeCount === 0 || !el.contains(selection.anchorNode)) {
    const range = doc.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const node = doc.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  inputEvent(el, 'insertText', text);
  return true;
}

/**
 * Types dictated text into the focused field and remembers what it typed, so
 * the most recent phrases can be removed again.
 */
export class TextEntry {
  private history: Insertion[] = [];

  /** The element that would receive text right now, if any. */
  target(): Element | null {
    const el = deepActiveElement();
    if (isTextField(el)) return el;
    if (isContentEditable(el)) return (el as Element).closest('[contenteditable]:not([contenteditable="false"])') ?? el;
    return null;
  }

  insert(phrase: string): InsertOutcome {
    const el = this.target();
    if (!el) {
      return { ok: false, reason: 'No text field is focused. Say "show fields", then the number of the field.' };
    }

    if (isTextField(el)) {
      const { start, end } = selectionOf(el);
      const text = joinDictation(el.value.slice(0, start), phrase).replace(el.tagName === 'INPUT' ? /\n+/g : /$^/, ' ');
      if (el.maxLength > 0 && el.value.length - (end - start) + text.length > el.maxLength) {
        return { ok: false, reason: 'That would exceed the length limit of this field.' };
      }
      replaceInField(el, start, end, text);
      this.remember(el, text);
      return { ok: true, inserted: text };
    }

    const editable = el as HTMLElement;
    const text = joinDictation(textBeforeCaret(editable), phrase);
    if (!insertIntoEditable(editable, text)) return { ok: false, reason: 'This editor did not accept the text.' };
    this.remember(editable, text);
    return { ok: true, inserted: text };
  }

  /**
   * Remove the last `count` dictated phrases. A phrase is only removed if it
   * is still exactly where it was typed; anything the user or the page has
   * changed since is left alone.
   */
  undo(count: number): { removed: number; reason?: string } {
    let removed = 0;
    for (let i = 0; i < count; i++) {
      const last = this.history.pop();
      if (!last) break;
      if (!last.element.isConnected) return { removed, reason: 'The field is no longer on the page.' };
      if (!this.removeTrailing(last)) {
        return { removed, reason: 'The text changed after it was dictated, so it was left as it is.' };
      }
      removed += 1;
    }
    return removed === 0 ? { removed, reason: 'There is no dictated text to remove.' } : { removed };
  }

  clearHistory(): void {
    this.history = [];
  }

  private remember(element: Element, text: string): void {
    this.history.push({ element, text });
    if (this.history.length > 100) this.history.shift();
  }

  private removeTrailing({ element, text }: Insertion): boolean {
    if (isTextField(element)) {
      const { start, supported } = selectionOf(element);
      const caret = supported ? start : element.value.length;
      // Prefer the phrase just before the caret; otherwise accept it at the very end.
      const at = element.value.slice(caret - text.length, caret) === text ? caret - text.length : element.value.endsWith(text) ? element.value.length - text.length : -1;
      if (at < 0) return false;
      replaceInField(element, at, at + text.length, '');
      return true;
    }
    const el = element as HTMLElement;
    const walker = el.ownerDocument.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
    let lastText: Text | null = null;
    while (walker.nextNode()) lastText = walker.currentNode as Text;
    if (!lastText || !lastText.data.endsWith(text)) return false;
    lastText.data = lastText.data.slice(0, lastText.data.length - text.length);
    const selection = el.ownerDocument.getSelection();
    if (selection) {
      const range = el.ownerDocument.createRange();
      range.setStart(lastText, lastText.data.length);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    inputEvent(el, 'deleteContentBackward', null);
    return true;
  }
}

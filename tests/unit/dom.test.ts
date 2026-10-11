// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { describeTarget, hintKind, interactiveAncestor, isEditable } from '../../src/agent/dom';
import { HintNumbering, collectHintTargets, placeLabels, type Box, type HintEnv } from '../../src/agent/hints';
import { TextEntry } from '../../src/agent/text';

/** jsdom has no layout engine, so tests declare each element's box with data-box="left,top,width,height". */
function env(viewport = { width: 1000, height: 800 }, covered: Element[] = []): HintEnv {
  const rect = (el: Element): Box => {
    const raw = el.getAttribute('data-box');
    const [left, top, width, height] = raw ? raw.split(',').map(Number) : [0, 0, 0, 0];
    return { left, top, width, height, right: left + width, bottom: top + height };
  };
  return {
    viewport: () => viewport,
    rect,
    style: (el) => {
      const s = (el as HTMLElement).style;
      return {
        display: s.display || 'block',
        visibility: s.visibility || 'visible',
        opacity: s.opacity || '1',
        pointerEvents: s.pointerEvents || 'auto',
      };
    },
    hitTest: (x, y) => {
      const boxed = Array.from(document.querySelectorAll('[data-box]')).filter((el) => {
        const b = rect(el);
        return x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
      });
      // Later in document order = on top; "covered" elements sit under an overlay.
      const top = boxed.reverse().find((el) => !covered.includes(el));
      return top ?? null;
    },
  };
}

const ids = (els: Element[]) => els.map((e) => e.id);

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('numbered element discovery', () => {
  it('finds visible interactive elements in reading order', () => {
    document.body.innerHTML = `
      <a id="l2" href="/b" data-box="300,10,80,20">B</a>
      <a id="l1" href="/a" data-box="10,10,80,20">A</a>
      <button id="b1" data-box="10,100,80,30">Go</button>
      <input id="i1" type="text" data-box="10,200,200,30" />
      <div id="d1" role="button" data-box="10,300,80,30">Role</div>
      <p id="p1" data-box="10,400,300,20">Just text</p>
    `;
    expect(ids(collectHintTargets(document, 'all', 100, env()))).toEqual(['l1', 'l2', 'b1', 'i1', 'd1']);
  });

  it('skips hidden, disabled, zero-size and off-screen elements', () => {
    document.body.innerHTML = `
      <button id="ok" data-box="10,10,80,30">OK</button>
      <button id="disabled" disabled data-box="10,60,80,30">X</button>
      <button id="aria" aria-disabled="true" data-box="10,110,80,30">X</button>
      <button id="none" style="display:none" data-box="10,160,80,30">X</button>
      <button id="invisible" style="visibility:hidden" data-box="10,210,80,30">X</button>
      <button id="clear" style="opacity:0" data-box="10,260,80,30">X</button>
      <div style="display:none"><button id="parentHidden" data-box="10,310,80,30">X</button></div>
      <div aria-hidden="true"><button id="ariaHidden" data-box="10,360,80,30">X</button></div>
      <button id="tiny" data-box="10,410,2,2">X</button>
      <button id="below" data-box="10,900,80,30">X</button>
      <button id="left" data-box="-200,10,80,30">X</button>
      <input id="hiddenInput" type="hidden" data-box="10,460,80,30" />
      <fieldset disabled><button id="inFieldset" data-box="10,510,80,30">X</button></fieldset>
    `;
    expect(ids(collectHintTargets(document, 'all', 100, env()))).toEqual(['ok']);
  });

  it('skips elements covered by something else', () => {
    document.body.innerHTML = `
      <button id="under" data-box="10,10,80,30">Under</button>
      <button id="free" data-box="10,100,80,30">Free</button>
      <div id="modal" data-box="0,0,200,60"></div>
    `;
    expect(ids(collectHintTargets(document, 'all', 100, env()))).toEqual(['free']);
  });

  it('includes elements that are only partly in view', () => {
    document.body.innerHTML = `<a id="edge" href="/x" data-box="950,790,100,40">Edge</a>`;
    expect(ids(collectHintTargets(document, 'all', 100, env()))).toEqual(['edge']);
  });

  it('filters by element type', () => {
    document.body.innerHTML = `
      <a id="link" href="/a" data-box="10,10,80,20">A</a>
      <button id="button" data-box="10,50,80,30">B</button>
      <input id="field" type="email" data-box="10,100,200,30" />
      <textarea id="area" data-box="10,150,200,60"></textarea>
      <select id="select" data-box="10,230,200,30"><option>1</option></select>
      <input id="check" type="checkbox" data-box="10,280,20,20" />
    `;
    expect(ids(collectHintTargets(document, 'links', 100, env()))).toEqual(['link']);
    expect(ids(collectHintTargets(document, 'buttons', 100, env()))).toEqual(['button', 'check']);
    expect(ids(collectHintTargets(document, 'fields', 100, env()))).toEqual(['field', 'area', 'select']);
  });

  it('limits the number of labels', () => {
    document.body.innerHTML = Array.from(
      { length: 50 },
      (_, i) => `<a id="a${i}" href="/${i}" data-box="10,${i * 14},80,12">${i}</a>`,
    ).join('');
    expect(collectHintTargets(document, 'all', 20, env())).toHaveLength(20);
  });

  it('gives a wrapper and its single child one number, not two', () => {
    document.body.innerHTML = `
      <div id="card" role="button" data-box="10,10,200,40">
        <a id="inner" href="/x" data-box="12,12,196,36">Open</a>
      </div>`;
    expect(ids(collectHintTargets(document, 'all', 100, env()))).toEqual(['inner']);
  });

  it('finds elements inside open shadow roots', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<button id="shadowed" data-box="10,10,80,30">In shadow</button>`;
    const e = env();
    const button = shadow.getElementById('shadowed')!;
    const found = collectHintTargets(document, 'all', 100, { ...e, hitTest: () => button });
    expect(ids(found)).toEqual(['shadowed']);
  });
});

describe('number assignment', () => {
  function setup() {
    document.body.innerHTML = `
      <a id="a" href="/a" data-box="10,10,80,20">A</a>
      <a id="b" href="/b" data-box="10,40,80,20">B</a>
      <a id="c" href="/c" data-box="10,70,80,20">C</a>`;
    return ['a', 'b', 'c'].map((id) => document.getElementById(id)!);
  }

  it('numbers targets from 1 and resolves a number back to its element', () => {
    const [a, b, c] = setup();
    const n = new HintNumbering();
    expect(n.assign([a, b, c]).map((x) => x.number)).toEqual([1, 2, 3]);
    expect(n.get(2)).toBe(b);
    expect(n.get(9)).toBeUndefined();
  });

  it('keeps numbers stable when the page changes', () => {
    const [a, b, c] = setup();
    const n = new HintNumbering();
    n.assign([a, b, c]);
    const d = document.createElement('a');
    // b disappears, d appears: a and c keep their numbers, 2 is not reused for d.
    const next = n.assign([a, d, c]);
    expect(next.find((x) => x.el === a)!.number).toBe(1);
    expect(next.find((x) => x.el === c)!.number).toBe(3);
    expect(next.find((x) => x.el === d)!.number).toBe(4);
    expect(n.get(2)).toBeUndefined();
  });

  it('starts again from 1 after a reset', () => {
    const [a, b] = setup();
    const n = new HintNumbering();
    n.assign([a, b]);
    n.reset();
    expect(n.assign([b]).map((x) => x.number)).toEqual([1]);
    expect(n.get(1)).toBe(b);
  });

  it('places labels at the target corner, inside the viewport', () => {
    document.body.innerHTML = `
      <a id="a" href="/a" data-box="100,50,80,20">A</a>
      <a id="b" href="/b" data-box="0,0,80,20">B</a>
      <a id="c" href="/c" data-box="995,795,80,20">C</a>`;
    const els = ['a', 'b', 'c'].map((id) => document.getElementById(id)!);
    const labels = placeLabels(new HintNumbering().assign(els), env());
    expect(labels[0]).toEqual({ number: 1, left: 96, top: 46 });
    expect(labels[1]).toEqual({ number: 2, left: 0, top: 0 });
    expect(labels[2].left).toBeLessThanOrEqual(1000 - 26);
    expect(labels[2].top).toBeLessThanOrEqual(800 - 18);
  });
});

describe('element classification', () => {
  it('finds the interactive ancestor of a nested node', () => {
    document.body.innerHTML = `<a id="a" href="/x"><span><b id="deep">text</b></span></a><p id="plain">p</p>`;
    expect(interactiveAncestor(document.getElementById('deep'))?.id).toBe('a');
    expect(interactiveAncestor(document.getElementById('plain'))).toBeNull();
  });

  it('treats disabled controls as not interactive', () => {
    document.body.innerHTML = `<button id="b" disabled><span id="s">x</span></button>`;
    expect(interactiveAncestor(document.getElementById('s'))).toBeNull();
  });

  it('classifies hint kinds', () => {
    document.body.innerHTML = `<a id="a" href="#">a</a><input id="t" /><input id="s" type="submit" /><div id="e" contenteditable="true"></div>`;
    expect(hintKind(document.getElementById('a')!)).toBe('links');
    expect(hintKind(document.getElementById('t')!)).toBe('fields');
    expect(hintKind(document.getElementById('s')!)).toBe('buttons');
    expect(hintKind(document.getElementById('e')!)).toBe('fields');
  });

  it('describes a click target for risk assessment', () => {
    document.body.innerHTML = `<form><input type="password" /><button id="b" type="submit">Sign in</button></form>`;
    expect(describeTarget(document.getElementById('b')!)).toEqual({
      tag: 'button',
      type: 'submit',
      role: '',
      label: 'Sign in',
      inForm: true,
      formSensitive: true,
    });
  });

  it('recognises editable elements', () => {
    document.body.innerHTML = `<input id="t" /><input id="c" type="checkbox" /><input id="r" readonly /><textarea id="a"></textarea><div id="e" contenteditable="true"></div><p id="p"></p>`;
    expect(isEditable(document.getElementById('t'))).toBe(true);
    expect(isEditable(document.getElementById('a'))).toBe(true);
    expect(isEditable(document.getElementById('e'))).toBe(true);
    expect(isEditable(document.getElementById('c'))).toBe(false);
    expect(isEditable(document.getElementById('r'))).toBe(false);
    expect(isEditable(document.getElementById('p'))).toBe(false);
  });
});

describe('dictation into fields', () => {
  function field<T extends HTMLElement>(html: string): T {
    document.body.innerHTML = html;
    const el = document.body.firstElementChild as T;
    el.focus();
    return el;
  }

  it('reports clearly when no field is focused', () => {
    document.body.innerHTML = `<p>text</p>`;
    const outcome = new TextEntry().insert('hello');
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toMatch(/No text field is focused/);
  });

  it('inserts at the caret and preserves existing text', () => {
    const input = field<HTMLInputElement>(`<input value="Hello world" />`);
    input.setSelectionRange(5, 5);
    const outcome = new TextEntry().insert('brave new');
    expect(outcome.ok).toBe(true);
    expect(input.value).toBe('Hello brave new world');
    expect(input.selectionStart).toBe(15);
  });

  it('replaces the current selection', () => {
    const input = field<HTMLInputElement>(`<input value="Hello world" />`);
    input.setSelectionRange(6, 11);
    new TextEntry().insert('there');
    expect(input.value).toBe('Hello there');
  });

  it('capitalises the first phrase and spaces later ones', () => {
    const area = field<HTMLTextAreaElement>(`<textarea></textarea>`);
    const entry = new TextEntry();
    entry.insert('the meeting is at noon.');
    entry.insert('bring the report');
    expect(area.value).toBe('The meeting is at noon. Bring the report');
  });

  it('fires an input event, so listeners see each change exactly once', () => {
    const input = field<HTMLInputElement>(`<input />`);
    const seen: string[] = [];
    input.addEventListener('input', () => seen.push(input.value));
    const entry = new TextEntry();
    entry.insert('one');
    entry.insert('two');
    expect(seen).toEqual(['One', 'One two']);
  });

  it('updates a framework-controlled field (value setter intercepted on the element)', () => {
    const input = field<HTMLInputElement>(`<input />`);
    // Mimic how React tracks controlled inputs: an own-property value setter records
    // what the framework last rendered, and an input event is ignored if nothing changed.
    const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!;
    let tracked = '';
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: () => native.get!.call(input),
      set: (v: string) => {
        tracked = v;
        native.set!.call(input, v);
      },
    });
    let state = '';
    input.addEventListener('input', () => {
      const actual = native.get!.call(input) as string;
      if (actual !== tracked) {
        tracked = actual;
        state = actual;
      }
    });
    new TextEntry().insert('hello');
    expect(state).toBe('Hello');
  });

  it('keeps multi-line text out of single-line inputs', () => {
    const input = field<HTMLInputElement>(`<input />`);
    new TextEntry().insert('line one\nline two');
    expect(input.value).toBe('Line one line two');
  });

  it('respects maxlength', () => {
    const input = field<HTMLInputElement>(`<input maxlength="5" />`);
    const outcome = new TextEntry().insert('far too long');
    expect(outcome.ok).toBe(false);
    expect(input.value).toBe('');
  });

  it('inserts into contenteditable elements', () => {
    const div = field<HTMLDivElement>(`<div contenteditable="true">Dear team</div>`);
    const range = document.createRange();
    range.selectNodeContents(div);
    range.collapse(false);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    let events = 0;
    div.addEventListener('input', () => events++);
    expect(new TextEntry().insert(', thank you').ok).toBe(true);
    expect(div.textContent).toBe('Dear team, thank you');
    expect(events).toBe(1);
  });

  it('removes the latest dictated phrase and nothing else', () => {
    const area = field<HTMLTextAreaElement>(`<textarea>Notes:</textarea>`);
    area.setSelectionRange(6, 6);
    const entry = new TextEntry();
    entry.insert('first point');
    entry.insert('second point');
    expect(area.value).toBe('Notes: first point second point');
    expect(entry.undo(1)).toEqual({ removed: 1 });
    expect(area.value).toBe('Notes: first point');
    expect(entry.undo(1)).toEqual({ removed: 1 });
    expect(area.value).toBe('Notes:');
    expect(entry.undo(1).removed).toBe(0);
  });

  it('removes several phrases at once when clearing the draft', () => {
    const area = field<HTMLTextAreaElement>(`<textarea></textarea>`);
    const entry = new TextEntry();
    for (const p of ['one', 'two', 'three']) entry.insert(p);
    expect(entry.undo(3)).toEqual({ removed: 3 });
    expect(area.value).toBe('');
  });

  it('leaves text alone if it was edited after dictation', () => {
    const input = field<HTMLInputElement>(`<input />`);
    const entry = new TextEntry();
    entry.insert('hello world');
    input.value = 'Hello world, edited by hand';
    const result = entry.undo(1);
    expect(result.removed).toBe(0);
    expect(result.reason).toMatch(/changed/);
    expect(input.value).toBe('Hello world, edited by hand');
  });

  it('undoes dictated text in contenteditable elements', () => {
    const div = field<HTMLDivElement>(`<div contenteditable="true"></div>`);
    const entry = new TextEntry();
    entry.insert('first');
    entry.insert('second');
    expect(div.textContent).toBe('First second');
    entry.undo(1);
    expect(div.textContent).toBe('First');
  });

  it('does not type into read-only or non-text inputs', () => {
    field<HTMLInputElement>(`<input readonly value="fixed" />`);
    expect(new TextEntry().insert('x').ok).toBe(false);
    field<HTMLInputElement>(`<input type="checkbox" />`);
    expect(new TextEntry().insert('x').ok).toBe(false);
  });
});

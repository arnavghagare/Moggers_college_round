import { describe, expect, it } from 'vitest';
import { GESTURES, HAND_POSE_PRIORITY, defaultGestureConfigs } from '../../src/core/gestures/registry';
import { ACTIONS, ACTION_IDS, isActionId } from '../../src/shared/actions';
import {
  parseAgentToEngine,
  parseClientToEngine,
  parseEngineControl,
  parseWorkerRequest,
} from '../../src/shared/messages';
import {
  DEFAULT_SETTINGS,
  applyPatch,
  needsCamera,
  needsFaceModel,
  needsHandModel,
  sanitizeSettings,
} from '../../src/shared/settings';

describe('message validation', () => {
  it('accepts well-formed page-agent messages', () => {
    expect(parseAgentToEngine({ t: 'hello', kind: 'content', href: 'https://example.com/' })).toEqual({
      t: 'hello',
      kind: 'content',
      href: 'https://example.com/',
    });
    expect(parseAgentToEngine({ t: 'event', name: 'click', detail: 'Next' })).toMatchObject({ t: 'event', name: 'click' });
    expect(parseAgentToEngine({ t: 'confirm-answer', id: 'c1', ok: true })).toEqual({ t: 'confirm-answer', id: 'c1', ok: true });
  });

  it('rejects malformed or unknown page-agent messages', () => {
    for (const bad of [
      null,
      'click',
      42,
      {},
      { t: 'do', action: 'click' },
      { t: 'event', name: 'run-script' },
      { t: 'hello', kind: 'admin', href: 'x' },
      { t: 'confirm-request', id: 'c1' },
      { t: 'confirm-request', id: 'c1', prompt: 'x'.repeat(5000) },
      { t: 'confirm-answer', id: 'c1', ok: 'yes' },
      { t: 'visibility', visible: 1, focused: 0 },
    ]) {
      expect(parseAgentToEngine(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('only lets a client run actions from the closed action list', () => {
    expect(parseClientToEngine({ t: 'action', action: 'scroll_down' })).toMatchObject({ t: 'action', action: 'scroll_down' });
    expect(parseClientToEngine({ t: 'action', action: 'eval' })).toBeNull();
    expect(parseClientToEngine({ t: 'action', action: '__proto__' })).toBeNull();
    expect(parseClientToEngine({ t: 'action', action: 'constructor' })).toBeNull();
  });

  it('sanitises action parameters', () => {
    const msg = parseClientToEngine({
      t: 'action',
      action: 'click_number',
      params: { number: 7.9, text: 5, key: 'x'.repeat(100), filter: 'everything', extra: 'ignored' },
    });
    expect(msg).toEqual({ t: 'action', action: 'click_number', params: { number: 7 } });
  });

  it('validates speech events relayed from a dashboard tab', () => {
    expect(parseClientToEngine({ t: 'voice-event', event: { kind: 'final', text: 'go back', confidence: 0.8, alternatives: ['go back', 3] } })).toEqual({
      t: 'voice-event',
      event: { kind: 'final', text: 'go back', confidence: 0.8, alternatives: ['go back'] },
    });
    expect(parseClientToEngine({ t: 'voice-event', event: { kind: 'final' } })).toBeNull();
    expect(parseClientToEngine({ t: 'voice-event', event: { kind: 'mic', state: 'hot' } })).toBeNull();
  });

  it('validates requests to the service worker', () => {
    expect(parseWorkerRequest({ type: 'hf/enable' })).toEqual({ type: 'hf/enable' });
    expect(parseWorkerRequest({ type: 'hf/browser', cmd: 'switchTab', number: 2.7 })).toEqual({
      type: 'hf/browser',
      cmd: 'switchTab',
      number: 2,
      text: undefined,
    });
    expect(parseWorkerRequest({ type: 'hf/browser', cmd: 'evaluate', text: 'alert(1)' })).toBeNull();
    expect(parseAgentToEngine({ t: 'open-tab', url: 'https://example.com/a' })).toEqual({ t: 'open-tab', url: 'https://example.com/a' });
    expect(parseAgentToEngine({ t: 'open-tab', url: 'javascript:alert(1)' })).toBeNull();
    expect(parseAgentToEngine({ t: 'open-tab', url: 'chrome://settings' })).toBeNull();
    expect(parseWorkerRequest({ type: 'hf/settings-patch', patch: 'x' })).toBeNull();
    expect(parseWorkerRequest({ type: 'hf/unknown' })).toBeNull();
    expect(parseWorkerRequest(undefined)).toBeNull();
  });

  it('validates control messages to the engine', () => {
    expect(parseEngineControl({ type: 'hf/engine', kind: 'shutdown' })).toEqual({ type: 'hf/engine', kind: 'shutdown' });
    expect(parseEngineControl({ type: 'hf/engine', kind: 'action', action: 'toggle_pause' })).toMatchObject({ action: 'toggle_pause' });
    expect(parseEngineControl({ type: 'hf/engine', kind: 'action', action: 'nope' })).toBeNull();
    expect(parseEngineControl({ type: 'hf/engine', kind: 'active-tab', info: { tabId: 'x', controllable: 'yes' } })).toEqual({
      type: 'hf/engine',
      kind: 'active-tab',
      info: { tabId: null, controllable: false, reason: '' },
    });
    expect(parseEngineControl({ type: 'other' })).toBeNull();
  });
});

describe('settings', () => {
  it('returns defaults for missing or malformed storage', () => {
    for (const bad of [undefined, null, 'x', 7, [], { cursor: 'big' }]) {
      expect(sanitizeSettings(bad)).toEqual(DEFAULT_SETTINGS);
    }
  });

  it('clamps numbers and rejects unknown options', () => {
    const s = sanitizeSettings({
      controlMode: 'telepathy',
      cursor: { sensitivity: 99, smoothing: -4, deadZone: 1, size: 5000, color: 'javascript:1', dynamics: 'warp' },
      click: { dwellMs: 1, confirmPolicy: 'maybe' },
      safety: { graceMs: 0, autoPauseMs: 5 },
      voice: { lang: '<script>', minConfidence: 7, mode: 'shout' },
    });
    expect(s.controlMode).toBe('head');
    expect(s.cursor).toMatchObject({ sensitivity: 3, smoothing: 0, deadZone: 0.05, size: 96, color: DEFAULT_SETTINGS.cursor.color, dynamics: 'absolute' });
    expect(s.click).toMatchObject({ dwellMs: 400, confirmPolicy: 'risky' });
    expect(s.safety.graceMs).toBe(1000);
    expect(s.safety.autoPauseMs).toBe(1500);
    expect(s.voice).toMatchObject({ lang: 'en-US', minConfidence: 0.95, mode: 'always' });
  });

  it('never lets the grace period or automatic pause be disabled', () => {
    const s = sanitizeSettings({ safety: { graceMs: -1, autoPauseMs: Infinity } });
    expect(s.safety.graceMs).toBeGreaterThanOrEqual(1000);
    expect(Number.isFinite(s.safety.autoPauseMs)).toBe(true);
  });

  it('ignores unknown keys and unknown gestures', () => {
    const s = sanitizeSettings({ evil: true, gestures: { made_up: { enabled: true, action: 'click' } } }) as unknown as Record<string, unknown>;
    expect(s.evil).toBeUndefined();
    expect((s.gestures as Record<string, unknown>).made_up).toBeUndefined();
  });

  it('repairs gesture configuration', () => {
    const s = sanitizeSettings({ gestures: { pinch: { action: 'format_disk', threshold: 0.6, releaseThreshold: 0.9, cooldownMs: -5 } } });
    expect(s.gestures.pinch.action).toBe('click');
    expect(s.gestures.pinch.releaseThreshold).toBeLessThanOrEqual(s.gestures.pinch.threshold);
    expect(s.gestures.pinch.cooldownMs).toBe(0);
  });

  it('applies deep patches without touching other values', () => {
    const s = applyPatch(DEFAULT_SETTINGS, { cursor: { sensitivity: 1.5 }, gestures: { fist: { enabled: false } } });
    expect(s.cursor.sensitivity).toBe(1.5);
    expect(s.cursor.smoothing).toBe(DEFAULT_SETTINGS.cursor.smoothing);
    expect(s.gestures.fist.enabled).toBe(false);
    expect(s.gestures.fist.action).toBe('hold_cursor');
    expect(s.gestures.pinch).toEqual(DEFAULT_SETTINGS.gestures.pinch);
  });

  it('accepts a valid calibration and drops a broken one', () => {
    const axis = { neutral: 0, pos: 10, neg: -10 };
    const good = { pose: { x: axis, y: axis }, position: { x: axis, y: axis }, quality: 0.8, createdAt: 5 };
    expect(sanitizeSettings({ calibration: good }).calibration).toEqual(good);
    expect(sanitizeSettings({ calibration: { ...good, pose: { x: axis } } }).calibration).toBeNull();
    expect(sanitizeSettings({ calibration: { ...good, quality: 'high' } }).calibration).toBeNull();
    expect(applyPatch(sanitizeSettings({ calibration: good }), { calibration: null }).calibration).toBeNull();
  });

  it('only uses the camera and each model when something needs them', () => {
    const voiceOnly = applyPatch(DEFAULT_SETTINGS, { controlMode: 'voice', features: { handGestures: false, faceGestures: false } });
    expect(needsCamera(voiceOnly)).toBe(false);
    const head = applyPatch(DEFAULT_SETTINGS, { controlMode: 'head' });
    expect(needsFaceModel(head)).toBe(true);
    expect(needsHandModel(head)).toBe(false);
    const hand = applyPatch(DEFAULT_SETTINGS, { controlMode: 'hand' });
    expect(needsFaceModel(hand)).toBe(false);
    expect(needsHandModel(hand)).toBe(true);
  });
});

describe('registries', () => {
  it('every gesture has a complete, consistent definition', () => {
    const ids = new Set<string>();
    for (const g of GESTURES) {
      expect(ids.has(g.id), g.id).toBe(false);
      ids.add(g.id);
      expect(g.name.length).toBeGreaterThan(2);
      expect(g.description.length).toBeGreaterThan(10);
      expect(g.requires.length).toBeGreaterThan(5);
      expect(isActionId(g.defaults.action), g.id).toBe(true);
      expect(g.defaults.releaseThreshold).toBeLessThanOrEqual(g.defaults.threshold);
      // A gesture without a held state cannot drive a held action.
      if (g.oneshotOnly) expect(ACTIONS[g.defaults.action].kind, g.id).toBe('oneshot');
    }
    for (const id of HAND_POSE_PRIORITY) expect(ids.has(id), id).toBe(true);
    expect(Object.keys(defaultGestureConfigs()).sort()).toEqual([...ids].sort());
  });

  it('facial gestures and inferred gestures start switched off', () => {
    for (const g of GESTURES) {
      if (g.kind === 'face' || g.id === 'hand_push') expect(g.defaults.enabled, g.id).toBe(false);
    }
  });

  it('includes every gesture the product requires', () => {
    const ids = GESTURES.map((g) => g.id);
    for (const required of ['open_palm', 'point', 'pinch', 'pinch_hold', 'two_fingers', 'three_fingers', 'fist', 'grab', 'swipe_left', 'swipe_right', 'swipe_up', 'swipe_down', 'thumbs_up', 'thumbs_down', 'hand_raise', 'two_hand_spread', 'blink_long', 'double_blink', 'brow_raise', 'mouth_open', 'smile']) {
      expect(ids, required).toContain(required);
    }
  });

  it('actions that are destructive require confirmation and are never fuzzy-safe', () => {
    for (const id of ACTION_IDS) {
      const def = ACTIONS[id];
      if (def.risk === 'high') expect('confirm' in def && def.confirm, id).toBe(true);
    }
  });

  it('nothing that touches the page is allowed while paused', () => {
    const pageActions = ['click', 'double_click', 'right_click', 'drag_start', 'scroll_up', 'scroll_down', 'click_number', 'press_key', 'type_text', 'go_back', 'reload', 'close_tab', 'new_tab', 'start_dictation'] as const;
    for (const id of pageActions) {
      const def = ACTIONS[id];
      expect('allowedWhilePaused' in def && def.allowedWhilePaused, id).toBeFalsy();
      expect('allowedDuringGrace' in def && def.allowedDuringGrace, id).toBeFalsy();
    }
  });
});

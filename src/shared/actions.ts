/**
 * The closed set of things Handsfree can do. Gestures and voice commands can
 * only ever resolve to one of these ids: recognised text is never executed.
 */

export type ActionRisk = 'none' | 'low' | 'medium' | 'high';

export interface ActionDefinition {
  label: string;
  /** `hold` actions stay in effect while a gesture is held; `oneshot` fire once. */
  kind: 'oneshot' | 'hold';
  risk: ActionRisk;
  /** Can be assigned to a gesture in the UI. */
  assignable: boolean;
  /** Needs explicit confirmation when triggered by voice or gesture. */
  confirm?: boolean;
  /** Still allowed while Handsfree is paused. */
  allowedWhilePaused?: boolean;
  /** Not an interaction with the page, so allowed during the startup grace period. */
  allowedDuringGrace?: boolean;
}

const def = (
  label: string,
  kind: 'oneshot' | 'hold',
  risk: ActionRisk,
  extra: Partial<ActionDefinition> = {},
): ActionDefinition => ({ label, kind, risk, assignable: true, ...extra });

const SYSTEM = { allowedWhilePaused: true, allowedDuringGrace: true } as const;
const SETUP = { allowedDuringGrace: true } as const;

export const ACTIONS = {
  none: def('No action', 'oneshot', 'none', SYSTEM),

  // Pointer
  move_cursor: def('Move the cursor (while held)', 'hold', 'none', SETUP),
  hold_cursor: def('Freeze the cursor (while held)', 'hold', 'none', SETUP),
  click: def('Click', 'oneshot', 'low'),
  double_click: def('Double click', 'oneshot', 'low'),
  right_click: def('Right click', 'oneshot', 'low'),
  drag: def('Drag (while held)', 'hold', 'low'),
  drag_start: def('Start dragging', 'oneshot', 'low'),
  drag_end: def('Release drag', 'oneshot', 'low', { allowedWhilePaused: true }),
  scroll: def('Scroll with hand movement (while held)', 'hold', 'none'),
  scroll_up: def('Scroll up', 'oneshot', 'none'),
  scroll_down: def('Scroll down', 'oneshot', 'none'),
  scroll_top: def('Scroll to top', 'oneshot', 'none'),
  scroll_bottom: def('Scroll to bottom', 'oneshot', 'none'),
  scroll_auto_down: def('Keep scrolling down', 'oneshot', 'none'),
  scroll_auto_up: def('Keep scrolling up', 'oneshot', 'none'),
  scroll_stop: def('Stop scrolling', 'oneshot', 'none', { allowedWhilePaused: true }),

  // Browser
  go_back: def('Go back', 'oneshot', 'medium'),
  go_forward: def('Go forward', 'oneshot', 'medium'),
  reload: def('Reload page', 'oneshot', 'medium'),
  new_tab: def('Open new tab', 'oneshot', 'low'),
  close_tab: def('Close tab', 'oneshot', 'high', { confirm: true }),
  next_tab: def('Next tab', 'oneshot', 'low'),
  prev_tab: def('Previous tab', 'oneshot', 'low'),
  switch_tab: def('Switch to tab number', 'oneshot', 'low', { assignable: false }),
  zoom_in: def('Zoom in', 'oneshot', 'none'),
  zoom_out: def('Zoom out', 'oneshot', 'none'),
  zoom_reset: def('Reset zoom', 'oneshot', 'none', { assignable: false }),
  search: def('Search the web', 'oneshot', 'low', { assignable: false }),
  search_new_tab: def('Open a new tab and search', 'oneshot', 'low', { assignable: false }),
  search_here: def('Search in this tab', 'oneshot', 'low', { assignable: false }),
  browser_settings: def('Open browser settings', 'oneshot', 'low', { assignable: false }),
  incognito_window: def('Open an incognito window', 'oneshot', 'low', { assignable: false }),
  open_site: def('Open a site in a new tab', 'oneshot', 'low', { assignable: false }),
  navigate_site: def('Go to a site', 'oneshot', 'medium', { assignable: false }),
  duplicate_tab: def('Duplicate tab', 'oneshot', 'low'),

  // Media
  media_play: def('Play video', 'oneshot', 'none'),
  media_pause: def('Pause video', 'oneshot', 'none'),
  media_toggle: def('Play / pause video', 'oneshot', 'none'),
  media_mute: def('Mute video', 'oneshot', 'none'),
  media_unmute: def('Unmute video', 'oneshot', 'none'),

  // Numbered hints
  show_numbers: def('Show numbers', 'oneshot', 'none'),
  hide_numbers: def('Hide numbers', 'oneshot', 'none', { allowedWhilePaused: true }),
  toggle_numbers: def('Toggle numbers', 'oneshot', 'none'),
  click_number: def('Click numbered element', 'oneshot', 'low', { assignable: false }),
  click_text: def('Click an element by its name', 'oneshot', 'low', { assignable: false }),

  // Keys
  press_key: def('Press a key', 'oneshot', 'low', { assignable: false }),

  // Modes and system
  switch_mode: def('Switch control mode', 'oneshot', 'none', SETUP),
  use_head: def('Use head control', 'oneshot', 'none', SETUP),
  use_hand: def('Use hand control', 'oneshot', 'none', SETUP),
  use_voice: def('Use voice only', 'oneshot', 'none', { ...SYSTEM, assignable: false }),
  toggle_pause: def('Pause / resume Handsfree', 'oneshot', 'none', SYSTEM),
  pause: def('Pause Handsfree', 'oneshot', 'none', SYSTEM),
  resume: def('Resume Handsfree', 'oneshot', 'none', SYSTEM),
  recenter: def('Recentre the cursor', 'oneshot', 'none', SETUP),
  recalibrate: def('Recalibrate', 'oneshot', 'none', SYSTEM),
  show_settings: def('Show settings', 'oneshot', 'none', SYSTEM),
  show_help: def('Show what you can say', 'oneshot', 'none', SYSTEM),
  hide_help: def('Hide help', 'oneshot', 'none', SYSTEM),
  exit: def('Turn Handsfree off', 'oneshot', 'high', { ...SYSTEM, confirm: true, assignable: false }),

  // Voice
  toggle_listening: def('Toggle voice listening', 'oneshot', 'none', SYSTEM),
  stop_listening: def('Stop listening', 'oneshot', 'none', { ...SYSTEM, assignable: false }),
  start_dictation: def('Start dictation', 'oneshot', 'none'),
  stop_dictation: def('Stop dictation', 'oneshot', 'none', SYSTEM),
  undo_dictation: def('Remove last dictated phrase', 'oneshot', 'low', { assignable: false }),
  clear_dictation: def('Clear dictated draft', 'oneshot', 'high', { confirm: true, assignable: false }),
  type_text: def('Type text', 'oneshot', 'low', { assignable: false }),

  // Confirmation
  confirm: def('Confirm', 'oneshot', 'none', SYSTEM),
  cancel: def('Cancel', 'oneshot', 'none', SYSTEM),
} as const satisfies Record<string, ActionDefinition>;

export type ActionId = keyof typeof ACTIONS;

export const ACTION_IDS = Object.keys(ACTIONS) as ActionId[];

export function isActionId(value: unknown): value is ActionId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ACTIONS, value);
}

export function actionDef(id: ActionId): ActionDefinition {
  return ACTIONS[id];
}

export function actionLabel(id: string): string {
  return isActionId(id) ? ACTIONS[id].label : id;
}

export type HintFilter = 'all' | 'links' | 'buttons' | 'fields';

export interface ActionParams {
  number?: number;
  text?: string;
  key?: string;
  amount?: number;
  filter?: HintFilter;
}

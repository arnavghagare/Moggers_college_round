import { ACTIONS, type ActionId, type ActionParams, type ActionRisk } from '../../shared/actions';

/**
 * The voice command registry. Speech is matched against the phrases listed
 * here and nothing else; a transcript can only ever select one of these
 * entries, never run arbitrary text.
 */
export interface VoiceCommand {
  id: string;
  /** The phrase shown in the command list. */
  canonical: string;
  /** Other accepted wordings (already normalized: lower case, no punctuation). */
  alternatives: string[];
  action: ActionId;
  params?: ActionParams;
  group: 'Navigation' | 'Pointer' | 'Numbers' | 'Media' | 'Modes' | 'Text entry' | 'System';
  risk: ActionRisk;
  /** Ask "confirm or cancel?" before executing. */
  confirm: boolean;
  /** Whether a near-miss transcript may select this command. Never true for risky commands. */
  fuzzy: boolean;
  /** Still recognised while dictating (the rest are typed as text). */
  inDictation?: boolean;
  /** Shown in the list with a parameter, e.g. "click 14". */
  example?: string;
}

type Group = VoiceCommand['group'];

function cmd(
  group: Group,
  action: ActionId,
  canonical: string,
  alternatives: string[] = [],
  extra: Partial<VoiceCommand> = {},
): VoiceCommand {
  const def = ACTIONS[action];
  const risk = def.risk;
  const confirm = 'confirm' in def && def.confirm === true;
  return {
    id: extra.id ?? action,
    canonical,
    alternatives,
    action,
    group,
    risk,
    confirm,
    // Safe default: only harmless commands tolerate recognition mistakes.
    fuzzy: risk === 'none' && !confirm,
    ...extra,
  };
}

export const VOICE_COMMANDS: VoiceCommand[] = [
  // ---- Navigation ----
  cmd('Navigation', 'go_back', 'go back', ['back', 'previous page', 'navigate back'], { fuzzy: true }),
  cmd('Navigation', 'go_forward', 'go forward', ['forward', 'next page', 'navigate forward'], { fuzzy: true }),
  cmd('Navigation', 'reload', 'reload page', ['reload', 'refresh', 'refresh page', 'reload the page']),
  cmd('Navigation', 'scroll_down', 'scroll down', ['page down', 'down', 'scroll lower', 'move down']),
  cmd('Navigation', 'scroll_up', 'scroll up', ['page up', 'up', 'scroll higher', 'move up']),
  cmd('Navigation', 'scroll_top', 'scroll to top', [
    'go to top',
    'top of page',
    'go to beginning',
    'go to the beginning',
    'scroll to the top',
    'go to the top',
    'beginning',
  ]),
  cmd('Navigation', 'scroll_bottom', 'scroll to bottom', [
    'go to bottom',
    'bottom of page',
    'go to end',
    'go to the end',
    'scroll to the bottom',
    'go to the bottom',
  ]),
  cmd('Navigation', 'scroll_down', 'scroll down a little', ['little down', 'down a bit', 'scroll down a bit'], { id: 'scroll_down_little', params: { amount: 0.35 } }),
  cmd('Navigation', 'scroll_up', 'scroll up a little', ['little up', 'up a bit', 'scroll up a bit'], { id: 'scroll_up_little', params: { amount: 0.35 } }),
  cmd('Navigation', 'scroll_down', 'scroll down a lot', ['way down', 'scroll way down'], { id: 'scroll_down_lot', params: { amount: 3 } }),
  cmd('Navigation', 'scroll_up', 'scroll up a lot', ['way up', 'scroll way up'], { id: 'scroll_up_lot', params: { amount: 3 } }),
  cmd('Navigation', 'scroll_auto_down', 'keep scrolling', ['auto scroll', 'autoscroll', 'keep scrolling down', 'start scrolling']),
  cmd('Navigation', 'scroll_auto_up', 'keep scrolling up', ['auto scroll up', 'start scrolling up']),
  cmd('Navigation', 'scroll_stop', 'stop scrolling', ['stop scroll', 'stop auto scroll']),
  cmd('Navigation', 'new_tab', 'open new tab', ['new tab', 'open a new tab', 'open tab', 'go home', 'home']),
  cmd('Navigation', 'duplicate_tab', 'duplicate tab', ['duplicate this tab', 'copy tab']),
  cmd('Navigation', 'close_tab', 'close tab', ['close this tab', 'close the tab']),
  cmd('Navigation', 'next_tab', 'switch tab', ['next tab', 'switch tabs', 'switch to next tab']),
  cmd('Navigation', 'prev_tab', 'previous tab', ['last tab', 'switch to previous tab']),
  cmd('Navigation', 'zoom_in', 'zoom in', ['bigger', 'make it bigger']),
  cmd('Navigation', 'zoom_out', 'zoom out', ['smaller', 'make it smaller']),
  cmd('Navigation', 'zoom_reset', 'reset zoom', ['normal size', 'actual size']),

  // ---- Pointer ----
  cmd('Pointer', 'click', 'click', ['click here', 'click that', 'select', 'tap']),
  cmd('Pointer', 'double_click', 'double click', ['double tap']),
  cmd('Pointer', 'right_click', 'right click', ['context menu', 'open context menu']),
  cmd('Pointer', 'cancel', 'cancel click', ['cancel', 'never mind', 'nevermind', 'no', 'cancel that'], {
    id: 'cancel',
    inDictation: false,
  }),
  cmd('Pointer', 'drag_start', 'start dragging', ['start drag', 'drag', 'grab', 'hold', 'pick up']),
  cmd('Pointer', 'drag_end', 'release', ['drop', 'let go', 'stop dragging', 'release drag']),
  cmd('Pointer', 'recenter', 'recenter', ['center cursor', 'recentre', 'reset cursor', 'center the cursor', 'centre cursor']),

  // ---- Media ----
  cmd('Media', 'media_play', 'play video', ['play', 'play the video', 'resume video', 'play music']),
  cmd('Media', 'media_pause', 'pause video', ['pause the video', 'stop video', 'pause music', 'stop the video']),
  cmd('Media', 'media_mute', 'mute video', ['mute sound', 'mute audio', 'mute the video']),
  cmd('Media', 'media_unmute', 'unmute video', ['unmute sound', 'unmute audio', 'unmute the video']),

  // ---- Numbers ----
  cmd('Numbers', 'show_numbers', 'show numbers', ['numbers', 'show labels', 'show hints', 'number the page']),
  cmd('Numbers', 'show_numbers', 'show links', ['number links', 'show link numbers'], {
    id: 'show_links',
    params: { filter: 'links' },
  }),
  cmd('Numbers', 'show_numbers', 'show buttons', ['number buttons', 'show button numbers'], {
    id: 'show_buttons',
    params: { filter: 'buttons' },
  }),
  cmd('Numbers', 'show_numbers', 'show fields', ['show inputs', 'show text fields', 'show text boxes', 'show form fields'], {
    id: 'show_fields',
    params: { filter: 'fields' },
  }),
  cmd('Numbers', 'hide_numbers', 'hide numbers', ['hide labels', 'hide hints', 'remove numbers', 'clear numbers']),

  // ---- Modes ----
  cmd('Modes', 'use_head', 'use head control', ['head control', 'head mode', 'switch to head control', 'use my head']),
  cmd('Modes', 'use_hand', 'use hand control', ['hand control', 'hand mode', 'switch to hand control', 'use my hand']),
  cmd('Modes', 'use_voice', 'use voice mode', ['voice only', 'voice mode', 'use voice only', 'use voice control', 'voice control']),
  cmd('Modes', 'switch_mode', 'switch control mode', ['switch mode', 'change mode', 'change control mode', 'next mode']),
  cmd('Modes', 'recalibrate', 'recalibrate', ['calibrate', 'start calibration', 'run calibration']),
  cmd('Modes', 'show_settings', 'show settings', ['open settings', 'settings', 'open handsfree', 'show dashboard', 'open dashboard']),

  // ---- Text entry ----
  cmd('Text entry', 'press_key', 'next field', ['next box', 'next input'], { id: 'next_field', params: { key: 'Tab' } }),
  cmd('Text entry', 'press_key', 'previous field', ['previous box', 'last field'], { id: 'previous_field', params: { key: 'ShiftTab' } }),
  cmd('Text entry', 'start_dictation', 'start dictation', ['dictate', 'begin dictation', 'start typing', 'dictation on']),
  cmd('Text entry', 'stop_dictation', 'stop dictation', ['end dictation', 'stop typing', 'dictation off', 'finish dictation'], {
    inDictation: true,
  }),
  cmd('Text entry', 'undo_dictation', 'undo that', ['scratch that', 'delete that', 'remove that'], { inDictation: true }),
  cmd('Text entry', 'clear_dictation', 'clear dictated draft', ['clear draft', 'clear dictation', 'delete everything i said'], {
    inDictation: true,
  }),

  // ---- System ----
  cmd('System', 'pause', 'pause handsfree', ['pause', 'stop', 'freeze', 'stop handsfree', 'hold on'], {
    inDictation: true,
  }),
  cmd('System', 'resume', 'resume handsfree', ['resume', 'continue', 'unpause', 'carry on']),
  cmd('System', 'stop_listening', 'stop listening', ['mute', 'stop voice', 'go to sleep'], { inDictation: true }),
  cmd('System', 'show_help', 'what can i say', ['help', 'show commands', 'show help', 'show command list', 'commands', 'help me']),
  cmd('System', 'hide_help', 'hide help', ['close help', 'hide commands', 'close commands']),
  cmd('System', 'confirm', 'confirm', ['yes', 'do it', 'confirmed', 'okay', 'ok']),
  cmd('System', 'exit', 'turn off handsfree', ['exit handsfree', 'quit handsfree']),
];

/** Commands with a spoken parameter. Matched by pattern, listed here for the command list. */
export const PARAMETER_COMMANDS: Array<{
  group: Group;
  canonical: string;
  example: string;
  description: string;
}> = [
  { group: 'Numbers', canonical: 'click <number>', example: 'click 14', description: 'Click the element with that number' },
  { group: 'Pointer', canonical: 'click <name>', example: 'click sign in', description: 'Click a link or button by what it says' },
  { group: 'Navigation', canonical: 'open <site>', example: 'open youtube', description: 'Open a site in a new tab' },
  { group: 'Navigation', canonical: 'go to <site>', example: 'go to wikipedia dot org', description: 'Load a site in this tab' },
  { group: 'Navigation', canonical: 'switch to tab <number>', example: 'switch to tab 3', description: 'Activate a tab by position' },
  { group: 'Navigation', canonical: 'search for <words>', example: 'search for train times', description: 'Search the web in a new tab' },
  { group: 'Text entry', canonical: 'type <words>', example: 'type hello world', description: 'Type into the focused field once' },
  { group: 'Text entry', canonical: 'press <key>', example: 'press enter', description: 'Enter, tab, escape, space, backspace or an arrow key' },
];

export const PRESSABLE_KEYS: Record<string, string> = {
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  escape: 'Escape',
  space: ' ',
  backspace: 'Backspace',
  delete: 'Delete',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  'arrow up': 'ArrowUp',
  'arrow down': 'ArrowDown',
  'arrow left': 'ArrowLeft',
  'arrow right': 'ArrowRight',
  home: 'Home',
  end: 'End',
};

/** Phrase -> command lookup, built once. */
export const PHRASE_INDEX: Map<string, VoiceCommand> = (() => {
  const index = new Map<string, VoiceCommand>();
  for (const command of VOICE_COMMANDS) {
    for (const phrase of [command.canonical, ...command.alternatives]) {
      if (index.has(phrase)) throw new Error(`Duplicate voice phrase: "${phrase}"`);
      index.set(phrase, command);
    }
  }
  return index;
})();

/** The short list shown on the page for "what can I say". */
export const HELP_SECTIONS: Array<{ title: string; phrases: string[] }> = [
  { title: 'Click', phrases: ['click', 'show numbers', 'click 7', 'click sign in', 'double click', 'right click'] },
  { title: 'Move around', phrases: ['scroll down', 'scroll up', 'keep scrolling', 'stop scrolling', 'scroll to top'] },
  { title: 'Sites and tabs', phrases: ['open youtube', 'go to wikipedia', 'search for cats', 'go back', 'open new tab', 'switch tab', 'close tab'] },
  { title: 'Type', phrases: ['show fields', 'start dictation', 'stop dictation', 'undo that', 'type hello', 'press enter'] },
  { title: 'Video', phrases: ['play video', 'pause video', 'mute video'] },
  { title: 'Modes', phrases: ['use head control', 'use hand control', 'use voice mode', 'recalibrate', 'recenter'] },
  { title: 'Stop', phrases: ['stop', 'resume', 'stop listening', 'turn off handsfree', 'hide help'] },
];

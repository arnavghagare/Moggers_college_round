/**
 * Best-effort detection of high-impact click targets, so the user can be
 * asked to confirm first. This is a heuristic over the element's own text and
 * attributes: it cannot recognise every dangerous control on every website,
 * and Handsfree does not claim that it does.
 */

export interface ClickTargetInfo {
  tag: string;
  /** `type` attribute for inputs and buttons. */
  type: string;
  role: string;
  /** Visible text, aria-label, value or title. */
  label: string;
  /** Inside a form (so a submit button would send it). */
  inForm: boolean;
  /** The form contains a password or payment field. */
  formSensitive: boolean;
}

export type ClickRisk =
  | { risky: false }
  | { risky: true; kind: 'destructive' | 'purchase' | 'submit' | 'account'; prompt: string };

const DESTRUCTIVE = /\b(delete|remove|erase|destroy|discard|wipe|clear all|reset|unsubscribe|deactivate|close account|cancel (?:subscription|order|membership|plan))\b/i;
const PURCHASE = /\b(buy|purchase|pay|checkout|check out|place (?:your )?order|order now|subscribe|donate|confirm (?:order|payment|purchase)|complete (?:order|purchase))\b/i;
const ACCOUNT = /\b(sign out|log out|logout|signout)\b/i;
const SUBMIT = /\b(submit|send|post|publish|apply|confirm|save changes|transfer)\b/i;

const short = (label: string): string => {
  const clean = label.replace(/\s+/g, ' ').trim();
  return clean.length > 40 ? `${clean.slice(0, 39)}...` : clean;
};

export function classifyClick(info: ClickTargetInfo): ClickRisk {
  const label = info.label || '';
  const name = short(label) || 'this control';
  const isButton =
    info.tag === 'button' ||
    info.role === 'button' ||
    (info.tag === 'input' && ['submit', 'button', 'image', 'reset'].includes(info.type));
  const actionable = isButton || info.tag === 'a' || info.role === 'link' || info.role === 'menuitem';
  if (!actionable) return { risky: false };

  if (DESTRUCTIVE.test(label)) return { risky: true, kind: 'destructive', prompt: `Activate "${name}"? This may be hard to undo.` };
  if (PURCHASE.test(label)) return { risky: true, kind: 'purchase', prompt: `Activate "${name}"? This may spend money.` };
  if (ACCOUNT.test(label)) return { risky: true, kind: 'account', prompt: `Activate "${name}"?` };

  const submits = info.inForm && (info.type === 'submit' || (info.tag === 'button' && info.type !== 'button' && info.type !== 'reset'));
  if (isButton && (SUBMIT.test(label) || submits)) {
    // Plain search boxes submit constantly; only confirm forms that send something sensitive or say so.
    if (SUBMIT.test(label) || info.formSensitive) {
      return { risky: true, kind: 'submit', prompt: `Submit with "${name}"?` };
    }
  }
  return { risky: false };
}

export function needsConfirmation(policy: 'never' | 'risky' | 'always', info: ClickTargetInfo): string | null {
  if (policy === 'never') return null;
  const risk = classifyClick(info);
  if (risk.risky) return risk.prompt;
  if (policy === 'always') return `Click "${short(info.label) || info.tag}"?`;
  return null;
}

import { InlineKeyboard } from 'grammy';

// Reserved callback for the in-section "← Back" button. The dispatcher intercepts
// this before delegating to a step's handleCallback (see handleOnboardingCallback),
// routing it to the step's handleBack instead.
export const BACK_DATA = 'onb:back';

const BACK_LABEL = '← Back';

// Append a "← Back" row to an existing inline keyboard. Its own row, so Back never
// shares a line with the choices. Mutates and returns the keyboard for chaining.
export function withBack(kb: InlineKeyboard): InlineKeyboard {
  return kb.row().text(BACK_LABEL, BACK_DATA);
}

// A keyboard carrying only the "← Back" button, for text-entry prompts that
// otherwise send no keyboard (e.g. the injury "what's hurting?" question), so the
// athlete always has a non-typing way out.
export function backOnlyKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text(BACK_LABEL, BACK_DATA);
}

// True when typed text means "take me back a screen". Deliberately narrow:
// standalone tokens are matched exactly so a race like "Back Bay Half" or a body
// part isn't swallowed; only unambiguous multiword phrases match anywhere, so the
// reported "None, never mind" is caught. Excludes "none", "no", and "skip" — those
// carry real meaning in goal-setup (enter manually / skip date or distance) and
// enrichment (skip the dump).
export function isCancelPhrase(text: string): boolean {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[!.?,]+$/u, '');
  if (!t) return false;
  if (['back', 'cancel', 'nvm', 'nevermind'].includes(t)) return true;
  return ['never mind', 'go back', 'scratch that', 'wait no'].some((p) => t.includes(p));
}

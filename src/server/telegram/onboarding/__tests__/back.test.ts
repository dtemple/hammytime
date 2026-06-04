import { describe, it, expect } from 'vitest';
import { InlineKeyboard } from 'grammy';
import { BACK_DATA, backOnlyKeyboard, isCancelPhrase, withBack } from '../back';

describe('isCancelPhrase', () => {
  it('matches the reported "None, never mind"', () => {
    expect(isCancelPhrase('None, never mind')).toBe(true);
  });

  it('matches standalone cancel tokens and multiword phrases', () => {
    for (const t of [
      'back',
      'Back',
      'nvm',
      'nevermind',
      'cancel',
      'never mind',
      'go back',
      'scratch that',
      'wait no',
    ]) {
      expect(isCancelPhrase(t)).toBe(true);
    }
  });

  it('does NOT treat none / no / skip as cancel — they carry meaning in the flow', () => {
    for (const t of ['none', 'no', 'n', 'skip', 'unknown', 'tbd']) {
      expect(isCancelPhrase(t)).toBe(false);
    }
  });

  it('does not swallow legitimate answers that merely contain a token', () => {
    expect(isCancelPhrase('Back Bay Half Marathon')).toBe(false);
    expect(isCancelPhrase('left knee')).toBe(false);
    expect(isCancelPhrase('CIM')).toBe(false);
    expect(isCancelPhrase('Cancellara Gran Fondo')).toBe(false);
  });

  it('ignores trailing punctuation', () => {
    expect(isCancelPhrase('back!')).toBe(true);
    expect(isCancelPhrase('never mind.')).toBe(true);
  });

  it('treats empty/whitespace as not a cancel', () => {
    expect(isCancelPhrase('   ')).toBe(false);
  });
});

describe('back keyboards', () => {
  it('backOnlyKeyboard carries a single back button', () => {
    const kb = backOnlyKeyboard() as unknown as { inline_keyboard: unknown };
    expect(JSON.stringify(kb.inline_keyboard)).toContain(BACK_DATA);
  });

  it('withBack appends a back row to an existing keyboard', () => {
    const kb = withBack(new InlineKeyboard().text('A', 'a')) as unknown as {
      inline_keyboard: unknown;
    };
    const s = JSON.stringify(kb.inline_keyboard);
    expect(s).toContain('"a"');
    expect(s).toContain(BACK_DATA);
  });
});

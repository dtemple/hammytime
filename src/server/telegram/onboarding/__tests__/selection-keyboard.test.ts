import { describe, it, expect } from 'vitest';

import { selectionKeyboardFromTap } from '../dispatcher';

// Shape of grammy's inline_keyboard rows we read from the tapped message.
const rows = (
  ...btns: { text: string; callback_data?: string; url?: string }[]
) => [btns];

describe('selectionKeyboardFromTap', () => {
  it('collapses to a single inert ✅ button for the tapped choice', () => {
    const kb = selectionKeyboardFromTap(rows({ text: 'Sat', callback_data: 'lr:6' }), 'lr:6');
    expect(kb).not.toBeNull();
    expect(kb!.inline_keyboard).toEqual([[{ text: '✅ Sat', callback_data: 'noop' }]]);
  });

  it('matches across multiple rows', () => {
    const kb = selectionKeyboardFromTap(
      [
        [
          { text: '5K', callback_data: 'dist:5k' },
          { text: 'Half', callback_data: 'dist:half' },
        ],
        [{ text: 'Marathon', callback_data: 'dist:marathon' }],
      ],
      'dist:marathon',
    );
    expect(kb!.inline_keyboard).toEqual([[{ text: '✅ Marathon', callback_data: 'noop' }]]);
  });

  it('strips a leading suggestion check so it is not doubled', () => {
    const kb = selectionKeyboardFromTap(rows({ text: '✅ 3', callback_data: 'days:3' }), 'days:3');
    expect(kb!.inline_keyboard).toEqual([[{ text: '✅ 3', callback_data: 'noop' }]]);
  });

  it('strips a trailing arrow affordance', () => {
    const kb = selectionKeyboardFromTap(
      rows({ text: "Something's bothering me →", callback_data: 'injury:some' }),
      'injury:some',
    );
    expect(kb!.inline_keyboard).toEqual([
      [{ text: "✅ Something's bothering me", callback_data: 'noop' }],
    ]);
  });

  it('returns null when no button matches the tapped data', () => {
    expect(selectionKeyboardFromTap(rows({ text: 'Sat', callback_data: 'lr:6' }), 'lr:0')).toBeNull();
  });

  it('returns null for a url-only keyboard (no callback_data to match)', () => {
    expect(
      selectionKeyboardFromTap(rows({ text: 'Connect Strava', url: 'https://example.com' }), 'whatever'),
    ).toBeNull();
  });

  it('returns null when the message had no keyboard', () => {
    expect(selectionKeyboardFromTap(undefined, 'lr:6')).toBeNull();
  });
});

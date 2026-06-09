import { describe, it, expect, vi, beforeEach } from 'vitest';

// send.ts pulls in grammy + the db client at import. Bot is stubbed (its api
// recorded via mockApi); InlineKeyboard stays real so the confirm-keyboard
// tests assert the actual callback_data layout. The corpus lookup
// (resolveExercise) is intentionally NOT mocked — the render tests assert
// against the real worker/knowledge/exercises.md entries.
const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    sendMessage: vi.fn(),
    editMessageText: vi.fn(),
  },
}));
vi.mock('@/lib/db', () => ({ supabaseAdmin: vi.fn() }));
vi.mock('grammy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('grammy')>();
  // A constructor (new Bot(...)) returning the stubbed api — arrows can't be new'd.
  return {
    ...actual,
    Bot: vi.fn(function Bot() {
      return { api: mockApi };
    }),
  };
});

import { renderTelegramHtml, sendCalendarConfirm } from '../send';
import { supabaseAdmin } from '@/lib/db';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = any;

describe('renderTelegramHtml', () => {
  it('escapes HTML-special characters in prose', () => {
    expect(renderTelegramHtml('keep it < 8/10 effort & relax > yesterday')).toBe(
      'keep it &lt; 8/10 effort &amp; relax &gt; yesterday',
    );
  });

  it('links a known slug token to its corpus source', () => {
    expect(renderTelegramHtml('try [single-leg calf raises](single-leg-calf-raise) tonight')).toBe(
      'try <a href="https://e3rehab.com/calves/">single-leg calf raises</a> tonight',
    );
  });

  it('collapses an unknown slug token to plain text (no link, no fabricated URL)', () => {
    expect(renderTelegramHtml('do [some move](not-a-real-slug) daily')).toBe('do some move daily');
  });

  it('escapes the visible label inside the anchor', () => {
    expect(renderTelegramHtml('[A & B](dead-bug)')).toBe(
      '<a href="https://www.youtube.com/watch?v=BZYaCzbP09M">A &amp; B</a>',
    );
  });

  it('leaves prose without tokens unchanged', () => {
    expect(renderTelegramHtml('nice work today, keep it easy')).toBe(
      'nice work today, keep it easy',
    );
  });

  it('converts **bold** to <b> tags', () => {
    expect(renderTelegramHtml('**Friday 6/5** — easy 5')).toBe('<b>Friday 6/5</b> — easy 5');
  });

  it('nests a bolded link as <b><a>', () => {
    expect(renderTelegramHtml('**[single-leg calf raises](single-leg-calf-raise)**')).toBe(
      '<b><a href="https://e3rehab.com/calves/">single-leg calf raises</a></b>',
    );
  });

  it('leaves single asterisks and snake_case filenames alone', () => {
    expect(renderTelegramHtml('noted in race_calendar.md and *keep* easy')).toBe(
      'noted in race_calendar.md and *keep* easy',
    );
  });
});

describe('sendCalendarConfirm', () => {
  const ATHLETE = '11111111-2222-3333-4444-555555555555';
  const TOKEN = 'tok123abc456';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let inserted: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let planUpdates: { values: any; field: string; value: any }[];

  function makeDb() {
    return {
      from(table: string) {
        if (table === 'athletes') {
          return {
            select: () => ({
              eq: () => ({ maybeSingle: () => ({ data: { telegram_chat_id: '12345' } }) }),
            }),
          };
        }
        if (table === 'messages') {
          return {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            insert: (row: any) => {
              inserted.push(row);
              return Promise.resolve({ error: null });
            },
          };
        }
        if (table === 'plans') {
          return {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            update: (values: any) => ({
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              eq: (field: string, value: any) => {
                planUpdates.push({ values, field, value });
                return Promise.resolve({ error: null });
              },
            }),
          };
        }
        throw new Error(`unexpected table ${table}`);
      },
    };
  }

  beforeEach(() => {
    inserted = [];
    planUpdates = [];
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    mockApi.sendMessage.mockReset().mockResolvedValue({ message_id: 4242 });
    mockApi.editMessageText.mockReset().mockResolvedValue(true);
    (supabaseAdmin as AnyMock).mockImplementation(() => makeDb());
  });

  it('sends the Yes/No keyboard with cal:y/cal:n callback data', async () => {
    await sendCalendarConfirm(ATHLETE, TOKEN);

    expect(mockApi.sendMessage).toHaveBeenCalledOnce();
    const [chatId, text, opts] = mockApi.sendMessage.mock.calls[0]!;
    expect(chatId).toBe('12345');
    expect(text).toBe('Update your calendar?');
    expect(opts.reply_markup.inline_keyboard).toEqual([
      [
        { text: 'Yes, update', callback_data: `cal:y:${TOKEN}` },
        { text: 'No, leave it', callback_data: `cal:n:${TOKEN}` },
      ],
    ]);
  });

  it('logs the keyboard message to messages', async () => {
    await sendCalendarConfirm(ATHLETE, TOKEN);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      athlete_id: ATHLETE,
      channel: 'tg',
      direction: 'out',
      body: 'Update your calendar?',
    });
  });

  it('stores the sent message_id on the plans row keyed on the token', async () => {
    await sendCalendarConfirm(ATHLETE, TOKEN);
    expect(planUpdates).toEqual([
      { values: { proposed_message_id: 4242 }, field: 'proposed_token', value: TOKEN },
    ]);
  });
});

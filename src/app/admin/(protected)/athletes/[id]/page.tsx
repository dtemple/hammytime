import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAthleteDetail } from '@/server/billing/admin';
import { adjustAction, compedAction, pauseAction } from '../../../actions';
import {
  autoPauseCell,
  balanceLabel,
  runwayCell,
  signedDollars,
  statusChips,
} from '../../../format';

export const metadata = { title: 'Athlete · Daybreak admin' };
export const dynamic = 'force-dynamic';

const ERR: Record<string, string> = {
  note: 'A note is required for every adjustment.',
  amount: 'Enter a non-zero dollar amount (e.g. 5 or -2.50).',
  notice_failed: 'Paused, but the Telegram notice failed to send — check the chat.',
};
const MSG: Record<string, string> = {
  adjusted: 'Adjustment applied.',
  comped: 'Comp status updated.',
  paused: 'Check-ins paused and the notice sent.',
  already_paused: 'Already paused — no change.',
};

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default async function AthleteDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ msg?: string; err?: string }>;
}) {
  const { id } = await params;
  const { msg, err } = await searchParams;
  const a = await getAthleteDetail(id);
  if (!a) notFound();

  return (
    <main className="space-y-6">
      <div>
        <Link href="/admin" className="text-sm text-blue-700 hover:underline">
          ← Roster
        </Link>
      </div>

      <header className="space-y-2">
        <h1 className="text-lg font-semibold">
          {a.name}
          {a.isTest && <span className="ml-2 text-xs font-normal text-gray-400">test</span>}
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`text-xl tabular-nums ${a.balanceCents < 0 ? 'text-red-600' : ''}`}>
            {balanceLabel(a.balanceCents)}
          </span>
          <span className="text-sm text-gray-500">
            {runwayCell(a.comped, a.balanceCents, a.runwayDays)}
          </span>
          {statusChips(a).map((c) => (
            <span key={c.label} className={`rounded px-1.5 py-0.5 text-xs ${c.className}`}>
              {c.label}
            </span>
          ))}
        </div>
        <p className="text-xs text-gray-400">
          chat id {a.telegramChatId ?? '—'} · {a.athleteId}
          {!a.hasCreditsRow && ' · no athlete_credits row yet'}
        </p>
      </header>

      {msg && MSG[msg] && (
        <p className="rounded bg-green-50 px-3 py-2 text-sm text-green-800">{MSG[msg]}</p>
      )}
      {err && ERR[err] && (
        <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{ERR[err]}</p>
      )}

      {/* ---- Controls -------------------------------------------------------- */}
      <section className="grid gap-6 md:grid-cols-2">
        <div className="rounded border border-gray-200 p-4">
          <h2 className="mb-3 text-sm font-semibold">Manual adjustment</h2>
          <form action={adjustAction} className="space-y-3">
            <input type="hidden" name="athlete_id" value={a.athleteId} />
            <div>
              <label className="block text-xs text-gray-500">Amount ($, signed)</label>
              <input
                name="amount"
                inputMode="decimal"
                required
                placeholder="5 or -2.50"
                className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500">Note (required)</label>
              <input
                name="note"
                required
                placeholder="comp · make-good · correction"
                className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
              />
            </div>
            <button
              type="submit"
              className="rounded bg-black px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-800"
            >
              Apply adjustment
            </button>
          </form>
          <p className="mt-2 text-xs text-gray-400">
            Positive credits, negative debits. Writes an audit ledger row.
          </p>
        </div>

        <div className="rounded border border-gray-200 p-4">
          <h2 className="mb-3 text-sm font-semibold">Comp</h2>
          <p className="mb-3 text-sm text-gray-600">
            {a.comped
              ? 'On the house — all billing skipped.'
              : 'Metered — debits, warnings, and the $0 gate apply.'}
          </p>
          <form action={compedAction}>
            <input type="hidden" name="athlete_id" value={a.athleteId} />
            <input type="hidden" name="comped" value={a.comped ? 'false' : 'true'} />
            <button
              type="submit"
              className="rounded border border-gray-300 px-3 py-1.5 text-sm font-medium hover:bg-gray-50"
            >
              {a.comped ? 'Remove comp' : 'Mark comped'}
            </button>
          </form>
        </div>
      </section>

      {/* ---- Daily check-ins / pause ---------------------------------------- */}
      <section className="rounded border border-gray-200 p-4">
        <h2 className="mb-3 text-sm font-semibold">Daily check-ins</h2>
        {a.pausedAt ? (
          <p className="text-sm text-gray-600">
            Paused
            {a.pauseReason === 'auto_inactivity'
              ? ' (inactivity)'
              : a.pauseReason === 'manual'
                ? ' (vacation)'
                : ''}{' '}
            since {fmtTime(a.pausedAt)}. Resumes when they tap the resume button or message you.
          </p>
        ) : a.pausable ? (
          <>
            <p className="mb-3 text-sm text-gray-600">
              Active. Auto-pauses for inactivity in{' '}
              <span className="font-medium">{autoPauseCell(a.autoPauseInDays)}</span>.
            </p>
            <form action={pauseAction}>
              <input type="hidden" name="athlete_id" value={a.athleteId} />
              <button
                type="submit"
                className="rounded border border-gray-300 px-3 py-1.5 text-sm font-medium hover:bg-gray-50"
              >
                Pause check-ins now
              </button>
            </form>
            <p className="mt-2 text-xs text-gray-400">
              Sends them the standard paused notice with a resume button. Any message they send
              turns check-ins back on.
            </p>
          </>
        ) : (
          <p className="text-sm text-gray-600">
            {a.isTest
              ? 'Test athlete — not on the daily cron.'
              : 'Not onboarded — no daily check-ins yet.'}
          </p>
        )}
      </section>

      {/* ---- Ledger ---------------------------------------------------------- */}
      <section>
        <h2 className="mb-3 text-sm font-semibold">Ledger ({a.ledger.length})</h2>
        {a.ledger.length === 0 ? (
          <p className="text-sm text-gray-500">No ledger rows yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-gray-500">
                  <th className="py-2 pr-3 font-medium">When</th>
                  <th className="py-2 pr-3 font-medium">Kind</th>
                  <th className="py-2 pr-3 font-medium">Amount</th>
                  <th className="py-2 pr-3 font-medium">Balance</th>
                  <th className="py-2 pr-3 font-medium">Note</th>
                </tr>
              </thead>
              <tbody>
                {a.ledger.map((row) => (
                  <tr key={row.id} className="border-b border-gray-100">
                    <td className="whitespace-nowrap py-2 pr-3 text-gray-600">
                      {fmtTime(row.createdAt)}
                    </td>
                    <td className="py-2 pr-3">{row.kind}</td>
                    <td
                      className={`py-2 pr-3 tabular-nums ${row.amountCents < 0 ? 'text-red-600' : 'text-green-700'}`}
                    >
                      {signedDollars(row.amountCents)}
                    </td>
                    <td className="py-2 pr-3 tabular-nums text-gray-600">
                      {balanceLabel(row.balanceAfterCents)}
                    </td>
                    <td className="py-2 pr-3 text-gray-600">{row.note ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

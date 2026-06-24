import Link from 'next/link';
import { getRoster } from '@/server/billing/admin';
import { dollarsLabel } from '@/server/billing/pricing';
import { autoPauseCell, runwayCell, statusChips } from '../format';

export const metadata = { title: 'Roster · Daybreak admin' };
export const dynamic = 'force-dynamic';

export default async function AdminRosterPage() {
  const roster = await getRoster();

  return (
    <main>
      <h1 className="mb-4 text-lg font-semibold">Athletes ({roster.length})</h1>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-gray-500">
              <th className="py-2 pr-3 font-medium">Athlete</th>
              <th className="py-2 pr-3 font-medium">Balance</th>
              <th className="py-2 pr-3 font-medium">Runway</th>
              <th className="py-2 pr-3 font-medium">Auto-pause</th>
              <th className="py-2 pr-3 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {roster.map((r) => (
              <tr key={r.athleteId} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="py-2 pr-3">
                  <Link
                    href={`/admin/athletes/${r.athleteId}`}
                    className="font-medium text-blue-700 hover:underline"
                  >
                    {r.name}
                  </Link>
                  {r.isTest && <span className="ml-2 text-xs text-gray-400">test</span>}
                </td>
                <td className="py-2 pr-3 tabular-nums">
                  <span className={r.balanceCents < 0 ? 'text-red-600' : ''}>
                    {dollarsLabel(r.balanceCents)}
                  </span>
                  {!r.hasCreditsRow && <span className="ml-1 text-xs text-gray-400">no row</span>}
                </td>
                <td className="py-2 pr-3 tabular-nums text-gray-600">
                  {runwayCell(r.comped, r.balanceCents, r.runwayDays)}
                </td>
                <td
                  className={`py-2 pr-3 tabular-nums ${
                    r.autoPauseInDays != null && r.autoPauseInDays <= 1
                      ? 'text-amber-700'
                      : 'text-gray-600'
                  }`}
                >
                  {autoPauseCell(r.autoPauseInDays)}
                </td>
                <td className="py-2 pr-3">
                  <span className="flex flex-wrap gap-1">
                    {statusChips(r).map((c) => (
                      <span
                        key={c.label}
                        className={`rounded px-1.5 py-0.5 text-xs ${c.className}`}
                      >
                        {c.label}
                      </span>
                    ))}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}

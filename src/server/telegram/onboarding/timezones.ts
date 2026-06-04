// Colloquial US timezone names for the onboarding profile-confirm step. We only
// ever know an athlete's IANA zone (derived from their Strava activity timezones),
// which names a whole region, not a city — so we present it as "Pacific time", not
// "Los Angeles". Covers the friends-only launch audience; anything outside this set
// falls back to no label (confirm message) / "Somewhere else" (correction flow).
export const US_ZONES = [
  {
    key: 'pacific',
    label: 'Pacific time',
    iana: 'America/Los_Angeles',
    aliases: ['America/Vancouver', 'America/Tijuana'],
  },
  {
    key: 'mountain',
    label: 'Mountain time',
    iana: 'America/Denver',
    aliases: ['America/Boise', 'America/Phoenix'],
  },
  {
    key: 'central',
    label: 'Central time',
    iana: 'America/Chicago',
    aliases: ['America/Winnipeg'],
  },
  {
    key: 'eastern',
    label: 'Eastern time',
    iana: 'America/New_York',
    aliases: ['America/Toronto', 'America/Detroit'],
  },
] as const;

export type ZoneKey = (typeof US_ZONES)[number]['key'];

// IANA zone -> colloquial label, or null if we don't have a clean name for it.
export function tzLabel(tz: string | null): string | null {
  if (!tz) return null;
  const zone = US_ZONES.find((z) => z.iana === tz || z.aliases.includes(tz as never));
  return zone?.label ?? null;
}

// Correction-button key -> canonical IANA string, or null for an unknown key.
export function ianaForKey(key: string): string | null {
  return US_ZONES.find((z) => z.key === key)?.iana ?? null;
}

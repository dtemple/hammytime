'use client';

import { useEffect, useState } from 'react';

const MESSAGE =
  'morning. fri, week 8 of 22.\n' +
  '\n' +
  '3 hard days in a row and your hr is up ~6 on easy pace.\n' +
  "that's a yellow flag — backing today off to 5mi recovery\n" +
  'instead of the threshold.\n' +
  '\n' +
  'boston trip mon→thu — pre-loading the long run to sunday\n' +
  '(15mi), tue + wed are 4mi shakeouts from the hotel.\n' +
  '\n' +
  'readiness + soreness?';

function charDelay(ch: string): number {
  if (ch === '.' || ch === ',' || ch === ':') return 110;
  if (ch === '\n') return 160;
  if (ch === ' ') return 22;
  return 18;
}

export default function CheckinBubble() {
  const [typed, setTyped] = useState('');
  const [chipsVisible, setChipsVisible] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReduced) {
      // Reduced-motion branch runs once on mount; the synchronous cascade is harmless.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTyped(MESSAGE);
      setDone(true);
      setChipsVisible(true);
      return;
    }

    let i = 0;
    let timer: ReturnType<typeof setTimeout>;

    function tick() {
      i++;
      setTyped(MESSAGE.slice(0, i));
      if (i >= MESSAGE.length) {
        setDone(true);
        setTimeout(() => setChipsVisible(true), 200);
        return;
      }
      timer = setTimeout(tick, charDelay(MESSAGE[i - 1] ?? ''));
    }

    const start = setTimeout(tick, 900);
    return () => {
      clearTimeout(start);
      clearTimeout(timer);
    };
  }, []);

  return (
    <article className="ht-checkin" aria-label="Sample morning check-in">
      <div className="ht-checkin-meta">
        <span className="ht-checkin-from">
          <span className="ht-checkin-avatar">D</span>
          Daybreak bot
        </span>
        <span>·</span>
        <span>Fri 6:47 AM</span>
      </div>
      <div className="ht-checkin-body">
        {typed}
        {!done && <span className="ht-caret" />}
      </div>
      <div className={`ht-quick-reply${chipsVisible ? ' shown' : ''}`}>
        <span className="ht-chip">readiness 6</span>
        <span className="ht-chip">soreness 4 — L hamstring</span>
        <span className="ht-chip">felt flat</span>
      </div>
    </article>
  );
}

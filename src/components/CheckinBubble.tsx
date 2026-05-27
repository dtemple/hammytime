'use client';

import { useEffect, useState } from 'react';

const MESSAGE =
  "Good morning\n" +
  "You've done 2,300 ft of vertical in 3 runs this week\n" +
  "that's a lot of eccentric load on the quads and soleus.\n" +
  "\n" +
  "Given your recent calf soreness, I suggest we swap today's run for one of these:\n" +
  "\n" +
  "• Flat 6-mile easy run on the Corte Madera path, no faster\n" +
  "  than 9:30/mi\n" +
  "• 45-min bike ride if your legs are feeling sore\n" +
  "\n" +
  "what do you think?";

function charDelay(ch: string): number {
  if (ch === '.' || ch === ',' || ch === ':') return 110;
  if (ch === '\n') return 160;
  if (ch === ' ') return 22;
  return 18;
}

export default function CheckinBubble() {
  const [typed, setTyped] = useState('');
  const [buttonsVisible, setButtonsVisible] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReduced) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTyped(MESSAGE);
      setDone(true);
      setButtonsVisible(true);
      return;
    }

    let i = 0;
    let timer: ReturnType<typeof setTimeout>;

    function tick() {
      i++;
      setTyped(MESSAGE.slice(0, i));
      if (i >= MESSAGE.length) {
        setDone(true);
        setTimeout(() => setButtonsVisible(true), 200);
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
          Daybreak
        </span>
        <span>·</span>
        <span>Fri 6:47 AM</span>
      </div>
      <div className="ht-checkin-body">
        {typed}
        {!done && <span className="ht-caret" />}
      </div>
      <div className={`ht-tg-buttons${buttonsVisible ? ' shown' : ''}`}>
        <button type="button" className="ht-tg-btn ht-tg-btn-primary">
          Update calendar
        </button>
        <button type="button" className="ht-tg-btn">
          Stick with the plan
        </button>
      </div>
    </article>
  );
}

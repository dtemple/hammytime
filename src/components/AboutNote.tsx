'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Image from 'next/image';

export default function AboutNote() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const trigger = triggerRef.current;
    closeRef.current?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      trigger?.focus();
    };
  }, [open, close]);

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className="ht-founder"
        onClick={() => setOpen(true)}
      >
        <span className="ht-founder-avatar">
          <Image
            src="/family.jpeg"
            alt=""
            width={32}
            height={32}
            aria-hidden="true"
            style={{ objectFit: 'cover', objectPosition: '80% 38%' }}
          />
        </span>
        <span className="ht-founder-text">
          <span className="ht-founder-link">Made by a guy</span> who was stressing too
          much about running injuries.
        </span>
      </button>

      {open &&
        createPortal(
          <div className="ht-modal-overlay" role="presentation" onClick={close}>
          <div
            className="ht-modal"
            role="dialog"
            aria-modal="true"
            aria-label="A note from David"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              ref={closeRef}
              className="ht-modal-close"
              aria-label="Close"
              onClick={close}
            >
              ×
            </button>
            <div className="ht-modal-body">
              <div className="ht-modal-note">
                <p>
                  Thanks to some supportive friends, I&rsquo;ve
                  realized over the years that most running injuries can be
                  fixed with strength training, stretching, calendar tweaking and patience.
                </p>
                <p>
                  And when AI has all the right context in one place, it can do a pretty impressive
                  job of helping work through all of that.
                </p>
                <p>So I built a bot to do exactly that&hellip; and the result is Daybreak.</p>
                <p>
                  I hope that Daybreak helps with your running journey as much as it did
                  with mine. If you have ideas, please share them. And if you find it
                  useful, please spread the word.
                </p>
                <p>I hope you like it.</p>
              </div>
              <div className="ht-modal-sign">David</div>
              <div className="ht-modal-disclaimer">
                <div className="ht-modal-disclaimer-label">Disclaimer</div>
                <p>
                  Daybreak is a side project &mdash; and it&rsquo;s going to have bugs
                  and make mistakes. Like with anything AI, use your own judgement.
                </p>
              </div>
            </div>
            <div className="ht-modal-photo">
              <Image
                src="/family.jpeg"
                alt="David with his family"
                fill
                sizes="600px"
                style={{ objectFit: 'cover', objectPosition: 'center 32%' }}
              />
            </div>
          </div>
        </div>,
          document.body,
        )}
    </>
  );
}

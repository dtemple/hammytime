'use client';

const USER = 'dtemple';
const DOMAIN = 'gmail.com';

export default function ContactEmail() {
  function open() {
    window.location.href = `mailto:${USER}@${DOMAIN}`;
  }

  return (
    <div className="ht-contact">
      <button type="button" className="ht-btn ht-btn-primary" onClick={open}>
        Email Daybreak
      </button>
      <span className="ht-contact-addr">
        {USER} [at] {DOMAIN.replace('.', ' [dot] ')}
      </span>
    </div>
  );
}

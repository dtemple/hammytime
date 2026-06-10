import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SiteShell } from '@/components/SiteShell';
import { prehabPageBlocks, type Block, type InlineSegment } from '@/lib/prehab-markdown';
import { loadPrehabPageData } from '@/server/prehab/page-data';

// The routine updates whenever the coach revises it — render fresh every hit.
export const dynamic = 'force-dynamic';

// Generic title on purpose: the athlete's name stays off link previews and
// browser history. The page itself greets them. Unguessable-token page —
// noindex here plus the X-Robots-Tag header in next.config.ts.
export const metadata: Metadata = {
  title: 'Your prehab routine — Daybreak',
  robots: { index: false, follow: false },
};

function Segments({ segments }: { segments: InlineSegment[] }) {
  return (
    <>
      {segments.map((seg, i) => {
        if (seg.kind === 'bold') return <strong key={i}>{seg.text}</strong>;
        if (seg.kind === 'link') {
          // no-referrer keeps the token URL out of Referer headers on
          // outbound clicks to the exercise sources.
          return (
            <a
              key={i}
              href={seg.href}
              target="_blank"
              rel="noopener noreferrer"
              referrerPolicy="no-referrer"
              className="underline underline-offset-2 decoration-stone-400 hover:decoration-stone-600"
            >
              {seg.text}
            </a>
          );
        }
        return <span key={i}>{seg.text}</span>;
      })}
    </>
  );
}

function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((block, i) => {
        if (block.kind === 'heading') {
          return (
            <h2 key={i} className="mt-7 mb-2 text-base font-semibold">
              {block.text}
            </h2>
          );
        }
        if (block.kind === 'bullets') {
          return (
            <ul key={i} className="my-2 list-disc space-y-2 pl-5 text-[15px] leading-relaxed">
              {block.items.map((item, j) => (
                <li key={j}>
                  <Segments segments={item} />
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i} className="my-2 text-[15px] leading-relaxed">
            <Segments segments={block.segments} />
          </p>
        );
      })}
    </>
  );
}

function lastUpdated(updatedAt: string): string {
  return new Date(updatedAt).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

export default async function PrehabPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const data = await loadPrehabPageData(token);
  if (!data) notFound();

  const firstName = data.athleteName.split(' ')[0];

  return (
    <SiteShell nav={false} footer={false}>
      <p className="sg-eyebrow">Prehab routine</p>
      <h1 className="sg-title">Hi {firstName}.</h1>
      {data.contentMd === null ? (
        <p className="sg-lede">
          Your coach hasn&rsquo;t written your prehab routine yet — it&rsquo;ll appear here once
          it&rsquo;s ready.
        </p>
      ) : (
        <>
          <p className="sg-lede">
            This is your standing prehab routine — what to do, why, and which days to do it. This
            page stays current as you and your coach adjust it.
          </p>
          <Blocks blocks={prehabPageBlocks(data.contentMd)} />
          {data.updatedAt && (
            <p className="mt-8 text-[13px] text-stone-500">
              Last updated {lastUpdated(data.updatedAt)}.
            </p>
          )}
        </>
      )}
    </SiteShell>
  );
}

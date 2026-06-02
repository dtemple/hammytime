import { InlineKeyboard } from 'grammy';
import { supabaseAdmin } from '@/lib/db';
import { upsertMemorySection, upsertProfileSection } from '../memory';
import type { OnboardingStep, StepHandleResult } from '../types';

// Beat A7 (onboarding v2): the one safety gate that stays structured, but light.
// [All good] / [Something's bothering me] → a single capture (body part + active vs
// watch), not the old per-part severity/active/notes loop. Detail deepens later in
// daily chat.

type InjuryPartial = {
  sub_step: 'asking' | 'capture_part' | 'capture_status';
  body_part?: string;
  status?: 'active' | 'monitoring';
};

function asPartial(p: Record<string, unknown>): InjuryPartial {
  return Object.keys(p).length === 0 ? { sub_step: 'asking' } : (p as InjuryPartial);
}

function askKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('All good', 'injury:none')
    .text("Something's bothering me →", 'injury:some');
}

async function handleCallback(
  data: string,
  partialRaw: Record<string, unknown>,
): Promise<StepHandleResult> {
  const p = asPartial(partialRaw);

  if (data === 'injury:none') {
    return { done: true, newPartial: { ...p, body_part: undefined } };
  }
  if (data === 'injury:some') {
    return {
      done: false,
      newPartial: { ...p, sub_step: 'capture_part' },
      reply: "What's bothering you? (e.g. left knee, right achilles, lower back)",
    };
  }
  return { done: false, newPartial: p };
}

async function handleMessage(
  text: string,
  partialRaw: Record<string, unknown>,
): Promise<StepHandleResult> {
  const p = asPartial(partialRaw);

  if (p.sub_step === 'capture_part') {
    const body_part = text.trim();
    if (body_part.length < 2 || body_part.length > 80) {
      return { done: false, newPartial: p, reply: 'Tell me what part — e.g. "left knee".' };
    }
    return {
      done: false,
      newPartial: { ...p, body_part, sub_step: 'capture_status' },
      reply: "Is it still bugging you, or just something to keep an eye on? Reply 'bugging' or 'watch'.",
    };
  }

  if (p.sub_step === 'capture_status') {
    const v = text.trim().toLowerCase();
    const active = v.includes('bug') || v.includes('hurt') || v.includes('pain') || v.includes('active');
    const watch = v.includes('watch') || v.includes('eye') || v.includes('monitor') || v.includes('fine');
    if (!active && !watch) {
      return { done: false, newPartial: p, reply: "Reply 'bugging' (still hurts) or 'watch' (keeping an eye on it)." };
    }
    return { done: true, newPartial: { ...p, status: active ? 'active' : 'monitoring' } };
  }

  // 'asking' — they typed instead of tapping.
  return { done: false, newPartial: p, reply: 'Tap a button above — all good, or something bothering you.' };
}

async function onComplete(athleteId: string, partialRaw: Record<string, unknown>): Promise<void> {
  const p = partialRaw as InjuryPartial;
  if (!p.body_part) return; // "All good" — nothing to record.

  const status = p.status ?? 'active';
  const db = supabaseAdmin();
  const { error } = await db.from('injuries').insert({
    athlete_id: athleteId,
    body_part: p.body_part,
    severity: null,
    status,
    notes: null,
    started_at: new Date().toISOString(),
  });
  if (error) throw new Error(`injuries insert failed: ${error.message}`);

  const statusLabel = status === 'active' ? 'currently bothering them' : 'watching it';
  await upsertProfileSection(athleteId, 'Injury history', `- ${p.body_part} — ${statusLabel}`);
  await upsertMemorySection(
    athleteId,
    'injury_log.md',
    'Active injuries',
    `- **${p.body_part}** — ${statusLabel} (from onboarding; detail TBD in daily chat).`,
  );
}

export const injuryCheckStep: OnboardingStep = {
  id: 'injury-check',
  questions: [],
  initialPrompt: 'Anything hurting or nagging right now?',
  initialKeyboard: askKeyboard(),
  handleMessage,
  handleCallback,
  onComplete,
};

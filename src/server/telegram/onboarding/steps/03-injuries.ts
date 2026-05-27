import { InlineKeyboard } from 'grammy';
import { supabaseAdmin } from '@/lib/db';
import { upsertMemorySection, upsertProfileSection } from '@/server/telegram/onboarding/memory';
import type { OnboardingStep, StepHandleResult } from '../types';
import {
  BILATERAL_PARTS,
  BODY_PART_LABELS,
  BODY_PARTS,
  type BodyPart,
} from './03-injuries.constants';

// ---------------------------------------------------------------------------
// State types
// ---------------------------------------------------------------------------

type SubStep =
  | 'selecting'
  | 'awaiting_other_label'
  | 'awaiting_laterality'
  | 'awaiting_severity'
  | 'awaiting_active'
  | 'awaiting_notes';

type CurrentDetail = {
  body_part: BodyPart;
  display_name: string;
  laterality?: 'left' | 'right' | 'both' | null;
  severity?: number;
  active?: boolean;
  notes?: string;
};

type CommittedInjury = {
  body_part: BodyPart;
  display_name: string;
  laterality: 'left' | 'right' | 'both' | null;
  severity: number;
  active: boolean;
  notes: string | null;
};

type Step3Partial = {
  sub_step: SubStep;
  selected: BodyPart[];
  other_label?: string;
  completed_count: number;
  current_detail?: CurrentDetail;
  injuries: CommittedInjury[];
};

// ---------------------------------------------------------------------------
// Keyboard builder
// ---------------------------------------------------------------------------

export function buildKeyboard(selected: BodyPart[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  const selectedSet = new Set(selected);

  // 2-column grid of body parts
  const parts = [...BODY_PARTS].filter((p) => p !== 'other');
  for (let i = 0; i < parts.length; i += 2) {
    const a = parts[i]!;
    const b = parts[i + 1];
    const labelA = `${selectedSet.has(a) ? '✅' : '▫️'} ${BODY_PART_LABELS[a]}`;
    if (b) {
      const labelB = `${selectedSet.has(b) ? '✅' : '▫️'} ${BODY_PART_LABELS[b]}`;
      kb.text(labelA, `injury:toggle:${a}`).text(labelB, `injury:toggle:${b}`).row();
    } else {
      kb.text(labelA, `injury:toggle:${a}`).row();
    }
  }
  // "Other" on its own row
  const otherLabel = `${selectedSet.has('other') ? '✅' : '▫️'} ${BODY_PART_LABELS['other']}`;
  kb.text(otherLabel, 'injury:toggle:other').row();
  // Control rows
  kb.text("None — I'm clear", 'injury:none').row();
  kb.text('Done ✓', 'injury:done').row();

  return kb;
}

// ---------------------------------------------------------------------------
// Per-part helpers
// ---------------------------------------------------------------------------

function partDisplayBase(part: BodyPart, otherLabel?: string): string {
  if (part === 'other') return otherLabel ?? 'other';
  return BODY_PART_LABELS[part].toLowerCase();
}

function buildDisplayName(base: string, laterality: 'left' | 'right' | 'both' | null): string {
  if (!laterality) return base;
  if (laterality === 'both') return `both ${base}s`;
  return `${laterality} ${base}`;
}

type FirstPartResult = {
  sub_step: SubStep;
  reply: string;
  current_detail: CurrentDetail;
};

function enterPart(part: BodyPart, otherLabel: string | undefined): FirstPartResult {
  const base = partDisplayBase(part, otherLabel);
  const isBilateral = part === 'other' || BILATERAL_PARTS.has(part);

  if (isBilateral) {
    return {
      sub_step: 'awaiting_laterality',
      reply: `Got it: **${base}**. Left, right, or both?`,
      current_detail: { body_part: part, display_name: base },
    };
  }
  return {
    sub_step: 'awaiting_severity',
    reply: `Got it: **${base}**. Severity 1–10? (1 = barely notice, 10 = can't run)`,
    current_detail: { body_part: part, display_name: base, laterality: null },
  };
}

// ---------------------------------------------------------------------------
// handleCallback
// ---------------------------------------------------------------------------

async function injuriesHandleCallback(
  data: string,
  partial: Record<string, unknown>,
  _athleteId: string,
): Promise<StepHandleResult> {
  const p = partial as Partial<Step3Partial>;
  const subStep = p.sub_step ?? 'selecting';

  if (subStep !== 'selecting') {
    // Ignore spurious callbacks outside the selection phase
    return { done: false, newPartial: partial };
  }

  const selected: BodyPart[] = Array.isArray(p.selected) ? [...p.selected] : [];

  if (data === 'injury:none') {
    const newPartial: Step3Partial = {
      sub_step: 'selecting',
      selected: [],
      completed_count: 0,
      injuries: [],
    };
    return {
      done: true,
      newPartial,
      reply: 'Good — nothing to flag. Moving on.',
    };
  }

  if (data === 'injury:done') {
    if (selected.length === 0) {
      return {
        done: false,
        newPartial: partial,
        alertText: 'Tap at least one body part, or hit None.',
      };
    }

    if (selected.includes('other')) {
      const newPartial: Step3Partial = {
        sub_step: 'awaiting_other_label',
        selected,
        completed_count: 0,
        injuries: [],
      };
      return {
        done: false,
        newPartial,
        reply: "What body part is the 'other' one? (One word or short phrase.)",
      };
    }

    // Enter per-part loop — first selected part
    const firstPart = selected[0]!;
    const { sub_step, reply, current_detail } = enterPart(firstPart, undefined);
    const newPartial: Step3Partial = {
      sub_step,
      selected,
      completed_count: 0,
      current_detail,
      injuries: [],
    };
    return { done: false, newPartial, reply };
  }

  if (data.startsWith('injury:toggle:')) {
    const part = data.slice('injury:toggle:'.length) as BodyPart;
    if (!BODY_PARTS.includes(part)) {
      return { done: false, newPartial: partial };
    }

    const idx = selected.indexOf(part);
    if (idx === -1) {
      selected.push(part);
    } else {
      selected.splice(idx, 1);
    }

    const newPartial: Step3Partial = {
      sub_step: 'selecting',
      selected,
      completed_count: 0,
      injuries: [],
    };
    return {
      done: false,
      newPartial,
      replyMarkup: buildKeyboard(selected),
    };
  }

  // Unknown callback data — ignore
  return { done: false, newPartial: partial };
}

// ---------------------------------------------------------------------------
// handleMessage
// ---------------------------------------------------------------------------

async function injuriesHandleMessage(
  text: string,
  partial: Record<string, unknown>,
  _athleteId: string,
): Promise<StepHandleResult> {
  const p = partial as Step3Partial;

  switch (p.sub_step) {
    case 'awaiting_other_label': {
      const trimmed = text.trim().slice(0, 40) || 'other';
      // Enter per-part loop. 'other' is first unless another part precedes it —
      // find its position in selected and start from the beginning.
      const firstPart = p.selected[0]!;
      const otherLabel = firstPart === 'other' ? trimmed : undefined;
      const { sub_step, reply, current_detail } = enterPart(firstPart, otherLabel);
      const newPartial: Step3Partial = {
        ...p,
        other_label: trimmed,
        sub_step,
        completed_count: 0,
        current_detail,
        injuries: [],
      };
      return { done: false, newPartial, reply };
    }

    case 'awaiting_laterality': {
      const raw = text.trim().toLowerCase();
      const lateralityMap: Record<string, 'left' | 'right' | 'both'> = {
        left: 'left',
        l: 'left',
        right: 'right',
        r: 'right',
        both: 'both',
        b: 'both',
      };
      const laterality = lateralityMap[raw];
      if (!laterality) {
        return {
          done: false,
          newPartial: partial,
          reply: `Not sure I got that — reply left, right, or both for your ${p.current_detail?.display_name ?? 'injury'}.`,
        };
      }

      const base = p.current_detail!.display_name;
      const displayName = buildDisplayName(base, laterality);
      const newDetail: CurrentDetail = {
        ...p.current_detail!,
        display_name: displayName,
        laterality,
      };
      const newPartial: Step3Partial = {
        ...p,
        sub_step: 'awaiting_severity',
        current_detail: newDetail,
      };
      return {
        done: false,
        newPartial,
        reply: `Severity 1–10? (1 = barely notice, 10 = can't run)`,
      };
    }

    case 'awaiting_severity': {
      const n = parseInt(text.trim(), 10);
      if (isNaN(n) || n < 1 || n > 10) {
        return {
          done: false,
          newPartial: partial,
          reply:
            "Give me a number between 1 and 10 — 1 is barely noticeable, 10 means you can't run.",
        };
      }
      const newPartial: Step3Partial = {
        ...p,
        sub_step: 'awaiting_active',
        current_detail: { ...p.current_detail!, severity: n },
      };
      return {
        done: false,
        newPartial,
        reply: 'Currently active? (yes / no)',
      };
    }

    case 'awaiting_active': {
      const raw = text.trim().toLowerCase();
      const yesSet = new Set(['yes', 'y']);
      const noSet = new Set(['no', 'n']);
      if (!yesSet.has(raw) && !noSet.has(raw)) {
        return {
          done: false,
          newPartial: partial,
          reply: 'Just yes or no — is this injury currently affecting your training?',
        };
      }
      const active = yesSet.has(raw);
      const newPartial: Step3Partial = {
        ...p,
        sub_step: 'awaiting_notes',
        current_detail: { ...p.current_detail!, active },
      };
      return {
        done: false,
        newPartial,
        reply: 'Any notes? (e.g. when it flares, what makes it worse) — or type skip.',
      };
    }

    case 'awaiting_notes': {
      const raw = text.trim();
      const skip = ['skip', 'none', ''].includes(raw.toLowerCase());
      const notes = skip ? null : raw.slice(0, 500);

      const detail = p.current_detail!;
      const committed: CommittedInjury = {
        body_part: detail.body_part,
        display_name: detail.display_name,
        laterality: detail.laterality ?? null,
        severity: detail.severity!,
        active: detail.active!,
        notes,
      };

      const injuries = [...p.injuries, committed];
      const nextIdx = p.completed_count + 1;

      if (nextIdx < p.selected.length) {
        const nextPart = p.selected[nextIdx]!;
        const otherLabel = nextPart === 'other' ? p.other_label : undefined;
        const { sub_step, reply, current_detail } = enterPart(nextPart, otherLabel);
        const newPartial: Step3Partial = {
          ...p,
          sub_step,
          completed_count: nextIdx,
          current_detail,
          injuries,
        };
        return { done: false, newPartial, reply };
      }

      // All parts done
      const newPartial: Step3Partial = {
        ...p,
        sub_step: 'awaiting_notes',
        completed_count: nextIdx,
        injuries,
        current_detail: undefined,
      };
      return { done: true, newPartial };
    }

    default:
      return { done: false, newPartial: partial };
  }
}

// ---------------------------------------------------------------------------
// onComplete
// ---------------------------------------------------------------------------

async function injuriesOnComplete(
  athleteId: string,
  partial: Record<string, unknown>,
): Promise<void> {
  const p = partial as Step3Partial;
  const injuries = p.injuries ?? [];
  const db = supabaseAdmin();
  const now = new Date().toISOString();

  if (injuries.length > 0) {
    const rows = injuries.map((inj) => ({
      athlete_id: athleteId,
      body_part: inj.display_name,
      severity: inj.severity,
      status: inj.active ? 'active' : 'monitoring',
      notes: inj.notes ?? null,
      started_at: now,
    }));
    const { error } = await db.from('injuries').insert(rows);
    if (error) throw new Error(`injuries insert failed: ${error.message}`);
  }

  // athlete_profile.md — Injury history
  let profileContent: string;
  if (injuries.length === 0) {
    profileContent = '_No injuries flagged during onboarding._';
  } else {
    profileContent = injuries
      .map((inj) => {
        const status = inj.active ? 'currently active' : 'monitoring';
        const notes = inj.notes ? ` ${inj.notes}` : '';
        return `- **${capitalize(inj.display_name)}** — severity ${inj.severity}/10, ${status}.${notes}`;
      })
      .join('\n');
  }
  await upsertProfileSection(athleteId, 'Injury history', profileContent);

  // injury_log.md — Active injuries
  const active = injuries.filter((i) => i.active);
  let logContent: string;
  if (active.length === 0) {
    logContent = '_No active injuries at onboarding._';
  } else {
    const dateStr = now.slice(0, 10);
    logContent = active
      .map((inj) => {
        const lines = [
          `### ${capitalize(inj.display_name)} (logged ${dateStr})`,
          `- **Severity:** ${inj.severity}/10`,
          `- **Status:** active`,
        ];
        if (inj.notes) lines.push(`- **Notes:** ${inj.notes}`);
        return lines.join('\n');
      })
      .join('\n\n');
  }
  await upsertMemorySection(athleteId, 'injury_log.md', 'Active injuries', logContent);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const INITIAL_PROMPT =
  "What injuries should I know about? Tap each that applies, then **Done**. Tap **None** if you're clear right now.";

export const injuriesStep: OnboardingStep = {
  id: 'injuries',
  questions: [],
  initialPrompt: INITIAL_PROMPT,
  initialKeyboard: buildKeyboard([]),
  handleMessage: injuriesHandleMessage,
  handleCallback: injuriesHandleCallback,
  onComplete: injuriesOnComplete,
};

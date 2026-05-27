import { supabaseAdmin } from '@/lib/db';
import { upsertProfileSection } from '../memory';
import type { OnboardingStep, ParseResult, Question } from '../types';

const recentAvgMiQuestion: Question<number> = {
  key: 'recent_avg_mi_per_week',
  prompt: 'Last 4 weeks, average weekly mileage? (Just the number.)',
  parseReply(text): ParseResult<number> {
    const n = parseInt(text.trim(), 10);
    if (isNaN(n) || String(n) !== text.trim())
      return { ok: false, error: 'Send your weekly mileage as a whole number.' };
    if (n < 0 || n > 120) return { ok: false, error: 'That needs to be between 0 and 120 miles.' };
    return { ok: true, value: n };
  },
};

const longestRecentMiQuestion: Question<number> = {
  key: 'longest_recent_mi',
  prompt: 'Longest single run in the last 4 weeks?',
  parseReply(text): ParseResult<number> {
    const n = parseInt(text.trim(), 10);
    if (isNaN(n) || String(n) !== text.trim())
      return { ok: false, error: 'Send your longest run as a whole number of miles.' };
    if (n < 0 || n > 60) return { ok: false, error: 'That needs to be between 0 and 60 miles.' };
    return { ok: true, value: n };
  },
};

export const recentMileageStep: OnboardingStep = {
  id: 'recent_mileage',
  questions: [recentAvgMiQuestion, longestRecentMiQuestion],
  async onComplete(athleteId, partial) {
    const recentAvgMi = partial.recent_avg_mi_per_week as number;
    const longestMi = partial.longest_recent_mi as number;

    if (longestMi > 2 * recentAvgMi) {
      console.warn(
        `[onboarding] athlete ${athleteId}: longest_recent_mi (${longestMi}) > 2× recent_avg_mi_per_week (${recentAvgMi}) — unusual but accepted`,
      );
    }

    // Bridge: append to athletes.notes for inter-step reads (e.g. handleBuildPath)
    const { data: athleteRow } = await supabaseAdmin()
      .from('athletes')
      .select('notes')
      .eq('id', athleteId)
      .single();

    const existingNotes = athleteRow?.notes ?? '';
    const fitnessAppend = `\nRecent avg miles/week: ${recentAvgMi}\nLongest recent run: ${longestMi}`;
    const { error } = await supabaseAdmin()
      .from('athletes')
      .update({
        notes: existingNotes + fitnessAppend,
        updated_at: new Date().toISOString(),
      })
      .eq('id', athleteId);
    if (error) throw new Error(`recentMileage notes update failed: ${error.message}`);

    const coldStartCap = Math.round(longestMi * 1.5);
    await upsertProfileSection(
      athleteId,
      'Current fitness',
      `Last 4 weeks average: ${recentAvgMi} mi/week\nLongest run: ${longestMi} mi\nCold-start long-run cap: ${coldStartCap} mi (1.5×)`,
    );
  },
};

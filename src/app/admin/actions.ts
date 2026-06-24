'use server';

// Server actions for the David-only admin console (Specs/METERING_PAYMENTS.md
// §11, step 7): password login/logout, manual credit adjust, comped toggle.
//
// Every MUTATING action re-verifies the session itself — server actions are POST
// endpoints reachable independently of the page-level route guard, so the guard
// alone is not enough. Login/logout own the cookie; adjust/comped check it.

import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import {
  ADMIN_COOKIE,
  ADMIN_SESSION_MAX_AGE_S,
  checkAdminPassword,
  isAdminAuthed,
  signAdminSession,
} from '@/server/admin/session';
import { adjustCredit, setComped } from '@/server/billing/credits';
import { supabaseAdmin } from '@/lib/db';
import { autoPauseAthlete } from '@/server/telegram/pause';

function cookieOpts() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: ADMIN_SESSION_MAX_AGE_S,
  };
}

export async function loginAction(formData: FormData): Promise<void> {
  const password = String(formData.get('password') ?? '');
  if (!checkAdminPassword(password)) {
    redirect('/admin/login?error=1');
  }
  const jar = await cookies();
  jar.set(ADMIN_COOKIE, signAdminSession(), cookieOpts());
  redirect('/admin');
}

export async function logoutAction(): Promise<void> {
  const jar = await cookies();
  jar.delete(ADMIN_COOKIE);
  redirect('/admin/login');
}

export async function adjustAction(formData: FormData): Promise<void> {
  if (!(await isAdminAuthed())) redirect('/admin/login');

  const athleteId = String(formData.get('athlete_id') ?? '');
  const amountStr = String(formData.get('amount') ?? '').trim();
  const note = String(formData.get('note') ?? '').trim();
  const back = `/admin/athletes/${athleteId}`;

  if (!athleteId) redirect('/admin');
  if (!note) redirect(`${back}?err=note`);

  const dollars = Number(amountStr);
  if (!Number.isFinite(dollars) || dollars === 0) redirect(`${back}?err=amount`);
  const cents = Math.round(dollars * 100);
  if (cents === 0) redirect(`${back}?err=amount`);

  await adjustCredit(athleteId, cents, note);
  redirect(`${back}?msg=adjusted`);
}

export async function pauseAction(formData: FormData): Promise<void> {
  if (!(await isAdminAuthed())) redirect('/admin/login');

  const athleteId = String(formData.get('athlete_id') ?? '');
  const back = `/admin/athletes/${athleteId}`;
  if (!athleteId) redirect('/admin');

  const { data, error } = await supabaseAdmin()
    .from('athletes')
    .select('id, telegram_chat_id, paused_at')
    .eq('id', athleteId)
    .maybeSingle();
  if (error) throw error;
  if (!data) redirect('/admin');
  if (data.paused_at != null) redirect(`${back}?msg=already_paused`);

  // Same action the inactivity cron takes: pause + send the static notice with
  // the resume button. autoPauseAthlete writes the pause before sending, so a
  // send failure leaves them paused-but-un-notified — report that distinctly
  // (the redirect must live OUTSIDE the try, since redirect() throws to work).
  let noticeSent = true;
  try {
    await autoPauseAthlete({ id: data.id, telegram_chat_id: data.telegram_chat_id });
  } catch {
    noticeSent = false;
  }
  redirect(noticeSent ? `${back}?msg=paused` : `${back}?err=notice_failed`);
}

export async function compedAction(formData: FormData): Promise<void> {
  if (!(await isAdminAuthed())) redirect('/admin/login');

  const athleteId = String(formData.get('athlete_id') ?? '');
  const comped = String(formData.get('comped') ?? '') === 'true';
  const back = `/admin/athletes/${athleteId}`;
  if (!athleteId) redirect('/admin');

  await setComped(athleteId, comped);
  redirect(`${back}?msg=comped`);
}

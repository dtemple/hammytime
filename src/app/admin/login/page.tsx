import { redirect } from 'next/navigation';
import { loginAction } from '../actions';
import { isAdminAuthed } from '@/server/admin/session';

export const metadata = { title: 'Admin · Daybreak' };

// The one unguarded admin route. Already-authed visitors skip straight in.
export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await isAdminAuthed()) redirect('/admin');
  const { error } = await searchParams;

  return (
    <main className="flex min-h-full items-center justify-center p-6">
      <form action={loginAction} className="w-full max-w-sm space-y-4">
        <h1 className="text-lg font-semibold">Daybreak admin</h1>
        {error && <p className="text-sm text-red-600">Wrong password.</p>}
        <input
          type="password"
          name="password"
          autoFocus
          required
          placeholder="Password"
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          className="w-full rounded bg-black px-3 py-2 text-sm font-medium text-white hover:bg-gray-800"
        >
          Sign in
        </button>
      </form>
    </main>
  );
}

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { isAdminAuthed } from '@/server/admin/session';
import { logoutAction } from '../actions';

// Route-group guard for every /admin page except /admin/login. A Server
// Component layout (Node runtime) so the HMAC verify runs with node:crypto —
// chosen over middleware, which would run on the Edge runtime where createHmac
// isn't available. Unauthed → bounce to the login page.
export default async function ProtectedAdminLayout({ children }: { children: React.ReactNode }) {
  if (!(await isAdminAuthed())) redirect('/admin/login');

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6">
      <header className="mb-6 flex items-center justify-between border-b border-gray-200 pb-3">
        <Link href="/admin" className="text-base font-semibold">
          Daybreak admin
        </Link>
        <form action={logoutAction}>
          <button type="submit" className="text-sm text-gray-500 hover:text-gray-900">
            Log out
          </button>
        </form>
      </header>
      {children}
    </div>
  );
}

import { redirect } from 'next/navigation';

/**
 * The root path is a redirect, not a landing page.
 *
 * There is no marketing surface in this app; `/` exists so that the obvious URL
 * works. The dashboard is the home screen.
 */
export default function RootPage() {
  redirect('/dashboard');
}

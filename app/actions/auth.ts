'use server';
import { signOut } from '@/lib/auth';

/** Server action: end the session and return to the login page. */
export async function signOutAction() {
  await signOut({ redirectTo: '/login' });
}

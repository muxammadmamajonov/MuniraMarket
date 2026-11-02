'use client';

import { useSession } from '@/lib/session';
import { SignInPrompt } from './sign-in-prompt';

/**
 * Browsing never needs a session, but the cart controls on the cards do. When the session could
 * not be established this says why and offers the way in (retry inside Telegram, the login widget
 * in a browser); otherwise it renders nothing.
 */
export function SessionNotice() {
  const { status } = useSession();
  if (status !== 'anonymous' && status !== 'error') return null;
  return <SignInPrompt />;
}

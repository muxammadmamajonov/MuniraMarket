/**
 * Full top-level navigation to another site (Telegram's sign-in page). A separate module so tests
 * can replace it: jsdom cannot navigate, and `window.location.assign` cannot be spied on there.
 */
export function navigateTo(url: string): void {
  window.location.assign(url);
}

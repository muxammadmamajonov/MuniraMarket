import { bindingCookieName, sessionCookieName, type Settings } from '../config.ts';
import { queueCookie, type Ctx } from '../http/context.ts';

/**
 * Session cookie formatting (port of services/api/app/security/cookies.py). Cookies are queued
 * on the request (`queueCookie`) and added by the app middleware to whatever response leaves,
 * errors included, so a rotated token is never lost when the route then fails.
 */

const EXPIRED = 'Thu, 01 Jan 1970 00:00:00 GMT';

/** `HttpOnly; SameSite=Lax; Path=/`, never `Domain` (host-only cookie). */
export function sessionCookieHeader(options: {
  name: string;
  token: string;
  maxAge: number;
  secure: boolean;
}): string {
  const parts = [
    `${options.name}=${options.token}`,
    `Max-Age=${options.maxAge}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

export function expiredCookieHeader(options: { name: string; secure: boolean }): string {
  const parts = [
    `${options.name}=""`,
    `expires=${EXPIRED}`,
    'Max-Age=0',
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

function settingsOf(c: Ctx): Settings {
  return c.get('deps').settings;
}

/**
 * A request cookie parsed like Starlette (`;`-separated, the LAST occurrence wins, surrounding
 * double quotes removed), or `null` when absent or empty.
 */
export function requestCookie(c: Ctx, name: string): string | null {
  const header = c.req.header('cookie');
  if (header === undefined) return null;
  let found: string | null = null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0 || part.slice(0, index).trim() !== name) continue;
    let value = part.slice(index + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    found = value;
  }
  return found === '' ? null : found;
}

export function sessionTokenFrom(c: Ctx): string | null {
  return requestCookie(c, sessionCookieName(settingsOf(c)));
}

export function setSessionCookie(c: Ctx, issued: { token: string; maxAgeSeconds: number }): void {
  const settings = settingsOf(c);
  queueCookie(
    c,
    sessionCookieHeader({
      name: sessionCookieName(settings),
      token: issued.token,
      maxAge: issued.maxAgeSeconds,
      secure: settings.sessionCookieSecure,
    }),
  );
}

export function clearSessionCookie(c: Ctx): void {
  const settings = settingsOf(c);
  queueCookie(
    c,
    expiredCookieHeader({
      name: sessionCookieName(settings),
      secure: settings.sessionCookieSecure,
    }),
  );
}

/** Short-lived cookie binding an OIDC login to the browser that started it (ADR 0014). */
export function bindingCookieHeader(c: Ctx, value: string, maxAge: number): string {
  const secure = settingsOf(c).sessionCookieSecure;
  return sessionCookieHeader({ name: bindingCookieName(secure), token: value, maxAge, secure });
}

export function clearBindingCookie(c: Ctx): void {
  const secure = settingsOf(c).sessionCookieSecure;
  queueCookie(c, expiredCookieHeader({ name: bindingCookieName(secure), secure }));
}

export function bindingCookieFrom(c: Ctx): string | null {
  return requestCookie(c, bindingCookieName(settingsOf(c).sessionCookieSecure));
}

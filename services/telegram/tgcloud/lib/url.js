// @ts-check

const HTTP_URL_RE =
  /^(https?):\/\/([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(?::([0-9]{1,5}))?(\/[^\s?#]*)?$/i;

/**
 * Parses an http(s) URL without relying on the `URL` global (not documented for the runtime).
 * Rejects userinfo, query strings and fragments.
 *
 * @param {string} value
 * @returns {{ scheme: 'http' | 'https', host: string, port: string, path: string } | null}
 */
export function parseHttpUrl(value) {
  const match = HTTP_URL_RE.exec(value.trim());
  if (!match) return null;
  const scheme = /** @type {'http' | 'https'} */ (match[1]?.toLowerCase());
  const host = (match[2] ?? '').toLowerCase();
  const port = match[3] ?? '';
  if (port !== '' && (Number(port) < 1 || Number(port) > 65535)) return null;
  if (host === '' || host.startsWith('.') || host.endsWith('.') || host.includes('..')) return null;
  return { scheme, host, port, path: match[4] ?? '' };
}

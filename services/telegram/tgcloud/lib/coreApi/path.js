// @ts-check
/**
 * Shared validation of the request path (+ query) that is both signed and requested.
 *
 * `fetch` parses URLs per the WHATWG URL standard, which rewrites some characters (backslash,
 * quotes, angle brackets, braces, pipe, caret, backtick, space) and removes dot segments
 * (including percent-encoded `%2e`). Any of that would make the signed path differ from the
 * path actually sent, so only RFC 3986 path/query characters are accepted and dot segments are
 * refused outright.
 */

const PCHAR = "(?:[A-Za-z0-9\\-._~!$&'()*+,;=:@]|%[0-9A-Fa-f]{2})";
const PATH_ONLY_RE = new RegExp(`^(?:/${PCHAR}*)+$|^/$`);
const QUERY_RE = new RegExp(`^(?:${PCHAR}|[/?])*$`);
const DOT_SEGMENT_RE = /^(?:\.|%2e){1,2}$/i;

/**
 * @param {unknown} value
 * @returns {value is string} true when `value` is a safe, rooted path with optional query
 */
export function isSafeRequestPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return false;
  const queryStart = value.indexOf('?');
  const pathPart = queryStart === -1 ? value : value.slice(0, queryStart);
  if (!PATH_ONLY_RE.test(pathPart)) return false;
  if (queryStart !== -1 && !QUERY_RE.test(value.slice(queryStart + 1))) return false;
  return !pathPart.split('/').some((segment) => DOT_SEGMENT_RE.test(segment));
}

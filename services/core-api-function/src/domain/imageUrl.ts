import { isIPv6 } from 'node:net';

/**
 * Product/category image URLs: syntactic validation only (port of
 * services/api/app/domain/image_url.py). The server never fetches the URL; it refuses anything
 * that is not a plain public `https` link (no credentials, no IPs, no internal names, no custom
 * port), so a browser rendering it cannot be pointed at internal hosts.
 *
 * URL splitting follows Python's `urllib.parse.urlsplit` (not WHATWG `URL`), so the same inputs
 * are accepted and refused with the same messages.
 */

export const MAX_IMAGE_URL_LENGTH = 2048;
const HOST_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
// A label a WHATWG URL parser reads as an IPv4 number part: decimal, or `0x` hex.
const NUMERIC_LABEL = /^(0[xX][0-9a-fA-F]*|[0-9]+)$/;
const HEX_LABEL = /^0[xX][0-9a-fA-F]*$/;
const FORBIDDEN_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.home', '.corp'];
const SCHEME_CHARS = /^[A-Za-z0-9+\-.]+$/;
// Python `str.isspace()` characters, C0 controls and DEL (JS `\s` differs, e.g. on U+FEFF).
const PY_SPACE_OR_CONTROL =
  // eslint-disable-next-line no-control-regex
  /[\x00-\x20\x7f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}$/;

export class InvalidImageUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidImageUrlError';
  }
}

interface SplitUrl {
  scheme: string;
  netloc: string;
}

/** `urlsplit` subset: lower-cased scheme and the netloc (raises like Python on bad brackets). */
function urlsplit(raw: string): SplitUrl {
  let scheme = '';
  let rest = raw;
  const colon = raw.indexOf(':');
  if (colon > 0 && /^[A-Za-z]/.test(raw) && SCHEME_CHARS.test(raw.slice(0, colon))) {
    scheme = raw.slice(0, colon).toLowerCase();
    rest = raw.slice(colon + 1);
  }
  let netloc = '';
  if (rest.startsWith('//')) {
    const after = rest.slice(2);
    const end = after.search(/[/?#]/);
    netloc = end < 0 ? after : after.slice(0, end);
    if (netloc.includes('[') !== netloc.includes(']'))
      throw new InvalidImageUrlError('malformed URL');
    if (netloc.includes('[')) {
      const bracketed = netloc.split('[')[1]?.split(']')[0] ?? '';
      if (!isIPv6(bracketed.split('%')[0] ?? '') && !/^v[0-9a-fA-F]+\..+$/.test(bracketed)) {
        throw new InvalidImageUrlError('malformed URL');
      }
    }
  }
  return { scheme, netloc };
}

/** Python `SplitResult._hostinfo` + `.hostname` / `.port`. */
function hostAndPort(netloc: string): { hostname: string | null; port: number | null } {
  const at = netloc.lastIndexOf('@');
  const hostinfo = at < 0 ? netloc : netloc.slice(at + 1);
  let hostname: string;
  let port: string;
  const open = hostinfo.indexOf('[');
  if (open >= 0) {
    const bracketed = hostinfo.slice(open + 1);
    const close = bracketed.indexOf(']');
    hostname = close < 0 ? bracketed : bracketed.slice(0, close);
    const afterBracket = close < 0 ? '' : bracketed.slice(close + 1);
    const portColon = afterBracket.indexOf(':');
    port = portColon < 0 ? '' : afterBracket.slice(portColon + 1);
  } else {
    const portColon = hostinfo.indexOf(':');
    hostname = portColon < 0 ? hostinfo : hostinfo.slice(0, portColon);
    port = portColon < 0 ? '' : hostinfo.slice(portColon + 1);
  }
  let parsedPort: number | null = null;
  if (port !== '') {
    if (!/^[0-9]+$/.test(port)) throw new InvalidImageUrlError('malformed URL');
    parsedPort = Number(port);
    if (parsedPort > 65535) throw new InvalidImageUrlError('malformed URL');
  }
  if (hostname === '') return { hostname: null, port: parsedPort };
  const percent = hostname.indexOf('%');
  const lowered =
    percent < 0
      ? hostname.toLowerCase()
      : hostname.slice(0, percent).toLowerCase() + hostname.slice(percent);
  return { hostname: lowered, port: parsedPort };
}

function isIpAddress(value: string): boolean {
  return IPV4.test(value) || isIPv6(value);
}

function checkHost(hostname: string): void {
  // One trailing dot (a fully qualified name) is dropped, as a URL parser does.
  const host = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
  if (!host) throw new InvalidImageUrlError('missing host');
  if (isIpAddress(host.replace(/^\[+|\]+$/g, ''))) {
    throw new InvalidImageUrlError('must use a host name, not an IP address');
  }
  const labels = host.split('.');
  // WHATWG "ends in a number": a browser parses such a host as IPv4 (`127.0.0.0x1`, `0x7f.1`).
  if (
    NUMERIC_LABEL.test(labels[labels.length - 1] ?? '') ||
    labels.some((l) => HEX_LABEL.test(l))
  ) {
    throw new InvalidImageUrlError('must use a host name, not an IP address');
  }
  if (labels.length < 2 || !labels.every((label) => HOST_LABEL.test(label))) {
    throw new InvalidImageUrlError('invalid host name');
  }
  if (host === 'localhost' || FORBIDDEN_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new InvalidImageUrlError('must be a public host');
  }
}

/** Return the URL unchanged if it is acceptable, else throw `InvalidImageUrlError`. */
export function validateImageUrl(raw: string): string {
  if ([...raw].length > MAX_IMAGE_URL_LENGTH) throw new InvalidImageUrlError('too long');
  if (PY_SPACE_OR_CONTROL.test(raw)) {
    throw new InvalidImageUrlError('contains whitespace or control characters');
  }
  // eslint-disable-next-line no-control-regex
  if (!/^[\x00-\x7f]*$/.test(raw)) {
    throw new InvalidImageUrlError('must be ASCII (percent-encode other characters)');
  }
  const parts = urlsplit(raw);
  const { hostname, port } = hostAndPort(parts.netloc);
  if (parts.scheme !== 'https') throw new InvalidImageUrlError('must use https');
  if (parts.netloc.includes('@')) throw new InvalidImageUrlError('must not contain credentials');
  if (port !== null && port !== 443) {
    throw new InvalidImageUrlError('must use the default https port');
  }
  checkHost(hostname ?? '');
  return raw;
}

import { describe, expect, it } from 'vitest';
import { buildContentSecurityPolicy, generateNonce } from './csp';

function directive(policy: string, name: string): string[] {
  const part = policy.split('; ').find((entry) => entry.startsWith(`${name} `));
  if (part === undefined) throw new Error(`missing directive ${name}`);
  return part.slice(name.length + 1).split(' ');
}

describe('generateNonce', () => {
  it('is base64, long enough and unique', () => {
    const a = generateNonce();
    const b = generateNonce();
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(a).not.toBe(b);
  });
});

describe('buildContentSecurityPolicy', () => {
  const nonce = 'dGVzdC1ub25jZQ==';
  const production = buildContentSecurityPolicy({ nonce });

  it('puts the nonce, strict-dynamic and telegram.org in script-src', () => {
    expect(directive(production, 'script-src')).toEqual([
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      'https://telegram.org',
    ]);
  });

  it('never allows unsafe-inline scripts, and unsafe-eval only in development', () => {
    expect(directive(production, 'script-src')).not.toContain("'unsafe-inline'");
    expect(directive(production, 'script-src')).not.toContain("'unsafe-eval'");
    const dev = buildContentSecurityPolicy({ nonce, isDevelopment: true });
    expect(directive(dev, 'script-src')).toContain("'unsafe-eval'");
    expect(dev.match(/unsafe-eval/g)).toHaveLength(1);
  });

  it('is never embeddable and only talks to its own origin and the Telegram widget frame', () => {
    expect(directive(production, 'frame-ancestors')).toEqual(["'none'"]);
    expect(directive(production, 'connect-src')).toEqual(["'self'"]);
    expect(directive(production, 'frame-src')).toEqual(['https://oauth.telegram.org']);
    expect(directive(production, 'default-src')).toEqual(["'self'"]);
    expect(directive(production, 'base-uri')).toEqual(["'none'"]);
    expect(directive(production, 'form-action')).toEqual(["'self'"]);
    expect(directive(production, 'object-src')).toEqual(["'none'"]);
  });

  it('is a single-line header value', () => {
    expect(production).not.toMatch(/[\r\n]/);
  });

  it('rejects a nonce that could break out of the header', () => {
    expect(() => buildContentSecurityPolicy({ nonce: "x'; script-src *" })).toThrow();
    expect(() => buildContentSecurityPolicy({ nonce: '' })).toThrow();
    expect(() => buildContentSecurityPolicy({ nonce: 'a\r\nb' })).toThrow();
  });
});

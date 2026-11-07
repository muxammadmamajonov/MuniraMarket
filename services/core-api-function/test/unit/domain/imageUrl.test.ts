import { describe, expect, it } from 'vitest';
import { InvalidImageUrlError, validateImageUrl } from '../../../src/domain/imageUrl.ts';

describe('validateImageUrl', () => {
  it.each([
    'https://cdn.example.com/images/olma.webp',
    'https://cdn.example.com:443/a.png?v=2#x',
    'https://img.example.uz/%D0%B0.png',
    'https://cdn.example.com./a.png',
    'https://cdn1.example.com/a.png',
    'https://0a.example.com/a.png',
    'https://x0.example.com/a.png',
    'https://123.example.com/a.png',
    'https://cdn.0xide.com/a.png',
    'HTTPS://CDN.Example.com/a.png',
  ])('accepts %s', (url) => {
    expect(validateImageUrl(url)).toBe(url);
  });

  it.each([
    'http://cdn.example.com/a.png',
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    '//cdn.example.com/a.png',
    'https://user:secret@cdn.example.com/a.png',
    'https://@cdn.example.com/a.png',
    'https://cdn.example.com:8443/a.png',
    'https://127.0.0.1/a.png',
    'https://[::1]/a.png',
    'https://10.0.0.5/a.png',
    'https://localhost/a.png',
    'https://printer.local/a.png',
    'https://api.internal/a.png',
    'https://intranet/a.png',
    'https://cdn.example.com/a b.png',
    'https://cdn.example.com/a\tb.png',
    'https://cdn.example.com/\u0430.png',
    'https://-bad-.example.com/a.png',
    'https://cdn.example.123/a.png',
    `https://${'a'.repeat(2048)}.com/`,
    'https:///a.png',
    'https://127.0.0.0x1/',
    'https://0x7f.0x0.0x0.0x1/',
    'https://1.2.3.0x4./',
    'https://0x7f000001/',
    'https://2130706433/',
    'https://0177.0.0.1/',
    'https://127.1/',
    'https://example.0x10/',
    'https://example.0x/',
    'https://example.com.0/',
    'https://0x7f.example.com/',
    'https://cdn.0XFF.example.com/',
    'https://cdn.example.com../a.png',
    'https://cdn.example.com:x/a.png',
    'https://[cdn.example.com/a.png',
  ])('refuses %s', (url) => {
    expect(() => validateImageUrl(url)).toThrow(InvalidImageUrlError);
  });

  it('gives the reference messages', () => {
    const message = (url: string) => {
      try {
        validateImageUrl(url);
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    };
    expect(message('http://cdn.example.com/a.png')).toBe('must use https');
    expect(message('https://u:p@cdn.example.com/a')).toBe('must not contain credentials');
    expect(message('https://cdn.example.com:8443/')).toBe('must use the default https port');
    expect(message('https://127.0.0.1/')).toBe('must use a host name, not an IP address');
    expect(message('https://[::1]/')).toBe('must use a host name, not an IP address');
    expect(message('https://intranet/')).toBe('invalid host name');
    expect(message('https://localhost/')).toBe('invalid host name');
    expect(message('https://printer.local/')).toBe('must be a public host');
    expect(message('https:///a.png')).toBe('missing host');
    expect(message('https://cdn.example.com/ä')).toBe(
      'must be ASCII (percent-encode other characters)',
    );
    expect(message('https://cdn.example.com/\ufeff')).toBe(
      'must be ASCII (percent-encode other characters)',
    );
    expect(message('https://cdn.example.com/a\u00a0')).toBe(
      'contains whitespace or control characters',
    );
    expect(message(`https://${'a'.repeat(2048)}`)).toBe('too long');
  });
});

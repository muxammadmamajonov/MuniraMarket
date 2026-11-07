import { describe, expect, it } from 'vitest';
import { newRequestId, parseRequestId, parseSupportCode, supportCodeFor } from './request-id';

describe('request ids and support codes', () => {
  it('generates 32 lowercase hex characters, different every time', () => {
    const a = newRequestId();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(newRequestId()).not.toBe(a);
  });

  it('accepts only well-formed request ids', () => {
    expect(parseRequestId('0123456789abcdef')).toBe('0123456789abcdef');
    expect(parseRequestId('8f00aa11bb22cc33-FRA')).toBe('8f00aa11bb22cc33-FRA');
    expect(parseRequestId('short')).toBeNull();
    expect(parseRequestId('has space here')).toBeNull();
    expect(parseRequestId('x'.repeat(129))).toBeNull();
    expect(parseRequestId(null)).toBeNull();
  });

  it('shortens a request id to an 8-character support code', () => {
    expect(supportCodeFor('0123456789abcdef0123456789abcdef')).toBe('01234567');
    expect(supportCodeFor('8F00-AA11-BB22')).toBe('8f00aa11');
    expect(supportCodeFor('ab-cd')).toBeNull();
    expect(supportCodeFor(null)).toBeNull();
  });

  it('accepts a support code from the URL only in its exact shape', () => {
    expect(parseSupportCode('01234567')).toBe('01234567');
    expect(parseSupportCode('0123456')).toBeNull();
    expect(parseSupportCode('0123456789')).toBeNull();
    expect(parseSupportCode('<script>')).toBeNull();
    expect(parseSupportCode('ABCDEFGH')).toBeNull();
    expect(parseSupportCode(null)).toBeNull();
  });
});

import { SUPPORTED_LOCALES } from '@muniramarket/contracts';
import { LEGAL_PAGES, isLegalApproverRole, isLegalSlug, type LegalPageContent } from './contract';

/**
 * Checks a content object against the contract of its page. It is structural only: it proves the
 * page has every required section in every language plus complete metadata, never that the words
 * are right. That is the legal owner's approval, recorded as `approvedBy`.
 */

export type LegalIssueCode =
  | 'not_an_object'
  | 'unknown_slug'
  | 'slug_mismatch'
  | 'invalid_version'
  | 'invalid_effective_date'
  | 'invalid_approver'
  | 'sections_missing'
  | 'missing_section'
  | 'unknown_section'
  | 'missing_locale'
  | 'empty_text'
  | 'unknown_locale';

export interface LegalIssue {
  code: LegalIssueCode;
  /** Where in the content the problem is, e.g. `sections.retention.ru`. */
  path: string;
}

export type LegalValidation =
  { ok: true; content: LegalPageContent } | { ok: false; issues: LegalIssue[] };

const VERSION_PATTERN = /^\d+\.\d+(\.\d+)?$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A real calendar date: `2026-02-30` has the right shape and is still not one. */
function isCalendarDate(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const match = DATE_PATTERN.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** `slug` is a plain string so that a bad one (from a route param, say) is reported, not trusted. */
export function validateLegalContent(slug: string, content: unknown): LegalValidation {
  const issues: LegalIssue[] = [];
  const add = (code: LegalIssueCode, path: string) => issues.push({ code, path });

  if (!isLegalSlug(slug)) return { ok: false, issues: [{ code: 'unknown_slug', path: 'slug' }] };
  if (!isRecord(content)) return { ok: false, issues: [{ code: 'not_an_object', path: '' }] };
  const spec = LEGAL_PAGES[slug];

  if (content['slug'] !== slug) add('slug_mismatch', 'slug');

  const version = content['version'];
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    add('invalid_version', 'version');
  }
  if (!isCalendarDate(content['effectiveDate'])) add('invalid_effective_date', 'effectiveDate');
  if (!isLegalApproverRole(content['approvedBy'])) add('invalid_approver', 'approvedBy');

  const sections = content['sections'];
  if (!isRecord(sections)) {
    add('sections_missing', 'sections');
  } else {
    const required = new Set(spec.sections.map((section) => section.id));
    for (const id of required) {
      const section = sections[id];
      if (section === undefined) {
        add('missing_section', `sections.${id}`);
        continue;
      }
      if (!isRecord(section)) {
        for (const locale of SUPPORTED_LOCALES) add('missing_locale', `sections.${id}.${locale}`);
        continue;
      }
      for (const locale of SUPPORTED_LOCALES) {
        const text = section[locale];
        if (text === undefined) add('missing_locale', `sections.${id}.${locale}`);
        else if (typeof text !== 'string' || text.trim() === '') {
          add('empty_text', `sections.${id}.${locale}`);
        }
      }
      for (const key of Object.keys(section)) {
        if (!(SUPPORTED_LOCALES as readonly string[]).includes(key)) {
          add('unknown_locale', `sections.${id}.${key}`);
        }
      }
    }
    for (const id of Object.keys(sections)) {
      if (!required.has(id)) add('unknown_section', `sections.${id}`);
    }
  }

  return issues.length === 0
    ? { ok: true, content: content as unknown as LegalPageContent }
    : { ok: false, issues };
}

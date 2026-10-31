import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SUPPORTED_LOCALES } from '@muniramarket/contracts';
import { describe, expect, it } from 'vitest';
import {
  LEGAL_APPROVER_ROLES,
  LEGAL_CONTENT_STATUS,
  LEGAL_PAGES,
  LEGAL_PAGE_SLUGS,
  isLegalContentApproved,
  validateLegalContent,
  type LegalIssue,
  type LegalPageContent,
  type LegalSlug,
} from './index';

/**
 * The fixtures are obviously fake ("Lorem ipsum ..."): they prove the contract's shape, never any
 * legal wording.
 */
function fakeContent(slug: LegalSlug): LegalPageContent {
  return {
    slug,
    version: '0.1',
    effectiveDate: '2030-01-01',
    approvedBy: 'legal_counsel',
    sections: Object.fromEntries(
      LEGAL_PAGES[slug].sections.map((section) => [
        section.id,
        {
          uz: `Lorem ipsum dolor sit amet (${section.id}, uz).`,
          ru: `Lorem ipsum dolor sit amet (${section.id}, ru).`,
        },
      ]),
    ),
  };
}

/** A deep copy that tests may break freely. */
const mutable = (slug: LegalSlug) =>
  JSON.parse(JSON.stringify(fakeContent(slug))) as Record<string, unknown> & {
    sections: Record<string, Record<string, unknown> | undefined>;
  };

function issuesOf(slug: string, content: unknown): LegalIssue[] {
  const result = validateLegalContent(slug, content);
  if (result.ok) throw new Error('expected the content to be rejected');
  return result.issues;
}

describe('the legal pages contract', () => {
  it('covers exactly privacy, offer, delivery, returns and contacts', () => {
    expect([...LEGAL_PAGE_SLUGS]).toEqual(['privacy', 'offer', 'delivery', 'returns', 'contacts']);
    expect(Object.keys(LEGAL_PAGES).sort()).toEqual([...LEGAL_PAGE_SLUGS].sort());
    for (const slug of LEGAL_PAGE_SLUGS) expect(LEGAL_PAGES[slug].slug).toBe(slug);
  });

  it('gives every page and every section an id and a non-empty title in every locale', () => {
    for (const slug of LEGAL_PAGE_SLUGS) {
      const page = LEGAL_PAGES[slug];
      expect(page.sections.length, slug).toBeGreaterThan(0);
      const ids = page.sections.map((section) => section.id);
      expect(new Set(ids).size, `${slug}: duplicate section ids`).toBe(ids.length);
      for (const locale of SUPPORTED_LOCALES) {
        expect(page.title[locale].trim(), `${slug}.title.${locale}`).not.toBe('');
        for (const section of page.sections) {
          expect(section.id, `${slug}.${section.id}`).toMatch(/^[a-z][A-Za-z0-9]*$/);
          expect(section.title[locale].trim(), `${slug}.${section.id}.${locale}`).not.toBe('');
        }
      }
    }
  });

  it('keeps Cyrillic out of the Uzbek titles and Latin out of the Russian ones', () => {
    for (const slug of LEGAL_PAGE_SLUGS) {
      const titles = [LEGAL_PAGES[slug].title, ...LEGAL_PAGES[slug].sections.map((s) => s.title)];
      for (const title of titles) {
        expect(/[А-Яа-яЁё]/.test(title.uz), title.uz).toBe(false);
        expect(/[A-Za-z]/.test(title.ru), title.ru).toBe(false);
      }
    }
  });

  it('names approvers by role, never by person', () => {
    expect([...LEGAL_APPROVER_ROLES]).toEqual(['owner', 'director', 'legal_counsel']);
  });
});

describe('validateLegalContent', () => {
  it.each(LEGAL_PAGE_SLUGS)('accepts complete fake content for %s', (slug) => {
    const result = validateLegalContent(slug, fakeContent(slug));
    expect(result.ok).toBe(true);
  });

  it('rejects anything that is not an object, and an unknown page', () => {
    for (const bad of [null, undefined, 'text', 42, [], true]) {
      expect(issuesOf('privacy', bad)).toEqual([{ code: 'not_an_object', path: '' }]);
    }
    expect(issuesOf('terms', fakeContent('privacy'))).toEqual([
      { code: 'unknown_slug', path: 'slug' },
    ]);
  });

  it('rejects content for a different page than the one it is checked against', () => {
    expect(issuesOf('offer', fakeContent('privacy'))).toContainEqual({
      code: 'slug_mismatch',
      path: 'slug',
    });
  });

  it.each(LEGAL_PAGE_SLUGS)('rejects %s content missing any single section', (slug) => {
    for (const section of LEGAL_PAGES[slug].sections) {
      const content = mutable(slug);
      delete content.sections[section.id];
      expect(issuesOf(slug, content)).toEqual([
        { code: 'missing_section', path: `sections.${section.id}` },
      ]);
    }
  });

  it('rejects a section that lacks a locale, in each locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const content = mutable('delivery');
      delete (content.sections['zones'] as Record<string, unknown>)[locale];
      expect(issuesOf('delivery', content)).toEqual([
        { code: 'missing_locale', path: `sections.zones.${locale}` },
      ]);
    }
  });

  it('rejects a section that is not an object as missing every locale', () => {
    const content = mutable('delivery');
    content.sections['fees'] = 'Lorem ipsum' as unknown as Record<string, unknown>;
    expect(issuesOf('delivery', content)).toEqual([
      { code: 'missing_locale', path: 'sections.fees.uz' },
      { code: 'missing_locale', path: 'sections.fees.ru' },
    ]);
  });

  it('rejects empty, blank and non-string text', () => {
    const content = mutable('returns');
    (content.sections['process'] as Record<string, unknown>)['uz'] = '';
    (content.sections['process'] as Record<string, unknown>)['ru'] = '   \n';
    (content.sections['refunds'] as Record<string, unknown>)['uz'] = 123;
    expect(issuesOf('returns', content)).toEqual([
      { code: 'empty_text', path: 'sections.process.uz' },
      { code: 'empty_text', path: 'sections.process.ru' },
      { code: 'empty_text', path: 'sections.refunds.uz' },
    ]);
  });

  it('rejects sections and locales the contract does not know (they would never be shown)', () => {
    const content = mutable('contacts');
    content.sections['bonus'] = { uz: 'Lorem', ru: 'Lorem' };
    (content.sections['hours'] as Record<string, unknown>)['en'] = 'Lorem';
    expect(issuesOf('contacts', content)).toEqual([
      { code: 'unknown_locale', path: 'sections.hours.en' },
      { code: 'unknown_section', path: 'sections.bonus' },
    ]);
  });

  it('rejects content with no sections object at all', () => {
    const content = mutable('privacy') as Record<string, unknown>;
    delete content['sections'];
    expect(issuesOf('privacy', content)).toEqual([{ code: 'sections_missing', path: 'sections' }]);
    content['sections'] = [];
    expect(issuesOf('privacy', content)).toEqual([{ code: 'sections_missing', path: 'sections' }]);
  });

  it.each(['', '1', 'v1.0', '1.0-beta', '1.', 1.5, null])('rejects the version %j', (version) => {
    const content = { ...mutable('offer'), version };
    expect(issuesOf('offer', content)).toEqual([{ code: 'invalid_version', path: 'version' }]);
  });

  it.each(['1.0', '2.13', '10.0.3'])('accepts the version %s', (version) => {
    expect(validateLegalContent('offer', { ...mutable('offer'), version }).ok).toBe(true);
  });

  it.each(['', '2030-1-1', '01.01.2030', '2030-13-01', '2030-02-30', '2030-00-10', 20300101, null])(
    'rejects the effective date %j',
    (effectiveDate) => {
      const content = { ...mutable('offer'), effectiveDate };
      expect(issuesOf('offer', content)).toEqual([
        { code: 'invalid_effective_date', path: 'effectiveDate' },
      ]);
    },
  );

  it('accepts a leap day only in a leap year', () => {
    expect(
      validateLegalContent('offer', { ...mutable('offer'), effectiveDate: '2032-02-29' }).ok,
    ).toBe(true);
    expect(
      validateLegalContent('offer', { ...mutable('offer'), effectiveDate: '2031-02-29' }).ok,
    ).toBe(false);
  });

  it.each(['', 'Lorem Ipsum', 'admin', 'Legal Counsel', null, 7])(
    'rejects the approver %j (a role from the list, not a name)',
    (approvedBy) => {
      const content = { ...mutable('offer'), approvedBy };
      expect(issuesOf('offer', content)).toEqual([
        { code: 'invalid_approver', path: 'approvedBy' },
      ]);
    },
  );

  it.each(LEGAL_APPROVER_ROLES)('accepts the approver role %s', (approvedBy) => {
    expect(validateLegalContent('offer', { ...mutable('offer'), approvedBy }).ok).toBe(true);
  });

  it('reports every problem at once, not just the first', () => {
    const content = mutable('delivery') as Record<string, unknown> & {
      sections: Record<string, unknown>;
    };
    delete content.sections['zones'];
    delete (content.sections['fees'] as Record<string, unknown>)['ru'];
    content['version'] = 'x';
    content['approvedBy'] = 'Someone';
    expect(issuesOf('delivery', content).map((issue) => issue.code)).toEqual([
      'invalid_version',
      'invalid_approver',
      'missing_section',
      'missing_locale',
    ]);
  });
});

describe('the launch gate', () => {
  it('stays pending until approved legal text exists', () => {
    expect(LEGAL_CONTENT_STATUS).toBe('pending');
    expect(isLegalContentApproved()).toBe(false);
  });

  it('has no route or page that renders legal content while the status is pending', () => {
    // A public page showing placeholder legal text would be worse than no page. While the status is
    // pending, nothing under `src/app` may import the legal module or serve a legal path.
    if (LEGAL_CONTENT_STATUS !== 'pending') return;
    const appDir = join(__dirname, '..', '..', 'app');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else files.push(full);
      }
    };
    walk(appDir);
    const offenders = files
      .filter((file) => /\.(ts|tsx)$/.test(file))
      .filter((file) => {
        const source = readFileSync(file, 'utf8');
        return /lib\/legal/.test(source);
      });
    const legalRoutes = files.filter((file) =>
      new RegExp(`/(${LEGAL_PAGE_SLUGS.join('|')})/(page|route)\\.tsx?$`).test(file),
    );
    expect(offenders).toEqual([]);
    expect(legalRoutes).toEqual([]);
  });
});

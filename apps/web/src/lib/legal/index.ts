export {
  LEGAL_APPROVER_ROLES,
  LEGAL_PAGES,
  LEGAL_PAGE_SLUGS,
  isLegalApproverRole,
  isLegalSlug,
  type Localized,
  type LegalApproverRole,
  type LegalMetadata,
  type LegalPageContent,
  type LegalPageSpec,
  type LegalSectionContent,
  type LegalSectionSpec,
  type LegalSlug,
} from './contract';
export { LEGAL_CONTENT_STATUS, isLegalContentApproved, type LegalContentStatus } from './status';
export {
  validateLegalContent,
  type LegalIssue,
  type LegalIssueCode,
  type LegalValidation,
} from './validate';

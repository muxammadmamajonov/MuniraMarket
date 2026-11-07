/**
 * Catalog CSV template, export and import (`admin` only); port of
 * services/api/app/api/routes/admin_csv.py. Format: src/domain/catalogCsv.ts.
 *
 * The import body is the raw CSV (`Content-Type: text/csv`), at most 1 MiB and 2000 product
 * rows. A file with any error writes nothing: the response is `200` with `applied: false` and the
 * row errors. `dry_run=true` never writes. Uploaded contents are never logged.
 */

import { ApiError } from '../errors.ts';
import {
  auditActorOf,
  backOfficeRouterDeps,
  rateLimit,
  requireAdmin,
  requireAdminWriter,
  RULES,
} from '../http/auth.ts';
import { readRawBody } from '../http/body.ts';
import { deps, type Ctx } from '../http/context.ts';
import { tashkentDate } from '../domain/delivery.ts';
import { CsvFileError, parseCatalogCsv, renderCsv, renderTemplate } from '../domain/catalogCsv.ts';
import { AdminCatalogRepository } from '../repositories/adminCatalog.ts';
import { mapped } from './adminCatalog.ts';
import {
  bool,
  checkDeclaredLength,
  json,
  ok,
  queryParam,
  queryValues,
  throwIfInvalid,
  type Issues,
} from './adminCommon.ts';
import type { Router } from './index.ts';

export const CSV_MEDIA_TYPE = 'text/csv; charset=utf-8';

function csvResponse(content: Uint8Array, filename: string): Response {
  return new Response(content, {
    status: 200,
    headers: {
      'content-type': CSV_MEDIA_TYPE,
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

async function csvTemplate(c: Ctx): Promise<Response> {
  await backOfficeRouterDeps(c);
  await rateLimit(c, RULES.ADMIN_READ, 'user');
  await requireAdmin(c);
  return csvResponse(renderTemplate(), 'catalog-template.csv');
}

async function csvExport(c: Ctx): Promise<Response> {
  await backOfficeRouterDeps(c);
  await rateLimit(c, RULES.ADMIN_READ, 'user');
  await rateLimit(c, RULES.ADMIN_CSV_EXPORT, 'user');
  await requireAdmin(c);
  const { db, clock } = deps(c);
  const rows = await new AdminCatalogRepository(db).exportRows();
  const today = tashkentDate(clock()).replaceAll('-', '');
  return csvResponse(renderCsv(rows), `catalog-${today}.csv`);
}

function isCsv(contentType: string | undefined): boolean {
  const media = (contentType ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return media === 'text/csv' || media === 'application/csv';
}

async function csvImport(c: Ctx): Promise<Response> {
  checkDeclaredLength(c);
  await backOfficeRouterDeps(c);
  await rateLimit(c, RULES.ADMIN_WRITE, 'user');
  await rateLimit(c, RULES.ADMIN_CSV_IMPORT, 'user');
  const admin = await requireAdminWriter(c);
  const issues: Issues = [];
  const dryRun = queryParam(queryValues(c), 'dry_run', bool, false, issues);
  throwIfInvalid(issues);
  if (!isCsv(c.req.header('content-type'))) {
    throw new ApiError(415, 'unsupported_media_type', 'Send the file as text/csv');
  }
  const raw = await readRawBody(c);
  let parsed;
  try {
    parsed = parseCatalogCsv(raw);
  } catch (error) {
    if (error instanceof CsvFileError) {
      throw new ApiError(422, error.code, error.message, {
        extra: {
          details: error.details.map(([location, msg]) => ({ loc: ['body', location], msg })),
        },
      });
    }
    throw error;
  }
  const outcome = await mapped(() =>
    new AdminCatalogRepository(deps(c).db).importCsv(parsed, ok(dryRun), auditActorOf(admin)),
  );
  deps(c).logger.info('Catalog CSV import completed');
  return json({
    dry_run: outcome.dry_run,
    applied: outcome.applied,
    total_rows: outcome.total_rows,
    creates: outcome.creates,
    updates: outcome.updates,
    unchanged: outcome.unchanged,
    errors: outcome.errors.map((error) => ({
      row: error.row,
      column: error.column,
      code: error.code,
      message: error.message,
    })),
    errors_truncated: outcome.errors_truncated,
  });
}

export function register(router: Router): void {
  router.get('/admin/catalog/csv/template', csvTemplate);
  router.get('/admin/catalog/csv/export', csvExport);
  router.post('/admin/catalog/csv/import', csvImport);
}

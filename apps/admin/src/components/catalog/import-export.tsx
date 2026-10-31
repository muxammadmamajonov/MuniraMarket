'use client';

import type { CsvImportResult, CsvRowError } from '@muniramarket/contracts';
import { Button } from '@muniramarket/ui';
import { useId, useRef, useState } from 'react';
import { useI18n } from '@/i18n/context';
import { formatMessage } from '@/i18n/format';
import type { CsvRowCode } from '@/i18n/dictionaries/sections/csv';
import { ApiRequestError } from '@/lib/api/errors';
import { writeErrorMessage } from '@/lib/api/error-messages';
import { request } from '@/lib/api/request';
import { MAX_CSV_BYTES, csvFileProblem, formatBytes, saveBlob } from '@/lib/csv';
import { formatCount } from '@/lib/format';
import { todayInTashkent } from '@/lib/time';
import { useSession } from '@/lib/session';
import { useSingleFlight } from '@/lib/use-single-flight';
import { Alert } from '../ui/alert';
import { CARD, INPUT } from '../ui/classes';
import { DataTable, type Column } from '../ui/data-table';
import { PageHeader } from '../ui/page-header';

/** A dry run that found nothing, bound to the exact text it validated. */
interface Checked {
  file: File;
  content: string;
}

function Summary({ result }: { result: CsvImportResult }) {
  const { dict } = useI18n();
  const copy = dict.csv.summary;
  const rows: Array<[string, number, string]> = [
    [copy.total, result.total_rows, 'csv-total'],
    [copy.creates, result.creates, 'csv-creates'],
    [copy.updates, result.updates, 'csv-updates'],
    [copy.unchanged, result.unchanged, 'csv-unchanged'],
  ];
  return (
    <section className={CARD} aria-label={copy.title}>
      <h3 className="text-lg font-semibold">{copy.title}</h3>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {rows.map(([label, value, testId]) => (
          <div key={testId} className="min-w-0">
            <dt className="text-sm text-muted-foreground">{label}</dt>
            <dd className="text-xl font-bold tabular" data-testid={testId}>
              {formatCount(value)}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function ErrorTable({ result }: { result: CsvImportResult }) {
  const { dict } = useI18n();
  const copy = dict.csv.errors;
  const codes: Record<string, string | undefined> = copy.codes satisfies Record<CsvRowCode, string>;
  const columns: Array<Column<CsvRowError>> = [
    {
      id: 'row',
      header: copy.row,
      nowrap: true,
      cell: (error) => (error.row === 0 ? copy.headerRow : formatCount(error.row)),
    },
    {
      id: 'column',
      header: copy.column,
      cell: (error) =>
        error.column === null ? (
          dict.common.noValue
        ) : (
          <span className="font-mono">{error.column}</span>
        ),
    },
    {
      id: 'problem',
      header: copy.problem,
      // The API's message is English and for logs; the code is translated here.
      cell: (error) => codes[error.code] ?? copy.unknown,
    },
  ];
  return (
    <section className="flex flex-col gap-3" aria-label={copy.title}>
      <h3 className="text-lg font-semibold">{copy.title}</h3>
      {result.errors_truncated ? (
        <Alert tone="warning" testId="csv-truncated">
          {copy.truncated}
        </Alert>
      ) : null}
      <DataTable
        caption={copy.table}
        columns={columns}
        rows={result.errors}
        rowKey={(error) => `${String(error.row)}|${error.column ?? ''}|${error.code}`}
        rowTestId="csv-error-row"
      />
    </section>
  );
}

/** Download template / export, and the two-step import: check (dry run), then apply. */
export function ImportExportView() {
  const { dict, locale } = useI18n();
  const copy = dict.csv;
  const { apiFetch } = useSession();
  const fileInput = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const hintId = useId();
  const download = useSingleFlight();
  const check = useSingleFlight();

  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [checked, setChecked] = useState<Checked | null>(null);
  const [result, setResult] = useState<CsvImportResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const busy = download.pending || check.pending;

  const fetchFile = (path: string, filename: string) =>
    download.run(async () => {
      setDownloadError(null);
      try {
        const response = await apiFetch(path, { headers: { accept: 'text/csv' } });
        if (!response.ok) {
          setDownloadError(
            writeErrorMessage(dict, locale, await ApiRequestError.fromResponse(response)),
          );
          return;
        }
        saveBlob(await response.blob(), filename);
      } catch (cause) {
        setDownloadError(
          writeErrorMessage(
            dict,
            locale,
            cause instanceof ApiRequestError ? cause : ApiRequestError.network(cause),
          ),
        );
      }
    });

  const onFile = (next: File | null) => {
    setChecked(null);
    setResult(null);
    setFailure(null);
    if (next === null) {
      setFile(null);
      setFileError(null);
      return;
    }
    const problem = csvFileProblem(next);
    if (problem !== null) {
      setFile(null);
      setFileError(
        problem === 'not_csv'
          ? copy.upload.notCsv
          : problem === 'empty'
            ? copy.upload.empty
            : copy.upload.tooLarge,
      );
      if (fileInput.current !== null) fileInput.current.value = '';
      return;
    }
    setFileError(null);
    setFile(next);
  };

  /** Sends the CSV. A dry run reads the file now; an apply sends exactly the text that was checked. */
  const send = (dryRun: boolean) =>
    check.run(async () => {
      if (file === null) return;
      setFailure(null);
      let content: string;
      if (dryRun || checked === null) {
        try {
          content = await file.text();
        } catch {
          setFailure(copy.upload.readFailed);
          return;
        }
        if (new Blob([content]).size > MAX_CSV_BYTES) {
          setFailure(copy.upload.tooLarge);
          return;
        }
      } else {
        content = checked.content;
      }

      const response = await request<CsvImportResult>(
        apiFetch,
        `/admin/catalog/csv/import?dry_run=${dryRun ? 'true' : 'false'}`,
        { method: 'POST', headers: { 'content-type': 'text/csv' }, body: content },
      );
      if (!response.ok) {
        setChecked(null);
        setResult(null);
        setFailure(writeErrorMessage(dict, locale, response.error));
        return;
      }
      const data = response.data;
      setResult(data);
      // Apply is possible only for this exact content, after a dry run that found nothing.
      setChecked(dryRun && data.errors.length === 0 && !data.applied ? { file, content } : null);
    });

  const canApply = file !== null && checked !== null && checked.file === file && !busy;
  const dryClean =
    result !== null && result.dry_run && result.errors.length === 0 && checked !== null;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={copy.title} subtitle={copy.intro} />

      <div className="grid gap-3 sm:grid-cols-2">
        <section className={CARD} aria-label={copy.template.title}>
          <h2 className="text-lg font-semibold">{copy.template.title}</h2>
          <p className="text-muted-foreground">{copy.template.description}</p>
          <div>
            <Button
              variant="secondary"
              disabled={busy}
              data-testid="download-template"
              onClick={() =>
                void fetchFile('/admin/catalog/csv/template', 'muniramarket-products-template.csv')
              }
            >
              {download.pending ? copy.downloading : copy.template.button}
            </Button>
          </div>
        </section>
        <section className={CARD} aria-label={copy.export.title}>
          <h2 className="text-lg font-semibold">{copy.export.title}</h2>
          <p className="text-muted-foreground">{copy.export.description}</p>
          <div>
            <Button
              variant="secondary"
              disabled={busy}
              data-testid="download-export"
              onClick={() =>
                void fetchFile(
                  '/admin/catalog/csv/export',
                  `muniramarket-products-${todayInTashkent()}.csv`,
                )
              }
            >
              {download.pending ? copy.downloading : copy.export.button}
            </Button>
          </div>
        </section>
      </div>
      {downloadError === null ? null : <Alert tone="error">{downloadError}</Alert>}

      <section className={CARD} aria-labelledby={`${inputId}-title`}>
        <h2 id={`${inputId}-title`} className="text-lg font-semibold">
          {copy.upload.title}
        </h2>
        <p className="text-muted-foreground">{copy.columnsHint}</p>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={inputId} className="font-medium">
            {copy.upload.fileLabel}
          </label>
          <input
            ref={fileInput}
            id={inputId}
            type="file"
            accept=".csv,text/csv"
            data-testid="csv-file"
            disabled={busy}
            aria-describedby={hintId}
            aria-invalid={fileError !== null}
            onChange={(event) => onFile(event.target.files?.[0] ?? null)}
            className={`${INPUT} py-2`}
          />
          <p id={hintId} className="text-sm text-muted-foreground">
            {copy.upload.hint}
          </p>
          {fileError === null ? null : <Alert tone="error">{fileError}</Alert>}
          {file === null ? null : (
            <p className="text-sm break-words [overflow-wrap:anywhere]">
              {formatMessage(copy.upload.chosen, { name: file.name, size: formatBytes(file.size) })}
            </p>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            disabled={file === null || busy}
            onClick={() => void send(true)}
            data-testid="csv-check"
          >
            {check.pending ? copy.checking : copy.check}
          </Button>
          <Button disabled={!canApply} onClick={() => void send(false)} data-testid="csv-apply">
            {check.pending && checked !== null ? copy.applying : copy.apply}
          </Button>
        </div>
        {canApply ? null : <p className="text-sm text-muted-foreground">{copy.applyHint}</p>}
        {failure === null ? null : <Alert tone="error">{failure}</Alert>}
      </section>

      {result === null ? null : (
        <div className="flex flex-col gap-4" data-testid="csv-result">
          {result.applied ? (
            <Alert tone="success">{copy.appliedOk}</Alert>
          ) : result.errors.length > 0 ? (
            <Alert tone="error">{copy.notApplied}</Alert>
          ) : dryClean ? (
            <Alert tone="success">{copy.dryRunClean}</Alert>
          ) : null}
          <Summary result={result} />
          {result.errors.length > 0 ? <ErrorTable result={result} /> : null}
        </div>
      )}
    </div>
  );
}

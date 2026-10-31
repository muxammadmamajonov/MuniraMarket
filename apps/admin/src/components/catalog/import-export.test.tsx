import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeApi, json, renderAdmin, sessionHandler } from '@/test-utils/fake-api';
import { setLocation } from '@/test-utils/navigation';
import { ImportExportView } from './import-export';

vi.mock('next/navigation', async () => await import('@/test-utils/navigation'));

beforeEach(() => setLocation('/ru/catalog/import'));
afterEach(() => vi.unstubAllGlobals());

const IMPORT = '/api/v1/admin/catalog/csv/import';
const CSV = 'sku,slug\r\nA-1,a-1\r\n';

const result = (overrides: Record<string, unknown> = {}) => ({
  dry_run: true,
  applied: false,
  total_rows: 3,
  creates: 1,
  updates: 1,
  unchanged: 1,
  errors: [],
  errors_truncated: false,
  ...overrides,
});

function choose(content = CSV, name = 'products.csv') {
  const input = screen.getByTestId('csv-file');
  const file = new File([content], name, { type: 'text/csv' });
  fireEvent.change(input, { target: { files: [file] } });
  return file;
}

describe('ImportExportView: dry run then apply', () => {
  it('enables Apply only after a clean dry run of the same file, and sends the checked text', async () => {
    const api = installFakeApi(sessionHandler('admin'), (call) =>
      call.path.startsWith(IMPORT)
        ? json(
            result({
              dry_run: call.path.includes('dry_run=true'),
              applied: call.path.includes('dry_run=false'),
            }),
          )
        : undefined,
    );
    renderAdmin(<ImportExportView />);
    const check = await screen.findByTestId('csv-check');
    const apply = screen.getByTestId('csv-apply');
    expect(check).toBeDisabled();
    expect(apply).toBeDisabled();

    choose();
    expect(await screen.findByText(/Выбран файл: products\.csv/)).toBeInTheDocument();
    expect(apply).toBeDisabled(); // not checked yet
    fireEvent.click(screen.getByTestId('csv-check'));

    expect(
      await screen.findByText('Ошибок нет. Теперь можно применить изменения.'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('csv-total')).toHaveTextContent('3');
    expect(screen.getByTestId('csv-creates')).toHaveTextContent('1');
    expect(screen.getByTestId('csv-updates')).toHaveTextContent('1');
    expect(screen.getByTestId('csv-unchanged')).toHaveTextContent('1');
    await waitFor(() => expect(screen.getByTestId('csv-apply')).toBeEnabled());

    const dry = api.to(IMPORT)[0]!;
    expect(dry.path).toBe(`${IMPORT}?dry_run=true`);
    expect(dry.method).toBe('POST');
    expect(dry.headers.get('content-type')).toBe('text/csv');
    expect(dry.headers.get('x-csrf-token')).toBe('csrf-1');
    expect(dry.body).toBe(CSV);

    fireEvent.click(screen.getByTestId('csv-apply'));
    expect(await screen.findByText('Импорт выполнен: изменения сохранены.')).toBeInTheDocument();
    const applied = api.to(IMPORT)[1]!;
    expect(applied.path).toBe(`${IMPORT}?dry_run=false`);
    expect(applied.body).toBe(CSV);
    // One more apply needs a new check.
    expect(screen.getByTestId('csv-apply')).toBeDisabled();
  });

  it('keeps Apply disabled when the dry run found errors, and lists them translated', async () => {
    const errors = [
      { row: 0, column: null, code: 'required', message: 'x' },
      { row: 2, column: 'price_uzs', code: 'invalid_money', message: 'Money must be digits' },
      { row: 5, column: 'sku', code: 'duplicate_sku', message: 'x' },
      { row: 7, column: 'updated_at', code: 'stale_row', message: 'x' },
      { row: 9, column: 'slug', code: 'brand_new_code', message: 'English only' },
    ];
    installFakeApi(sessionHandler('admin'), (call) =>
      call.path.startsWith(IMPORT) ? json(result({ errors, errors_truncated: true })) : undefined,
    );
    renderAdmin(<ImportExportView />);
    await screen.findByTestId('csv-check');
    choose();
    fireEvent.click(screen.getByTestId('csv-check'));

    expect(
      await screen.findByText('Ничего не сохранено: в файле есть ошибки.'),
    ).toBeInTheDocument();
    const rows = await screen.findAllByTestId('csv-error-row');
    expect(rows).toHaveLength(5);
    expect(within(rows[0]!).getByText('Заголовок')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('price_uzs')).toBeInTheDocument();
    expect(
      within(rows[1]!).getByText(
        'Неверная цена: только цифры, до 13 знаков, без дробей и пробелов.',
      ),
    ).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Этот артикул повторяется в файле.')).toBeInTheDocument();
    expect(
      within(rows[3]!).getByText(/Товар изменился после экспорта\. Экспортируйте товары заново/),
    ).toBeInTheDocument();
    // An unknown code never shows the server's English message.
    expect(within(rows[4]!).getByText('Неизвестная ошибка.')).toBeInTheDocument();
    expect(screen.queryByText('English only')).not.toBeInTheDocument();
    expect(screen.getByTestId('csv-truncated')).toHaveTextContent('первые 200');
    expect(screen.getByTestId('csv-apply')).toBeDisabled();
  });

  it('forgets the check when another file is chosen', async () => {
    installFakeApi(sessionHandler('admin'), (call) =>
      call.path.startsWith(IMPORT) ? json(result()) : undefined,
    );
    renderAdmin(<ImportExportView />);
    await screen.findByTestId('csv-check');
    choose();
    fireEvent.click(screen.getByTestId('csv-check'));
    await waitFor(() => expect(screen.getByTestId('csv-apply')).toBeEnabled());
    choose('sku\r\nB\r\n', 'other.csv');
    expect(screen.getByTestId('csv-apply')).toBeDisabled();
    expect(screen.queryByTestId('csv-result')).not.toBeInTheDocument();
  });

  it('rejects non-.csv and oversized files before sending anything', async () => {
    const api = installFakeApi(sessionHandler('admin'));
    renderAdmin(<ImportExportView />);
    await screen.findByTestId('csv-check');
    choose('x', 'products.xlsx');
    expect(screen.getByText('Можно загрузить только файл с расширением .csv.')).toBeInTheDocument();
    expect(screen.getByTestId('csv-check')).toBeDisabled();

    const big = new File(['x'], 'big.csv');
    Object.defineProperty(big, 'size', { value: 1024 * 1024 + 1 });
    fireEvent.change(screen.getByTestId('csv-file'), { target: { files: [big] } });
    expect(screen.getByText('Файл больше 1 МБ. Разделите его на части.')).toBeInTheDocument();
    expect(api.to(IMPORT)).toHaveLength(0);
  });

  it('maps file-level API errors (422 csv_invalid_header) and 413', async () => {
    let status = 422;
    installFakeApi(sessionHandler('admin'), (call) =>
      call.path.startsWith(IMPORT)
        ? json(
            {
              error: {
                code: status === 422 ? 'csv_invalid_header' : 'payload_too_large',
                message: 'x',
              },
            },
            { status },
          )
        : undefined,
    );
    renderAdmin(<ImportExportView />, 'uz');
    await screen.findByTestId('csv-check');
    choose();
    fireEvent.click(screen.getByTestId('csv-check'));
    expect(
      await screen.findByText('CSV sarlavhasi shablonga mos kelmaydi. Shablonni yuklab oling.'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('csv-apply')).toBeDisabled();
    status = 413;
    fireEvent.click(screen.getByTestId('csv-check'));
    expect(await screen.findByText('Fayl juda katta (1 MB dan oshmasin).')).toBeInTheDocument();
  });
});

describe('ImportExportView: downloads', () => {
  it('fetches the export as CSV and saves it through a blob link', async () => {
    const created: Blob[] = [];
    Object.assign(URL, {
      createObjectURL: (blob: Blob) => {
        created.push(blob);
        return 'blob:test';
      },
      revokeObjectURL: () => undefined,
    });
    const clicked: Array<{ download: string; href: string }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push({ download: this.download, href: this.href });
    });
    const api = installFakeApi(sessionHandler('admin'), (call) =>
      call.path === '/api/v1/admin/catalog/csv/export'
        ? new Response('﻿sku\r\n', { headers: { 'content-type': 'text/csv; charset=utf-8' } })
        : undefined,
    );
    renderAdmin(<ImportExportView />);
    fireEvent.click(await screen.findByTestId('download-export'));
    await waitFor(() => expect(clicked).toHaveLength(1));
    expect(clicked[0]?.download).toMatch(/^muniramarket-products-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(clicked[0]?.href).toBe('blob:test');
    expect(created[0]?.size).toBeGreaterThan(0);
    expect(api.to('/api/v1/admin/catalog/csv/export')[0]?.headers.get('accept')).toBe('text/csv');
    vi.restoreAllMocks();
  });

  it('shows an error when the download fails', async () => {
    installFakeApi(sessionHandler('admin'), (call) =>
      call.path.endsWith('/template')
        ? json(
            { error: { code: 'rate_limited', message: 'x' } },
            { status: 429, headers: { 'retry-after': '7' } },
          )
        : undefined,
    );
    renderAdmin(<ImportExportView />);
    fireEvent.click(await screen.findByTestId('download-template'));
    expect(
      await screen.findByText('Слишком много запросов. Повторите через 7 с.'),
    ).toBeInTheDocument();
  });
});

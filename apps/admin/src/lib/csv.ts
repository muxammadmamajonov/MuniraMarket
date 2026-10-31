/** The API accepts at most 1 MiB of CSV (and the admin proxy forwards that much on this one route). */
export const MAX_CSV_BYTES = 1024 * 1024;

export type CsvFileProblem = 'not_csv' | 'too_large' | 'empty';

/** Client-side file check before anything is sent; the API checks the same limits again. */
export function csvFileProblem(file: Pick<File, 'name' | 'size'>): CsvFileProblem | null {
  if (!/\.csv$/i.test(file.name)) return 'not_csv';
  if (file.size === 0) return 'empty';
  if (file.size > MAX_CSV_BYTES) return 'too_large';
  return null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Saves a Blob through a temporary link; the object URL is released right after the click. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Joins truthy class names. Keeps the UI package free of runtime dependencies. */
export function cx(...parts: ReadonlyArray<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/**
 * Fills `{name}` placeholders in a dictionary string. Unknown placeholders are left as they are so
 * a missing value is visible rather than silently dropped.
 */
export function formatMessage(
  template: string,
  values: Readonly<Record<string, string | number>>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = values[key];
    return value === undefined ? match : String(value);
  });
}

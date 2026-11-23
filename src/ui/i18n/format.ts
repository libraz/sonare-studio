/**
 * Fills `{key}` placeholders in one pass. Values are inserted literally: `$`
 * patterns are not expanded and a placeholder inside a value is not filled.
 * A key with no value becomes empty.
 */
export function formatMessage(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''));
}

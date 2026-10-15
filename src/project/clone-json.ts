/**
 * Deep-copies plain JSON data, including values wrapped in Vue reactive
 * proxies (which `structuredClone` rejects). `undefined` fields are dropped.
 */
export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

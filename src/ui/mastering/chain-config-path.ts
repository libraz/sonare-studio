/**
 * Typed dotted-path access over the core's nested `MasteringChainConfig`.
 * The path union is derived from the config type, so a core rename is a
 * compile error here rather than a silently ignored override.
 */

import type { MasteringChainConfig } from '@libraz/libsonare';

type Leaf = number | boolean | string;

/** Dotted paths to every scalar (or array) field of a config object type. */
export type ChainPath<T = MasteringChainConfig> = {
  [K in keyof T & string]-?: NonNullable<T[K]> extends Leaf | readonly unknown[]
    ? K
    : `${K}.${ChainPath<NonNullable<T[K]>>}`;
}[keyof T & string];

/** Value type at a dotted path of a config object type. */
export type ChainPathValue<T, P extends string> = P extends `${infer Head}.${infer Rest}`
  ? Head extends keyof T
    ? ChainPathValue<NonNullable<T[Head]>, Rest>
    : never
  : P extends keyof T
    ? NonNullable<T[P]>
    : never;

type Node = Record<string, unknown>;

const isNode = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Deep copy that also accepts reactive proxies, which `structuredClone` refuses. */
function cloneNode<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneNode) as T;
  if (isNode(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cloneNode(v)])) as T;
  }
  return value;
}

/** Reads the value at a path, or undefined when any segment is absent. */
export function getChainPath<P extends ChainPath>(
  config: MasteringChainConfig,
  path: P,
): ChainPathValue<MasteringChainConfig, P> | undefined;
export function getChainPath(config: MasteringChainConfig, path: string): unknown;
export function getChainPath(config: MasteringChainConfig, path: string): unknown {
  let cursor: unknown = config;
  for (const segment of path.split('.')) {
    if (!isNode(cursor)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

/** Returns a copy of the config with the value at a path, created as needed. */
export function setChainValue(
  config: MasteringChainConfig,
  path: string,
  value: unknown,
): MasteringChainConfig {
  const next = cloneNode(config) as Node;
  const segments = path.split('.');
  let cursor = next;
  for (const segment of segments.slice(0, -1)) {
    if (!isNode(cursor[segment])) cursor[segment] = {};
    cursor = cursor[segment] as Node;
  }
  cursor[segments[segments.length - 1]] = value;
  return next as MasteringChainConfig;
}

/** Typed form of {@link setChainValue}: the path and value are checked against the config type. */
export function setChainPath<P extends ChainPath>(
  config: MasteringChainConfig,
  path: P,
  value: ChainPathValue<MasteringChainConfig, P>,
): MasteringChainConfig {
  return setChainValue(config, path, value);
}

/** Returns a copy of the config without the path; emptied parents are pruned. */
export function deleteChainPath(config: MasteringChainConfig, path: string): MasteringChainConfig {
  const next = cloneNode(config) as Node;
  const segments = path.split('.');
  const trail: Node[] = [next];
  for (const segment of segments.slice(0, -1)) {
    const child = trail[trail.length - 1][segment];
    if (!isNode(child)) return next as MasteringChainConfig;
    trail.push(child);
  }
  delete trail[trail.length - 1][segments[segments.length - 1]];
  for (let depth = trail.length - 1; depth > 0; depth--) {
    if (Object.keys(trail[depth]).length > 0) break;
    delete trail[depth - 1][segments[depth - 1]];
  }
  return next as MasteringChainConfig;
}

/** One scalar or array field of a config with its dotted path. */
export interface ChainEntry {
  path: string;
  value: unknown;
}

/** Lists every field of a config as a dotted path, in key order. */
export function flattenChainConfig(config: MasteringChainConfig): ChainEntry[] {
  const out: ChainEntry[] = [];
  const walk = (node: Node, prefix: string): void => {
    for (const [key, value] of Object.entries(node)) {
      if (value === undefined) continue;
      const path = prefix ? `${prefix}.${key}` : key;
      if (isNode(value)) walk(value, path);
      else out.push({ path, value });
    }
  };
  walk(config as Node, '');
  return out;
}

/** True when the config carries no field at all. */
export function isEmptyChainConfig(config: MasteringChainConfig | undefined): boolean {
  return config === undefined || flattenChainConfig(config).length === 0;
}

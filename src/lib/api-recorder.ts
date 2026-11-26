/**
 * Records which libsonare calls the app makes, for the end-to-end API map.
 * Only the static build made with VITE_SONARE_E2E=1 records; every other build
 * gets the target back unchanged.
 *
 * A recorded module or instance is a Proxy whose methods run against the real
 * object, with any recorded argument unwrapped first, so libsonare's own
 * private fields and identity checks never see a Proxy. Each call is reported
 * once per page to the harness binding, under `name` for a module function,
 * `new Name` for a construction, `Name.method` for a static and `Name#method`
 * for an instance method.
 */

import type { CaptureOptions } from '@libraz/libsonare';

/** Whether this build records libsonare calls. */
export const API_RECORDING_ENABLED = import.meta.env.VITE_SONARE_E2E === '1';

type Sink = (key: string) => void;
type AnyFunction = (...args: never[]) => unknown;

const seen = new Set<string>();
const targets = new WeakMap<object, object>();
let classNames = new Set<string>();
let lastCapture: CaptureOptions | undefined;

function report(key: string): void {
  if (seen.has(key)) return;
  seen.add(key);
  (globalThis as { __sonareApiSink?: Sink }).__sonareApiSink?.(key);
}

const unwrap = (value: unknown): unknown =>
  typeof value === 'object' && value !== null ? (targets.get(value) ?? value) : value;

function wrapResult(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || targets.has(value)) return value;
  if (value instanceof Promise) return value.then(wrapResult);
  const name = (value as { constructor?: { name?: string } }).constructor?.name;
  return name !== undefined && classNames.has(name) ? recordInstance(value, name) : value;
}

function recordFunction<F extends AnyFunction>(
  fn: F,
  key: string,
  self: object | undefined,
  className: string | null,
): F {
  return new Proxy(fn, {
    apply(target, thisArg, args) {
      report(key);
      if (key === 'SonareEngine#configureCapture') lastCapture = args[0];
      return wrapResult(Reflect.apply(target, self ?? unwrap(thisArg), args.map(unwrap)));
    },
    construct(target, args) {
      report(`new ${className ?? key}`);
      const instance = Reflect.construct(target, args.map(unwrap)) as object;
      return className ? recordInstance(instance, className) : instance;
    },
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (className === null || typeof property !== 'string' || typeof value !== 'function') {
        return value;
      }
      return recordFunction(value as AnyFunction, `${className}.${property}`, target, null);
    },
  });
}

function recordInstance<T extends object>(instance: T, className: string): T {
  const proxy = new Proxy(instance, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (
        typeof property !== 'string' ||
        typeof value !== 'function' ||
        property === 'constructor'
      ) {
        return value;
      }
      return recordFunction(value as AnyFunction, `${className}#${property}`, target, null);
    },
  });
  targets.set(proxy, instance);
  return proxy;
}

const isClass = (value: unknown, name: string): value is new (...args: never[]) => object =>
  typeof value === 'function' && /^[A-Z]/.test(name) && value.prototype !== undefined;

/**
 * Wraps a libsonare module so its functions, classes and the instances those
 * classes create report their calls.
 */
export function recordModule<T extends object>(module: T): T {
  if (!API_RECORDING_ENABLED) return module;
  const names = Object.keys(module).filter((name) =>
    isClass((module as Record<string, unknown>)[name], name),
  );
  classNames = new Set([...classNames, ...names]);
  return new Proxy(module, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof property !== 'string' || typeof value !== 'function') return value;
      return recordFunction(
        value as AnyFunction,
        property,
        undefined,
        isClass(value, property) ? property : null,
      );
    },
  });
}

/** Wraps one instance a libsonare class created outside a recorded module. */
export function recordObject<T extends object>(instance: T, className: string): T {
  if (!API_RECORDING_ENABLED) return instance;
  classNames.add(className);
  return recordInstance(instance, className);
}

/** Forgets what this page has reported, so the next scenario's calls report again. */
export function resetApiCalls(): void {
  seen.clear();
  lastCapture = undefined;
}

/** The calls this page has reported since the last reset. */
export function apiCalls(): string[] {
  return [...seen].sort();
}

/** The capture request most recently sent through the worklet facade. */
export function lastCaptureOptions(): CaptureOptions | undefined {
  return lastCapture;
}

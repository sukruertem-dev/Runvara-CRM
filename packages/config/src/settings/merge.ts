import type { ConfigScope, JsonObject, JsonValue } from './registry';

const isObject = (v: JsonValue | undefined): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Deep merge for objects; arrays and scalars are replaced whole (a half-merged list is never produced). */
export function mergeLayer(base: JsonObject, override: JsonObject): JsonObject {
  const out: JsonObject = { ...base };
  for (const [k, v] of Object.entries(override)) {
    const prev = out[k];
    out[k] = isObject(prev) && isObject(v) ? mergeLayer(prev, v) : v;
  }
  return out;
}

export interface LayerValue {
  scope: ConfigScope | 'platform';
  value: JsonObject;
}

export interface Resolved {
  value: JsonObject;
  /** For every top-level property, the layer whose value won. */
  sources: Record<string, ConfigScope | 'platform'>;
}

/** Resolves platform → tenant → team → user. Layers are given in that order (missing layers omitted). */
export function resolveLayers(platform: JsonObject, layers: readonly LayerValue[]): Resolved {
  let value = platform;
  const sources: Record<string, ConfigScope | 'platform'> = Object.fromEntries(Object.keys(platform).map((k) => [k, 'platform' as const]));
  for (const layer of layers) {
    value = mergeLayer(value, layer.value);
    for (const k of Object.keys(layer.value)) sources[k] = layer.scope;
  }
  return { value, sources };
}

// ---------------------------------------------------------------------------------------------------------
// RFC 6902 JSON Patch diff
// ---------------------------------------------------------------------------------------------------------

export type PatchOp =
  | { op: 'add'; path: string; value: JsonValue }
  | { op: 'remove'; path: string }
  | { op: 'replace'; path: string; value: JsonValue };

const pointer = (segment: string): string => segment.replace(/~/g, '~0').replace(/\//g, '~1');

function equal(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && equal(a[k], b[k]));
  }
  return false;
}

/** Patch turning `from` into `to`. Objects are compared key by key; arrays are replaced whole. */
export function diffJson(from: JsonObject, to: JsonObject, base = ''): PatchOp[] {
  const ops: PatchOp[] = [];
  for (const k of Object.keys(from)) {
    if (!Object.hasOwn(to, k)) ops.push({ op: 'remove', path: `${base}/${pointer(k)}` });
  }
  for (const [k, v] of Object.entries(to)) {
    const path = `${base}/${pointer(k)}`;
    const prev = from[k];
    if (!Object.hasOwn(from, k)) ops.push({ op: 'add', path, value: v });
    else if (isObject(prev) && isObject(v)) ops.push(...diffJson(prev, v, path));
    else if (!equal(prev, v)) ops.push({ op: 'replace', path, value: v });
  }
  return ops;
}

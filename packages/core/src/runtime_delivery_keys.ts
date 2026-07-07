import type { DeliveryTarget } from './runtime_bindings';

export function assistantDeliveryKey(
  conversationId: string,
  assistantIndex: number,
  target?: DeliveryTarget,
): string {
  const base = `${conversationId}:turn:${assistantIndex + 1}:delivery:final`;
  if (!target) {
    return base;
  }
  return `${base}:${fnv1a(stableStringify(target))}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value
      .map((child) => (child === undefined ? 'null' : stableStringify(child)))
      .join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

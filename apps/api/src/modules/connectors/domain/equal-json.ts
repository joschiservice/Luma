/** Compare JSON intent values without treating object key order as a change. */
export function equalJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => equalJson(value, right[index]))
    );
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object')
    return false;
  const leftFields = left as Record<string, unknown>;
  const rightFields = right as Record<string, unknown>;
  const keys = Object.keys(leftFields);

  return (
    keys.length === Object.keys(rightFields).length &&
    keys.every(
      (key) =>
        Object.hasOwn(rightFields, key) &&
        equalJson(leftFields[key], rightFields[key]),
    )
  );
}

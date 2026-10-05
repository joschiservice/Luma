import { formatJson } from '../lib/format';

/** Shows a JSON value as scrollable, keyboard-reachable preformatted text. */
export function JsonView({ value, label }: { value: unknown; label: string }) {
  return (
    <pre className="sim-json" tabIndex={0} aria-label={label}>
      {formatJson(value)}
    </pre>
  );
}

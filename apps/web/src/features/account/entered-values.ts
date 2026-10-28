import { type RefObject, useEffect } from 'react';

/**
 * Copies text that was typed or autofilled into a server-rendered form before React hydrated.
 * React keeps such text on screen but not in form state, so a submit would see empty fields.
 * Runs once after the first client render and adopts only non-empty named inputs.
 */
export function useAdoptEnteredValues<Name extends string>(
  form: RefObject<HTMLFormElement | null>,
  names: readonly Name[],
  adopt: (name: Name, value: string) => void,
) {
  useEffect(() => {
    for (const name of names) {
      const input = form.current?.elements.namedItem(name);
      if (input instanceof HTMLInputElement && input.value)
        adopt(name, input.value);
    }
    // Only values entered before hydration need adopting; later input reaches state directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

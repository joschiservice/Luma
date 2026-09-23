/** Owns resources in construction order and drains them once in reverse order. */
export function createResourceScope() {
  const disposers: (() => void | Promise<void>)[] = [];
  let closing: Promise<void> | undefined;

  return {
    /** Registers cleanup immediately after acquiring a resource. */
    add(close: () => void | Promise<void>) {
      if (closing) throw new Error('Resource scope is closing');
      disposers.push(close);
    },
    /** Attempts every cleanup, then reports all failures; repeated calls share the result. */
    close() {
      return (closing ??= Promise.resolve().then(async () => {
        const errors: unknown[] = [];
        for (const dispose of disposers.reverse()) {
          try {
            await dispose();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length)
          throw new AggregateError(errors, 'Resource cleanup failed');
      }));
    },
  };
}

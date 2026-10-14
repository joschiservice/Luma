/** Server-side atomic operations on one scoped key; callers must supply trusted, opaque keys. */
export interface AtomicStore {
  /** Executes a script atomically on the primary for one key; unavailable storage rejects the call. */
  run(
    script: string,
    key: string,
    arguments_: readonly string[],
  ): Promise<unknown>;
  /** Checks connectivity without granting provider capacity or action authority. */
  ready(): Promise<boolean>;
  /** Stops new calls and releases resources after pending commands settle. */
  close(): Promise<void>;
}

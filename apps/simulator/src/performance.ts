/** Times fixed operation names without reading application inputs or results. */
export type Measure = <T>(operation: string, work: () => T) => T;

/** Runs work directly when no diagnostics adapter is installed. */
export const unmeasured: Measure = (_operation, work) => work();

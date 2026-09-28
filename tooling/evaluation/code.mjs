import { isDeepStrictEqual } from 'node:util';

import { CodeRequestStopped } from '@luma/workflows';
import {
  checkCodeStep,
  createWasmtimeRunner,
} from '@luma/workflows/composition';

/** Replays an exact Code Step twice against ordered fixture replies, without live capabilities. */
export async function evaluateCodeCorpus(corpus, directory) {
  const step = checkCodeStep(corpus.step);
  const runner = createWasmtimeRunner({ directory });
  const scenarios = [];
  for (const fixture of corpus.cases) {
    async function replay() {
      let index = 0;
      let denied = false;
      const result = await runner.run(step, fixture.input, {
        now: fixture.now,
        async request(grant) {
          const reply = fixture.replies[index++];
          if (!reply || reply.grant !== grant) {
            denied = true;
            throw new CodeRequestStopped('capability_denied');
          }

          return reply.value;
        },
      });

      return {
        values: result.values,
        inputDigest: result.telemetry.inputDigest,
        outcome: result.telemetry.outcome,
        requests: index,
        denied,
        complete: index === fixture.replies.length,
      };
    }

    const first = await replay(),
      second = await replay();
    scenarios.push({
      id: fixture.id,
      passed:
        first.outcome === 'completed' &&
        !first.denied &&
        first.complete &&
        isDeepStrictEqual(first.values, fixture.expected) &&
        isDeepStrictEqual(first, second),
      result: first,
    });
  }

  return {
    artifactDigest: step.artifactDigest,
    runtime: step.runtime,
    passed: scenarios.length > 0 && scenarios.every((item) => item.passed),
    scenarios,
  };
}

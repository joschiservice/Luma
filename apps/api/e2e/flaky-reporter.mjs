/**
 * Lists journeys that passed only after a retry, which Vitest's default reporter does not show.
 * Retries keep one-off failures under load from failing a run; this list keeps them visible so
 * each can be fixed.
 */
export default class FlakyReporter {
  onTestRunEnd(testModules) {
    const flaky = testModules.flatMap((testModule) =>
      [...testModule.children.allTests()].filter(
        (test) => test.result().state === 'passed' && test.diagnostic()?.flaky,
      ),
    );
    if (!flaky.length) return;
    console.log(`\nFlaky journeys (passed after a retry): ${flaky.length}`);
    for (const test of flaky)
      console.log(
        `  ${test.module.moduleId.split('/e2e/').at(-1)} › ${test.fullName}`,
      );
  }
}

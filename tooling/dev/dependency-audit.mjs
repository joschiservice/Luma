import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Rejects unreviewed advisories and expired or overly broad reachability exceptions. */
export function reviewAdvisories(report, exceptions, now = new Date()) {
  if (
    !report ||
    typeof report.advisories !== 'object' ||
    report.advisories === null ||
    !report.metadata
  )
    throw new Error(
      'Dependency audit did not return a complete advisory report',
    );
  const failures = [];
  for (const exception of exceptions) {
    if (
      !/^GHSA-[a-z0-9-]+$/.test(exception.advisory) ||
      !exception.module ||
      !exception.version ||
      !exception.dependencyPathSuffix ||
      !exception.reason ||
      !exception.reviewBy ||
      !/^\d{4}-\d{2}-\d{2}$/.test(exception.expires) ||
      !Number.isFinite(Date.parse(exception.expires)) ||
      Date.parse(exception.expires) <= now.getTime()
    )
      failures.push(`Invalid or expired exception: ${exception.advisory}`);
  }
  for (const advisory of Object.values(report.advisories)) {
    for (const finding of advisory.findings) {
      const exception = exceptions.find(
        (entry) =>
          entry.advisory === advisory.github_advisory_id &&
          entry.module === advisory.module_name &&
          entry.version === finding.version &&
          Array.isArray(finding.paths) &&
          finding.paths.length > 0 &&
          finding.paths.every((path) =>
            path.endsWith(`>${entry.dependencyPathSuffix}`),
          ) &&
          Date.parse(entry.expires) > now.getTime(),
      );
      if (!exception)
        failures.push(
          `${advisory.github_advisory_id}: ${advisory.module_name}@${finding.version} (${advisory.severity}) ${advisory.url}`,
        );
    }
  }

  return failures;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = spawnSync('pnpm', ['audit', '--json'], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    timeout: 120_000,
  });
  if (result.error || result.signal || ![0, 1].includes(result.status))
    throw new Error('Dependency advisory scan failed', { cause: result.error });
  const exceptions = JSON.parse(
    readFileSync(
      new URL('./dependency-exceptions.json', import.meta.url),
      'utf8',
    ),
  );
  const failures = reviewAdvisories(JSON.parse(result.stdout), exceptions);
  for (const failure of failures) console.error(failure);
  if (failures.length) process.exitCode = 1;
  else
    console.log(
      `Dependency advisories reviewed; ${exceptions.length} bounded exception(s).`,
    );
}

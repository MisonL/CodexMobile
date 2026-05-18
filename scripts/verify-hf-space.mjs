import { fileURLToPath } from 'node:url';
import {
  normalizeSpaceBaseUrl,
  parseArgs,
  verifySpace
} from './verify-hf-space-core.mjs';

export {
  normalizeSpaceBaseUrl,
  parseArgs,
  verifySpace
};

function printReport(report, json) {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  for (const check of report.checks) {
    console.log(`${check.status.toUpperCase()} ${check.id}: ${check.detail}`);
  }
  console.log(`Summary: passed=${report.summary.passed} failed=${report.summary.failed} skipped=${report.summary.skipped}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await verifySpace(options);
  printReport(report, options.json);
  process.exitCode = report.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}

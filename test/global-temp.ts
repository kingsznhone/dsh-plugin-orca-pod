import { readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Fixture-owned cleanup for the OS temp directory.
 *
 * Every test that needs scratch space creates it under `tmpdir()` (`mkdtemp`, direct
 * `join`), and a test may forget to remove it — `afterEach` deletes race the SQLite
 * handles a node closes late, and on Windows a delete that loses that race silently
 * leaves a full data root behind. Rather than trusting ~30 files to clean up
 * individually, the fixture snapshots the directory before the run and removes only
 * the entries this run created, after every test has finished.
 *
 * Data roots outside `tmpdir()` are untouched: this only ever looks at `tmpdir()`, and
 * only at entries absent from the pre-run snapshot. A directory that cannot be
 * removed is reported as a test failure instead of being swallowed.
 */
const ORCA_TEMP_ENTRY = /^orca-/;
const REMOVE_RETRIES = 8;
const REMOVE_RETRY_DELAY_MS = 100;

let baseline = new Set<string>();

function orcaTempDirs(): string[] {
  const root = tmpdir();
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && ORCA_TEMP_ENTRY.test(entry.name))
    .map((entry) => join(root, entry.name));
}

export function setup(): void {
  baseline = new Set(orcaTempDirs());
}

export function teardown(): void {
  const removed: string[] = [];
  const failures: string[] = [];

  for (const dir of orcaTempDirs()) {
    if (baseline.has(dir)) continue;
    try {
      // Windows releases SQLite handles asynchronously; retry instead of leaking the directory.
      rmSync(dir, { recursive: true, force: true, maxRetries: REMOVE_RETRIES, retryDelay: REMOVE_RETRY_DELAY_MS });
      removed.push(dir);
    } catch (error) {
      failures.push(`${dir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `test temp cleanup removed ${removed.length} director${removed.length === 1 ? "y" : "ies"} but failed on ${failures.length}:\n${failures.join("\n")}`,
    );
  }
  if (removed.length > 0)
    console.log(`[test-temp] removed ${removed.length} temp director${removed.length === 1 ? "y" : "ies"}`);
}

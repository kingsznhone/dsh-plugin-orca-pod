/** `orca-node log`: the tasks this node dispatched, read straight from its dispatch log. */

import process from "node:process";

import { SqliteDispatchStore } from "../task/dispatch-store.ts";
import { storeDbPath } from "../core/sqlite.ts";
import { COMMON_OPTIONS, loadNodeConfig, type CommandArgs, type OptionName } from "./shared.ts";

export const options: readonly OptionName[] = [...COMMON_OPTIONS, "json"];

export async function run({ flags }: CommandArgs): Promise<number> {
  const config = await loadNodeConfig(flags);
  // Read the origin-side dispatch log straight from SQLite: the node may be down,
  // and a restart is exactly when this listing matters (§8.3).
  const store = new SqliteDispatchStore(storeDbPath(config.data_root));
  try {
    const entries = store.list().sort((left, right) => left.updated_at.localeCompare(right.updated_at));
    if (flags.json === true) {
      process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
      return 0;
    }
    if (entries.length === 0) {
      process.stdout.write("no dispatched tasks\n");
      return 0;
    }
    for (const entry of entries) {
      const error = entry.last_error === undefined ? "" : `  (${entry.last_error})`;
      process.stdout.write(`${entry.state.padEnd(14)} ${entry.task_id}  ${entry.peer}${error}\n`);
    }
    return 0;
  } finally {
    store.close();
  }
}

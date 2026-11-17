/** Node: the assembly root, config file and settings table. */

export {
  configPath,
  createOrcaNodeConfig,
  defaultDataRoot,
  endpointWriteback,
  loadConfig,
  saveConfig,
} from "./config.ts";
export type { OrcaNodeConfig } from "./config.ts";
export { createOrcaNode, createPersistentStorage, joinRoster } from "./orca-node.ts";
export type {
  ApprovalOptions,
  CreateNodeOptions,
  FetchLike,
  NodeLogger,
  OrcaNode,
  OrcaNodeStorage,
} from "./orca-node.ts";
export {
  ConfigValidationError,
  parseSettings,
  passwordRefFor,
  pickPanelFields,
  safeParseSettings,
} from "./settings.ts";
export type { AcpExecutorConfig, AcpMcpServer, Settings, SettingsIssue } from "./settings.ts";

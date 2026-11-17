/** Wire protocol: peer, task, grant, model and permission shapes shared by every context. */

export { DEFAULT_PORT } from "./constants.ts";
export type { Grant, GrantMode, PermissionRequest, SignedGrant, TaskRelay } from "./grant.ts";
export {
  MAX_MODEL_OFFERS,
  ModelOffersSchema,
  ModelSelectionSchema,
  ReasoningEffortSchema,
  isReasoningEffort,
  parseModelSelection,
  parseModelSpec,
  validateModelOffers,
  validateModelSelection,
} from "./model.ts";
export type { ModelOffer, ModelSelection } from "./model.ts";
export {
  BusyStateSchema,
  OrcaNodeIdSchema,
  RuntimeInfoSchema,
  WorkgroupIdSchema,
  isHttpEndpoint,
  isOrcaNodeId,
  isWorkgroupId,
  membersDigest,
  normalizeEndpoints,
  runtimeDigest,
} from "./peer.ts";
export type {
  BusyState,
  HeartbeatResponse,
  JoinResponse,
  MembersResponse,
  OrcaNodeId,
  PeerState,
  PeerView,
  RuntimeInfo,
  SelfRecord,
} from "./peer.ts";
export { PermissionModeSchema, isPermissionMode, narrowPermissionMode } from "./permission.ts";
export type { PermissionMode } from "./permission.ts";
export { isTerminal, permissionRequestOf } from "./task.ts";
export type {
  A2AMessage,
  PodTaskMetadata,
  SubmitTaskInput,
  TaskInputRef,
  TaskRunner,
  TaskState,
  TaskView,
} from "./task.ts";

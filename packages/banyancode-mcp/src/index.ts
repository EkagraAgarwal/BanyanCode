// Public surface of @banyancode/mcp.
export { main, parseArgv } from "./main"
export { createMcpServer, SERVER_INSTRUCTIONS, SERVER_NAME, SERVER_VERSION } from "./server"
export { TaskEngine, UnknownTaskError, SharedWriteConflictError, McpKilledError } from "./engine"
export type {
  CheckupReport,
  CheckupTaskReport,
  PendingAsk,
  ReplyInput,
  ResultDetail,
  TaskRecord,
  TaskResult,
  TaskStartInput,
  TaskStatus,
  TaskTreeNode,
} from "./engine"
export { createSessionPort, makeClient, makeRpcCaller, parseModel } from "./session-client"
export type { SessionPort } from "./session-client"
export { attachOrStart, defaultServiceFile, resolveServeCommand, selfCommand, basicAuthHeaders } from "./attach"
export { registerTaskTools, TaskToolNames, MAX_WAIT_SECONDS } from "./tools-task"
export { registerCodeTools, CodeToolNames } from "./tools-code"
export { registerVerifyTool, VerifyToolName } from "./tools-verify"
export { createRpcCaller, isRpcUnavailable, messageOf } from "./rpc"
export type { RpcCaller } from "./rpc"
export { planInstall, applyInstall, describePlan, mergeMcpJson, upsertTomlBlock, InstallClients, SERVER_KEY } from "./install"
export type { InstallClient, InstallFile, InstallPlan } from "./install"
export { SKILL_MD, SKILL_NAME } from "./skill"
export { registerResources, TASKS_URI, taskURI } from "./resources"
export { emptyDigest, foldDigest, summarizeDigest, encodeCursor, decodeCursor } from "./digest"
export type { DigestState, DigestSummary, DurableEvent } from "./digest"
export { detectStuck, suggestCheckupSeconds } from "./stuck"
export { evaluateBudget, parseBudget } from "./budget"
export type { Budget, BudgetExceeded } from "./budget"
export { BUILTIN_PROFILES, BUILTIN_PROFILE_NAMES, decide, profileRules, resolveProfile, wildcardMatch } from "./autonomy"
export type { AutonomyEffect, ResolvedProfile } from "./autonomy"
export { resolveConfig, findConfigPath, stripJsonc, readConfigFile } from "./config"
export type { McpServerConfig, ResolvedConfig } from "./config"
export { mapEvent } from "./events"
export type { EngineEvent } from "./events"
export { newTaskHandle, isTaskHandleShape } from "./task-handle"

// Trail core: sessions, the event store, permissions and configuration.

export { configPath, databasePath, loadConfig, pickModel, trailHome, type TrailConfig } from "./config.ts"
export { checkPermission, dangerReason, isReadOnlyCommand, type PermissionCheck, type PermissionInput } from "./permissions.ts"
export { buildSystemPrompt, type PromptInput, type PromptWorkspace } from "./prompt.ts"
export {
  createSession,
  openSession,
  truncate,
  type ApprovalRequest,
  type NewSession,
  type Session,
  type SessionDeps,
  type TurnResult,
} from "./session.ts"
export { openStore, type EventStore, type SessionRow } from "./store.ts"
export { buildContext } from "./view.ts"

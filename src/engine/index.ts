export type { AgentEnginePort, GuiEventListener, SnapshotListener } from "./port";
export { FakeAgentEngine } from "./fake-engine";
export { GrokAcpEngine } from "./acp-engine";
export type { GrokAcpEngineDeps } from "./acp-engine";
export { createEmptySnapshot, reduce } from "./reducer";
export {
  discoverEngine,
  candidatePaths,
  type DiscoveryHost,
  type DiscoveryResult,
  type EngineCandidate,
} from "./discovery";
export {
  verifyEngineIdentity,
  parseEngineVersion,
  versionMeetsMinimum,
  type IdentityHost,
  type IdentityCheckResult,
  type SignatureIdentity,
} from "./identity";
export { planEngineSpawn, assertDirectSpawn, type SpawnPlan } from "./spawn-plan";
export { redactSecrets, redactDeep, safeErrorMessage } from "./redact";
export {
  PINNED_ENGINE_VERSION,
  EXPECTED_PUBLISHER,
  ACQUISITION_HELP,
  ENGINE_STDIO_ARGS,
} from "./constants";
export {
  TerminalBridge,
  unavailableTerminalSpawner,
  type SpawnTerminalProcess,
  type TerminalCreateRequest,
  type TerminalBridgeHooks,
} from "./terminal-bridge";
// Do not re-export node-host here — it pulls node: builtins into the Vite
// browser bundle. Import `./node-host` only from Node/Tauri host code.
export type * from "./types";

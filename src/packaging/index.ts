export {
  DEFAULT_WINDOWS_DAILY_DRIVER_BUNDLE,
  assertNoEmbeddedGrokEngine,
  describeWebView2BootstrapBehavior,
  tauriWindowsBundleFragment,
  validateWindowsDailyDriverBundle,
  type BundleValidationResult,
  type NsisInstallMode,
  type ValidatedWindowsBundle,
  type WebView2BootstrapBehavior,
  type WebView2InstallModeType,
  type WindowsDailyDriverBundle,
} from "./windows-bundle";

export {
  PE_MACHINE,
  architectureMatches,
  hostArchFromNodeArch,
  machineFromCode,
  parsePeArchitecture,
  type HostArch,
  type PeArchitectureResult,
  type PeMachine,
} from "./pe-architecture";

export {
  actionableFromIdentity,
  actionableMissingEngine,
  actionableWrongArchitecture,
  assessEngineReadiness,
  type ActionableEngineFailure,
  type EngineNotReady,
  type EngineReadinessFailureCode,
  type EngineReadinessHost,
  type EngineReadinessResult,
  type EngineReady,
} from "./engine-readiness";

export {
  DEFAULT_UPDATE_POLICY,
  assertNoSilentEngineDrift,
  validateUpdatePolicy,
  type DriftCheckResult,
  type EnginePinPolicy,
  type GuiUpdateChannel,
  type PackagingUpdatePolicy,
} from "./update-policy";

export {
  CLEAN_PROFILE_SMOKE_STEPS,
  ENGINE_FAILURE_SCENARIOS,
  classifyHostEnvironment,
  detectWslIndicator,
  planCleanProfileSmoke,
  skipLiveStepsOnNonWindows,
  type FailureScenarioId,
  type FailureScenarioPlan,
  type HostEnvironmentKind,
  type SimulatedStepResult,
  type SmokeRunDecision,
  type SmokeStepId,
  type SmokeStepPlan,
} from "./clean-profile-smoke";

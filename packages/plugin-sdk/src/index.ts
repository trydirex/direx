// SPDX-License-Identifier: MIT
// What a plugin author calls. The host's dispatcher, wire codec and agent query text are in
// "./host" (ADR 0028 rule 004).
export type { DedupeClass, EffectCapability, ExecuteContext, ExecuteResult, FollowUpResult, ProviderLimit, ReconcileResult } from "./effect";
export { MAX_EFFECT_TIMEOUT_MS } from "./effect";
export { PLUGIN_REASONS, PluginError, type PluginErrorFields, type PluginReason } from "./errors";
export { QUERY_CODES } from "./queries";
export {
  effectSchemas,
  querySchemas,
  type EffectInput,
  type EffectName,
  type EffectSpec,
  type QueryInput,
  type QueryName,
  type QueryOutput,
  type SpecName,
  type Touch,
  type TriggerData,
  type TriggerName,
} from "./catalogue/index";
export { skipMail, type SkipMail } from "./catalogue/mail";
export {
  accessToken,
  definePlugin,
  type CallContext,
  type Credential,
  type EffectHandler,
  type Plugin,
  type PluginContext,
  type PluginDefinition,
  type QueryHandler,
  type TriggerEvent,
  type TriggerHandler,
} from "./define";
export { parseManifest, type CapabilityDecl, type EffectDecl, type Manifest, type ManifestResult, type TriggerDecl } from "./manifest";
export { MediaMismatch, mediaLink, mediaRef, mediaRefs, streamParts, type MediaLink, type MediaRef } from "./media";
export { runWorker, type WorkerIo } from "./worker";
export { SDK_VERSION } from "./version";
export {
  VERIFICATION_RESULTS,
  VERIFY_ADDRESS,
  VERIFY_BALANCE,
  verifyAddressInput,
  verifyAddressOutput,
  verifyBalanceOutput,
  type VerificationResult,
  type VerifyAddressInput,
  type VerifyAddressOutput,
  type VerifyBalanceOutput,
} from "./catalogue/verify";

// SPDX-License-Identifier: MIT
// What only a host uses: the method dispatcher, the wire codec, the catalogue's names and agent
// query text, and the reader for a plugin's error data. Plugin authors import "." instead.
export { AGENT_QUERIES, agentQuery, INPUT_SCOPES, QUERY_NAMES, type AgentQuery, type InputScope } from "./queries";
export {
  CATALOGUE,
  EFFECT_NAMES,
  effectEntry,
  EFFECTS,
  queryEntry,
  storedSpec,
  touchField,
  touchOf,
  TRIGGER_NAMES,
  triggerEntry,
  TRIGGERS,
  type Catalogue,
  type Effects,
  type Triggers,
} from "./catalogue/index";
export { type EffectEntry, type QueryEntry, type TriggerEntry } from "./catalogue/entry";
export { TOUCH_CLASSES } from "./catalogue/message";
export { PROVIDER_KINDS } from "./catalogue/providers";
export { invoke, type CapabilityMethod, type CredentialKind } from "./define";
export { readErrorData } from "./errors";
export { manifestSchema } from "./manifest";
export {
  encode,
  isNotification,
  isRequest,
  LineTooLong,
  MAX_LINE_BYTES,
  parseMessage,
  readLines,
  RPC_ERRORS,
  RpcError,
  type RpcMessage,
  type RpcNotification,
  type RpcRequest,
  type RpcResponse,
} from "./rpc";

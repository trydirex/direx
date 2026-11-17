// SPDX-License-Identifier: AGPL-3.0-only
// Tests call a plugin's methods the way the host does: on the wire a credential names its kind
// (ADR 0028 rule 003), which the host adds from the credential's fields.
import { invoke as sdkInvoke } from "@direx/plugin-sdk/host";

const kindOf = (c: object) => ("accessToken" in c ? "oauth2" : "key" in c ? "api_key" : "headerName" in c ? "header" : "password" in c ? "basic" : "secret");

export const invoke: typeof sdkInvoke = (plugin, method, params, ctx) => {
  const c = (params as { credential?: unknown } | null)?.credential;
  const wire = c && typeof c === "object" && !("kind" in c) ? { ...(params as object), credential: { kind: kindOf(c), ...c } } : params;
  return sdkInvoke(plugin, method, wire, ctx);
};

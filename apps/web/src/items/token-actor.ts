// SPDX-License-Identifier: AGPL-3.0-only
// An Item an External token proposed through the door is made by the system actor `external_token:<id>`
// (ADR 0032). History names the token; the list of tokens is read only when a History holds one.
import { useQuery } from "@tanstack/react-query";
import { tokensQuery } from "../settings/actions";

const TOKEN_ACTOR = "external_token:";

export const isTokenActor = (a: { kind: string; id: string }) => a.kind === "system" && a.id.startsWith(TOKEN_ACTOR);

/** Words for a token actor: `External token "Zapier"`, or "External token" for one it can't find. */
export function useTokenWords(workspaceId: string, actors: readonly { kind: string; id: string }[]) {
  const tokens = useQuery({ ...tokensQuery(workspaceId), enabled: actors.some(isTokenActor) }).data?.tokens;
  return (id: string) => {
    const name = tokens?.find((t) => TOKEN_ACTOR + t.id === id)?.name;
    return name ? `External token "${name}"` : "External token";
  };
}

// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Notice, Page } from "../components/layout";
import { NativeButton } from "@/components/native";
import { acceptInvite, claimServer, previewInvite } from "./actions";
import { signOut } from "./auth";
import { message } from "./messages";
import { Narrow } from "./SignIn";

const say = (code: string) => (code === "not_found" ? "This invite link doesn't work. Check that you copied all of it, or ask for a new one." : message(code));

/**
 * The page an invite link opens, once the person is signed in. It names the Workspace and who
 * sent the invite, or says up front why the invite can't be used; if that read fails, Accept still works.
 */
export function AcceptInvite({ workspaceId, token, onJoined }: { workspaceId: string; token: string; onJoined: () => void }) {
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const preview = useQuery({ queryKey: ["invite-preview", workspaceId, token], queryFn: () => previewInvite(workspaceId, token), retry: false }).data;
  const named = preview && "workspace" in preview ? preview : undefined;
  const refused = preview && "error" in preview ? say(preview.error) : undefined;
  const accept = () => {
    setPending(true);
    return acceptInvite(workspaceId, token)
      .then((code) => (code ? setError(say(code)) : onJoined()))
      .finally(() => setPending(false));
  };

  return (
    <Narrow>
      <Page
        title={named ? `${named.invitedBy} invited you to ${named.workspace}` : "Join a Workspace"}
        description={named ? "Accept to join this Workspace on Direx." : "You've been invited to a Workspace on Direx."}
      >
        {refused ? (
          <Notice tone="error">{refused}</Notice>
        ) : (
          <NativeButton pending={pending} onClick={accept}>
            Accept invite
          </NativeButton>
        )}
        {error && <Notice tone="error">{error}</Notice>}
      </Page>
    </Narrow>
  );
}

/**
 * The page the bootstrap link from `bun run server-admin --invite` opens, once the person is signed in (ADR 0024).
 * With no `token`, the server uses the one the link's page held in a cookie.
 */
export function ClaimServer({ token, email, onClaimed }: { token?: string; email: string; onClaimed: () => void }) {
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const claim = () => {
    setPending(true);
    return claimServer(token)
      .then((code) => (code ? setError(message(code)) : onClaimed()))
      .finally(() => setPending(false));
  };

  return (
    <Narrow>
      <Page title="Claim this server" description="You'll be its first Server admin: you choose who may sign up, and you can create Organizations.">
        {/* The first account's email isn't confirmed by mail (ADR 0024 rule 002), so a typo shows here. */}
        <p>
          You're signed in as <strong>{email}</strong>. Check it's yours before you go on: password resets and sign-in links go there.
        </p>
        <NativeButton pending={pending} onClick={claim}>
          Become Server admin
        </NativeButton>
        <NativeButton type="button" variant="ghost" size="sm" onClick={() => void signOut(location.pathname).then((e) => e && setError(e))}>
          Use a different email
        </NativeButton>
        {error && <Notice tone="error">{error}</Notice>}
      </Page>
    </Narrow>
  );
}

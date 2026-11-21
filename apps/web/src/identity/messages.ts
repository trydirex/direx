// SPDX-License-Identifier: AGPL-3.0-only
// What each API refusal code means to the person who hit it. Codes worded the same on every
// screen come from api/messages.ts.
import { messageForCode } from "../api/messages";

export const MESSAGES: Record<string, string> = {
  forbidden: "Your role in this Workspace can't do that.",
  admin_cannot_manage_owner: "Only an Owner can invite, promote, change or remove an Owner.",
  last_owner: "A Workspace needs at least one Owner. Make someone else an Owner first.",
  already_member: "They're already a member of this Workspace.",
  wrong_email: "This invite was sent to a different email address. Sign in with that address to accept it.",
  unverified_email: "Confirm your email address first, then open the invite again.",
  expired: "This invite has expired. Ask for a new one.",
  revoked: "This invite was withdrawn. Ask for a new one if you still need access.",
  accepted: "This invite has already been used.",
  mail_failing: "This server can't send mail right now, so the sign-up rule can't change. Fix the mail settings first.",
  bad_domain: "One of those isn't a domain. Use the part after the @, like example.com.",
  no_account: "No account has that email. Ask them to sign in to this server once, then add them.",
  last_server_admin: "A server needs at least one Server admin. Add someone else first.",
  cannot_create_organization: "Your account can't create an Organization on this server. Ask whoever runs it, or ask to be invited to a Workspace.",
  link_unusable: "This link has expired or has already been used. Ask whoever runs this server for a new one.",
  link_needed: "Open the setup link again in this browser to claim this server.",
  bad_link: "This link isn't valid. Check that you copied all of it, or ask for a new one.",
  password_length: "Use at least 12 characters.",
  too_large: "That file is over 10 MB. A plugin is one bundled file of at most 10 MB.",
  stage_gone: "That upload has expired. Upload the file again.",
  changed: "The file changed after you reviewed it. Upload it again and review it once more.",
  already_installed: "Someone installed this plugin just now. Reload the page to see it.",
  not_installed: "That plugin isn't installed anymore. Reload the page.",
  no_store: "This server has nowhere to keep plugin files, so it can't take an upload.",
  password_already_set: "This account already has a password. To change it, sign out and reset it from the sign-in page.",
};

export const message = (code: string) => messageForCode(code, MESSAGES);

// SPDX-License-Identifier: AGPL-3.0-only
// One AI a self-hoster can pick. A CLI is a transport for a single model call: the loop, the
// tools and the caps stay in Direx.
import type { CliProvider } from "../../domain/routes-check";
import type { Dispatch } from "../sdk";

export type ModelAdapter = {
  id: CliProvider;
  label: string;
  signIn: "device" | "setup_token";
  /** The short list a person may pick from. The first is the default. */
  models: readonly string[];
  installed(): Promise<boolean>;
  call: Dispatch;
};

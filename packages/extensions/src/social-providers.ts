// SPDX-License-Identifier: AGPL-3.0-only
// Each social network's OAuth details, as data. The client pair is looked up per Workspace.
import { FACEBOOK_PROVIDER } from "./social/facebook/provider";
import { INSTAGRAM_PROVIDER } from "./social/instagram/provider";
import { LINKEDIN_PAGE_PROVIDER, LINKEDIN_PROVIDER } from "./social/linkedin/provider";
import { THREADS_PROVIDER } from "./social/threads/provider";
import { TIKTOK_PROVIDER } from "./social/tiktok/provider";
import { X_PROVIDER } from "./social/x/provider";
import { YOUTUBE_PROVIDER } from "./social/youtube/provider";

export const socialProviders = () => [LINKEDIN_PROVIDER, LINKEDIN_PAGE_PROVIDER, X_PROVIDER, FACEBOOK_PROVIDER, INSTAGRAM_PROVIDER, THREADS_PROVIDER, YOUTUBE_PROVIDER, TIKTOK_PROVIDER] as const;

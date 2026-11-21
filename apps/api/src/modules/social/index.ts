// SPDX-License-Identifier: AGPL-3.0-only
// Connected social network accounts. Networks are plugins and descriptors; this module names none.
export { createSocial, type Social, type SocialDeps } from "./application/social";
export { socialRoutes } from "./routes";
export { socialCapacity } from "./application/capacity";
export { accountHealthCheck, pauseAccount, pauseInWorkspace, pauseOnAccountLimit, stepUpCredential, unpauseAccount } from "./application/account-health";
export { previewOf } from "./domain/link-preview";
export { createPosts, MANUAL_POST, postAppearance, postLinkImage, type ReadImage, type ReadPreview, postLimitCheck, socialKinds, type PostResult, type Posts, type PostTarget } from "./application/posts";

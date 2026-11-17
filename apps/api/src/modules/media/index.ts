// SPDX-License-Identifier: AGPL-3.0-only
// The media module's only public entry point: a Workspace's uploaded files and the clips cut from them.
export { cleanFileName, createMedia, IMAGE_MAX_BYTES, type Media, type MediaDeps, type MediaKind, type MediaView, type Upload, type UploadRefusal } from "./application/media";
export { MEDIA_MAX_BYTES } from "./adapters/repo";
export { diskStore } from "./adapters/disk";
export { parseS3Url, s3Store, type S3Config } from "./adapters/s3";
export { mediaKey, type Store, type Stored } from "./adapters/store";
export { mediaRoutes } from "./routes";

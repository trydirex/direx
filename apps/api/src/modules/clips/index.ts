// SPDX-License-Identifier: AGPL-3.0-only
// The clips module's only public entry point: an uploaded video in, captioned vertical clips out.
export { captionLines, captionsAss, escapeAss, type CaptionLine } from "./domain/captions";
export { timedLines, wordsFromWhisper, wordsIn, type Word } from "./domain/transcript";
export { cut, ensureModel, findTools, ModelUnavailable, probe, ToolFailed, toWav, transcribe, WHISPER_MODEL, WHISPER_THREADS, type Probe, type Tools } from "./adapters/tools";
export { checkMoments, MAX_CLIP_MS, MAX_CLIPS, MIN_CLIP_MS, parseCitation, snap, type Dropped, type Moment } from "./domain/moments";
export { clipDefinitions, clipPicker, CLIP_PICK_PURPOSE, MOMENTS_OUTPUT_KEY } from "./definitions/clip-picker";
export { createClips, CUT_QUEUE, FAILURES, MAX_SOURCE_MS, pickText, TRANSCRIBE_QUEUE, type AgentRunState, type Clips, type ClipsDeps, type Engine, type Measure, type PickInput, type RunView, type StartPick } from "./application/runs";
export { clipAskStarts } from "./application/ask-starts";
export { clipRoutes } from "./routes";

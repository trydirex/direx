// SPDX-License-Identifier: AGPL-3.0-only
// Agent lessons: how one Agent should work in one Workspace, in a person's words, used for nothing
// until someone who may grant rules accepts it. items, agents and standing-rules don't import this
// module; the composition root hands its kinds and its run hooks to them.
export { lessons as createLessons, LESSON_FACT_KIND, LESSONS_CHANGED, type Lessons, type LessonsDeps } from "./application/lessons";
export { lessonCheckOpen } from "./application/check";
export { lessonCheck } from "./definitions/lesson-check";
export { LESSON_PROPOSAL_KIND, LESSON_BUDGET_CHARS, MAX_LESSON_CHARS } from "./domain/lessons";
export { lessonRoutes } from "./routes";

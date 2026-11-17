// SPDX-License-Identifier: MIT
// One catalogue entry: a query's name, its version, what Direx code sends and what the plugin
// answers. The host parses both through it, so an answer reaches core checked (ADR 0028 rule 001).
import { z, type ZodObject, type ZodType } from "zod";

/** Where an agent query's input must come from. The host checks it before calling the plugin. */
export const INPUT_SCOPES = ["person_address_in_run"] as const;
export type InputScope = (typeof INPUT_SCOPES)[number];

export type QueryEntry = {
  name: string;
  version: number;
  /** What Direx code sends. */
  input: ZodType;
  /** What the plugin answers, parsed strictly before anything reads it. */
  output: ZodType;
  /** Set for an agent query: all the model is told, the input it may give and what it sees (ADR 0014). */
  agent?: { description: string; input: ZodType; scope: InputScope; view: (wire: never) => unknown };
};

/** A trigger core reads by name: the event data its plugin hands over, parsed before anything reads it. */
export type TriggerEntry = { name: string; version: number; data: ZodType };

/**
 * An effect core prepares by name: the input Direx passes to prepare and, where Direx reads the approved
 * spec, the fields it reads. The plugin's spec must have those and may carry more, which stay its own.
 */
export type EffectEntry = { name: string; version: number; input: ZodType; spec?: ZodObject };

/** The input of a query that takes none: Direx sends null. */
export const noInput = z.strictObject({}).nullish();

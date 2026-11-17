// SPDX-License-Identifier: AGPL-3.0-only
// A CLI has no tools of its own, so a tool request and a typed answer both come back as text in
// one fixed shape that both CLIs can enforce. Direx then checks it against the real schemas.
import { z, type ZodType } from "zod";
import type { DispatchRequest, DispatchResult, DispatchUsage, ToolCall } from "../sdk";

export const ENVELOPE_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: ["string", "null"], description: "The answer, or null when calling a tool" },
    tool: { type: ["string", "null"], description: "The tool to call, or null when answering" },
    tool_input: { type: ["string", "null"], description: "The tool's input as a JSON string, or null" },
  },
  required: ["answer", "tool", "tool_input"],
  additionalProperties: false,
} as const;

/** An agent's only way to finish is a tool, and a model may ignore being told so, so the shape requires one. */
export function envelopeSchema(r: Pick<DispatchRequest, "tools" | "output">) {
  if (r.output || r.tools.length === 0) return ENVELOPE_SCHEMA;
  const { properties } = ENVELOPE_SCHEMA;
  return {
    ...ENVELOPE_SCHEMA,
    properties: {
      ...properties,
      tool: { type: "string", enum: r.tools.map((t) => t.name), description: "The tool to call" },
      tool_input: { type: "string", description: "The tool's input as a JSON string" },
    },
  };
}

export const SIGNED_OUT_REASON = "signed_out";
export const NOT_INSTALLED_REASON = "not_installed";

const envelope = z.object({ answer: z.string().nullable(), tool: z.string().nullable(), tool_input: z.string().nullable() });

const jsonSchemaOf = (schema: ZodType) => JSON.stringify(z.toJSONSchema(schema));

/** What the model is told beyond the caller's own parts, since the CLI can't carry the schemas. */
export function instructions(r: DispatchRequest): string {
  const lines: string[] = [];
  if (r.output) lines.push(`Put your answer in "answer" as a JSON string matching this JSON Schema: ${jsonSchemaOf(r.output)}`);
  else if (r.tools.length === 0) lines.push(`Put your answer in "answer" as plain text.`);
  if (r.tools.length > 0) {
    // An API model gets real tools. Here, an offer of plain text would be taken up, and an agent's
    // only way to finish is a tool, so without output there is no other way to answer.
    const verb = r.output ? "To call a tool instead, set" : "You must call a tool. Don't answer in text. Set";
    lines.push(`${verb} "answer" to null, "tool" to its name and "tool_input" to a JSON string matching its schema. Tools:`);
    for (const t of r.tools) lines.push(`- ${t.name}: ${t.description} Schema: ${jsonSchemaOf(t.inputSchema)}`);
  }
  return lines.join("\n");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The call, or why it can't be one: which fields failed and how, never their values. */
function toolCallOf(r: DispatchRequest, name: string, rawInput: string | null): ToolCall | string {
  const tool = r.tools.find((t) => t.name === name);
  if (!tool) return `tool: no tool ${JSON.stringify(name.slice(0, 40))}`;
  let raw = parseJson(rawInput ?? "null");
  // The same habit one level up: the whole input sent as a JSON string inside the string.
  if (typeof raw === "string" && raw.trimStart().startsWith("{")) raw = parseJson(raw) ?? raw;
  let parsed = tool.inputSchema.safeParse(raw);
  // A model writing JSON inside JSON sometimes sends a nested object as a string. Read such a field
  // once as the object it holds; anything that still doesn't fit is refused as before.
  if (!parsed.success && raw && typeof raw === "object" && !Array.isArray(raw)) {
    const unwrapped = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, typeof v === "string" && v.trimStart().startsWith("{") ? (parseJson(v) ?? v) : v]));
    parsed = tool.inputSchema.safeParse(unwrapped);
  }
  if (parsed.success) return { toolName: name, input: parsed.data };
  return `tool: ${name} input: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(root)"} ${i.code}`).join("; ")}`;
}

/** Output that doesn't fit counts as a refusal, the same as an API model's unusable answer. */
export function resultOf(r: DispatchRequest, raw: unknown, usage: DispatchUsage, resolvedModel: string): DispatchResult {
  const refusal: DispatchResult = { ok: false, family: "model_refusal", usage };
  const e = envelope.safeParse(raw);
  if (!e.success) return { ...refusal, reason: `envelope: ${e.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(root)"} ${i.code}`).join("; ")}` };
  const common = { usage, resolvedModel };
  if (e.data.tool !== null) {
    const call = toolCallOf(r, e.data.tool, e.data.tool_input);
    return typeof call === "string" ? { ...refusal, reason: call } : { ok: true, text: "", output: undefined, toolCalls: [call], ...common };
  }
  if (e.data.answer === null) return { ...refusal, reason: "envelope: no answer" };
  if (!r.output) return { ok: true, text: e.data.answer, output: undefined, toolCalls: [], ...common };
  const output = r.output.safeParse(parseJson(e.data.answer));
  if (output.success) return { ok: true, text: e.data.answer, output: output.data, toolCalls: [], ...common };
  return { ...refusal, reason: `schema: ${output.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(root)"} ${i.code}`).join("; ")}` };
}

const HOUR_MS = 3_600_000;
const LONGEST_RESET_MS = 8 * 24 * HOUR_MS;
const CLOCK_RESET = /\bresets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?(?:\s*\(([^)]+)\))?/i;
const EPOCH_RESET = /"?resets?_at"?\s*[:=]\s*(\d{9,13})/i;
const SECONDS_RESET = /"?resets?_in_seconds"?\s*[:=]\s*(\d+)/i;
const SIGNED_OUT = /not logged in|log ?in again|please run .*login|invalid (api key|authentication)|authentication[_ ]?(failed|error)|unauthorized|\b401\b/i;
const LIMITED = /usage limit|rate[_ -]?limit|limit reached|hit your limit|quota|too many requests|\b429\b/i;

/** How far the zone's clock is ahead of UTC at this moment; the server's own for no zone or an unknown one. */
function zoneOffsetMs(at: Date, zone: string | undefined): number {
  const own = -at.getTimezoneOffset() * 60_000;
  if (!zone) return own;
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(at);
    const part = (type: string) => Number(parts.find((p) => p.type === type)!.value);
    return Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute")) - Math.floor(at.getTime() / 60_000) * 60_000;
  } catch {
    return own;
  }
}

// ponytail: an hour out across a daylight-saving change, which only moves a retry.
function nextClock(now: Date, hour: number, minute: number, zone: string | undefined): Date {
  const offset = zoneOffsetMs(now, zone);
  const local = new Date(now.getTime() + offset);
  const at = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour, minute) - offset;
  return new Date(at > now.getTime() ? at : at + 24 * HOUR_MS);
}

/** When the CLI says the limit lifts, if it says and the answer is believable. */
export function resetOf(output: string, now: Date): Date | null {
  let at: Date | null = null;
  const clock = CLOCK_RESET.exec(output);
  const epoch = EPOCH_RESET.exec(output);
  const seconds = SECONDS_RESET.exec(output);
  if (epoch) at = new Date(epoch[1]!.length > 10 ? Number(epoch[1]) : Number(epoch[1]) * 1000);
  else if (seconds) at = new Date(now.getTime() + Number(seconds[1]) * 1000);
  else if (clock && Number(clock[1]) >= 1 && Number(clock[1]) <= 12) {
    const hour = (Number(clock[1]) % 12) + (clock[3]!.toLowerCase() === "p" ? 12 : 0);
    at = nextClock(now, hour, Number(clock[2] ?? 0), clock[4]);
  }
  return at && at.getTime() > now.getTime() && at.getTime() - now.getTime() <= LONGEST_RESET_MS ? at : null;
}

/** A signed-out CLI is the same to a run as a revoked key, and a limit the same as a 429. */
export function failureOf(output: string, now = new Date()): DispatchResult {
  if (SIGNED_OUT.test(output)) return { ok: false, family: "configuration", definite: true, reason: SIGNED_OUT_REASON };
  if (LIMITED.test(output)) return { ok: false, family: "provider_quota", definite: true, retryNotBefore: resetOf(output, now) ?? new Date(now.getTime() + HOUR_MS) };
  return { ok: false, family: "transient_upstream", definite: true };
}

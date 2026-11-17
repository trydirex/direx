// SPDX-License-Identifier: AGPL-3.0-only
// Turns an uploaded bundle into what a Server admin confirms (ADR 0026 rules 003 to 005): its hash,
// the manifest it reports when run with no network, why it can't be installed if it can't, and what
// a Workspace owner would agree to. Then stores it under its hash, never to be changed.
import type { Manifest } from "@direx/plugin-sdk";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { installRefusals, permissionHash, type InstallChecks } from "./install";
import { probePlugin, type ProbeResult } from "./probe";

export const MAX_BUNDLE_BYTES = 10 * 1024 * 1024;

export type InstallPlan = { file: string; entrySha256: string; manifest: Manifest; permissionHash: string };

export type PrepareDeps = InstallChecks & {
  hostVersion: string;
  /** Replaced in tests that have no sandbox. */
  probe?: (file: string, opts: { hostVersion: string }) => Promise<ProbeResult>;
};

export async function prepareInstall(file: string, deps: PrepareDeps): Promise<{ ok: true; plan: InstallPlan } | { ok: false; reasons: string[] }> {
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    return { ok: false, reasons: [`there is no file at ${file}`] };
  }
  if (size > MAX_BUNDLE_BYTES) return { ok: false, reasons: [`it is ${size} bytes; a plugin bundle may be at most ${MAX_BUNDLE_BYTES}`] };
  const entrySha256 = createHash("sha256").update(await readFile(file)).digest("hex");
  const probed = await (deps.probe ?? probePlugin)(file, { hostVersion: deps.hostVersion });
  if (!probed.ok) return { ok: false, reasons: [`it couldn't be read: ${probed.reason}`] };
  const reasons = installRefusals(probed.manifest, deps);
  if (reasons.length) return { ok: false, reasons };
  return { ok: true, plan: { file, entrySha256, manifest: probed.manifest, permissionHash: permissionHash(probed.manifest) } };
}

/** Where a stored bundle lives: one file per hash, the only thing ever bound into a sandbox. */
export const storedBundle = (storeDir: string, sha256: string) => join(storeDir, `${sha256}.js`);

/** Copies the bundle into the store under its hash, read-only. The same bytes are stored once. */
export async function storeBundle(plan: InstallPlan, storeDir: string): Promise<string> {
  await mkdir(storeDir, { recursive: true, mode: 0o700 });
  const target = storedBundle(storeDir, plan.entrySha256);
  const bytes = await readFile(plan.file);
  // Checked again on the bytes being written, so a file swapped after the probe can't be stored.
  if (createHash("sha256").update(bytes).digest("hex") !== plan.entrySha256) throw new Error("the file changed after it was read");
  const staged = `${target}.${crypto.randomUUID()}.part`;
  try {
    await writeFile(staged, bytes, { mode: 0o400 });
    await rename(staged, target);
  } finally {
    await rm(staged, { force: true });
  }
  await chmod(target, 0o444);
  return target;
}

/** What changes for Workspace owners when this upgrade replaces the installed manifest. */
export function upgradeDiff(before: Manifest, after: Manifest): { added: string[]; removed: string[] } {
  const items = (m: Manifest) => new Set([
    ...m.capabilities.map((c) => `${c.kind} ${c.name}`),
    ...m.connections.map((c) => `connection ${c.key} (${c.auth})`),
    ...m.egress.hosts.map((h) => `reaches ${h}`),
  ]);
  const a = items(before);
  const b = items(after);
  return { added: [...b].filter((x) => !a.has(x)).sort(), removed: [...a].filter((x) => !b.has(x)).sort() };
}

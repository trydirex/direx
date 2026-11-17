// SPDX-License-Identifier: AGPL-3.0-only
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

// Packs the plugin SDK the way npm will publish it and proves the tarball works outside the
// monorepo: it holds only MIT files, and a clean Node project and a clean Bun project (the hello
// example, bundled) both start a worker from it that answers initialize with its manifest.
// `--out <dir>` keeps the tarball, which is the file the founder publishes. Exit 0 pass, 1 fail.

const repo = join(import.meta.dir, "..");
const sdk = join(repo, "packages/plugin-sdk");
const tsc = join(repo, "node_modules/.bin/tsc");
const MIT = "// SPDX-License-Identifier: MIT";
const ALLOWED = new Set(["package.json", "LICENSE", "README.md"]);
const INITIALIZE = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"apiVersion":1,"hostVersion":"0.2.0","workspaceId":"w1"}}\n';
const failures: string[] = [];

function run(cmd: string[], cwd: string): string {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed in ${cwd}:\n${r.stdout.toString()}${r.stderr.toString()}`);
  return r.stdout.toString();
}

function* files(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) yield* files(join(dir, e.name));
    else yield join(dir, e.name);
  }
}

/** Starts a worker, sends initialize and returns the manifest id it answers with. */
async function initialize(cmd: string[], cwd: string): Promise<string> {
  const p = Bun.spawn(cmd, { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  p.stdin.write(INITIALIZE);
  await p.stdin.flush();
  const timer = setTimeout(() => p.kill(), 20_000);
  const reader = p.stdout.getReader();
  let out = "";
  while (!out.includes("\n")) {
    const { done, value } = await reader.read();
    if (done) break;
    out += new TextDecoder().decode(value);
  }
  p.stdin.end();
  await p.exited;
  clearTimeout(timer);
  const reply = JSON.parse(out.split("\n")[0] || "null") as { id?: number; result?: { manifest?: { id?: unknown } } } | null;
  const id = reply?.id === 1 ? reply.result?.manifest?.id : undefined;
  if (typeof id !== "string") throw new Error(`${cmd.join(" ")} answered ${JSON.stringify(out)}; stderr: ${await new Response(p.stderr).text()}`);
  return id;
}

const out = process.argv.includes("--out") ? resolve(process.argv[process.argv.indexOf("--out") + 1]!) : null;
const tmp = mkdtempSync(join(tmpdir(), "direx-sdk-pack-"));
try {
  run([process.execPath, "run", "build"], sdk);

  // The published package.json drops the "bun" condition, which points at src/ for the monorepo
  // and would send a Bun install to files the tarball does not hold, and the build script.
  const stage = join(tmp, "stage");
  mkdirSync(stage);
  cpSync(join(sdk, "dist"), join(stage, "dist"), { recursive: true });
  for (const f of ["LICENSE", "README.md"]) copyFileSync(join(sdk, f), join(stage, f));
  const pkg = JSON.parse(readFileSync(join(sdk, "package.json"), "utf8"));
  delete pkg.exports["."].bun;
  delete pkg.scripts;
  writeFileSync(join(stage, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  const [packed] = JSON.parse(run(["npm", "pack", "--json", "--pack-destination", tmp], stage)) as { filename: string }[];
  const tarball = join(tmp, packed!.filename);

  const unpacked = join(tmp, "unpacked");
  mkdirSync(unpacked);
  run(["tar", "-xzf", tarball, "-C", unpacked], tmp);
  const listed = [...files(join(unpacked, "package"))].map((f) => relative(join(unpacked, "package"), f).split("\\").join("/")).sort();
  console.log(`${packed!.filename}:\n${listed.map((f) => `  ${f}`).join("\n")}`);
  for (const f of listed) {
    if (!ALLOWED.has(f) && !f.startsWith("dist/")) failures.push(`unexpected file ${f}`);
    if (/\.(js|d\.ts)$/.test(f) && readFileSync(join(unpacked, "package", f), "utf8").split("\n", 1)[0] !== MIT) failures.push(`not MIT ${f}`);
  }
  if (!readFileSync(join(unpacked, "package/LICENSE"), "utf8").startsWith("MIT License")) failures.push("LICENSE is not the MIT license");

  // Node: plain ESM, typechecked as a consumer with NodeNext resolution, then started.
  const node = join(tmp, "node");
  mkdirSync(node);
  writeFileSync(join(node, "package.json"), '{ "name": "sdk-pack-node", "private": true, "type": "module" }\n');
  run(["npm", "install", "--no-audit", "--no-fund", tarball], node);
  const worker = `import { definePlugin, runWorker } from "@trydirex/plugin-sdk";
const plugin = definePlugin({
  manifest: {
    id: "com.example.node", apiVersion: 1, version: "0.1.0", minHostVersion: "0.2.0", trust: "third_party",
    connections: [{ key: "k", auth: "api_key" }], egress: { hosts: ["api.example.com"] },
    capabilities: [{ kind: "query", name: "search.properties", connection: "k" }],
  },
  queries: { "search.properties": async () => [] },
});
const id: string = plugin.manifest.id;
void id;
await runWorker(plugin);
`;
  writeFileSync(join(node, "worker.mts"), worker);
  run([tsc, "--noEmit", "--strict", "--types", "bun", "--typeRoots", join(repo, "node_modules/@types"), "--module", "nodenext", "--target", "es2022", "worker.mts"], node);
  writeFileSync(join(node, "worker.mjs"), worker.replace("const id: string", "const id"));
  console.log(`node: initialize answered ${await initialize(["node", "worker.mjs"], node)}`);

  // Bun: the hello example as an author copies it, bundled into one plugin.js and started.
  const bun = join(tmp, "bun");
  mkdirSync(bun);
  copyFileSync(join(sdk, "examples/hello/plugin.ts"), join(bun, "plugin.ts"));
  const hello = JSON.parse(readFileSync(join(sdk, "examples/hello/package.json"), "utf8"));
  hello.dependencies["@trydirex/plugin-sdk"] = `file:${tarball}`;
  writeFileSync(join(bun, "package.json"), `${JSON.stringify(hello, null, 2)}\n`);
  run([process.execPath, "install"], bun);
  run([process.execPath, "run", "build"], bun);
  console.log(`bun: initialize answered ${await initialize([process.execPath, "dist/plugin.js"], bun)}`);

  if (out && !failures.length) {
    mkdirSync(out, { recursive: true });
    copyFileSync(tarball, join(out, packed!.filename));
    console.log(`kept ${join(out, packed!.filename)}`);
  }
} catch (e) {
  failures.push(e instanceof Error ? e.message : String(e));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

for (const f of failures) console.log(`sdk-pack: ${f}`);
console.log(failures.length ? "sdk-pack: FAIL" : "sdk-pack: ok");
process.exit(failures.length ? 1 : 0);

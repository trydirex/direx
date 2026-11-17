// SPDX-License-Identifier: AGPL-3.0-only
// Files on the host, under <data dir>/media/<workspace id>/<media id>.
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { checkKey, type Store } from "./store";

export function diskStore(root: string): Store {
  const path = (key: string) => join(root, checkKey(key));
  return {
    async put(key, body) {
      const to = path(key);
      // Written under a temporary name and renamed once whole, so a cut upload never reads as a file.
      const part = `${to}.part`;
      await mkdir(dirname(to), { recursive: true });
      try {
        await Bun.write(part, new Response(body));
        await rename(part, to);
      } catch (e) {
        await rm(part, { force: true });
        throw e;
      }
    },
    async read(key) {
      return { kind: "file", file: Bun.file(path(key)) };
    },
    remove(key) {
      // Checked before the promise, so a bad key throws where it is passed.
      const p = path(key);
      return rm(p, { force: true });
    },
  };
}

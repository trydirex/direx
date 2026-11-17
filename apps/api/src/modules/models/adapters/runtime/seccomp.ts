// SPDX-License-Identifier: AGPL-3.0-only
// A seccomp filter of the sandbox's own, for code Direx didn't write (ADR 0026 rule 006): no new
// namespaces, mounts, kernel keyrings, BPF, tracing or module loading. Built once with libseccomp,
// which ships with bubblewrap on Debian, and written out as BPF for `bwrap --seccomp`.
import { dlopen, FFIType, ptr } from "bun:ffi";
import { closeSync, mkdtempSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ALLOW = 0x7fff0000;
const errno = (n: number) => 0x00050000 | n;
const EPERM = 1;
const ENOSYS = 38;

const DENIED = [
  "unshare", "setns", "mount", "umount2", "pivot_root", "move_mount", "open_tree", "fsopen", "fsmount", "fsconfig",
  "bpf", "keyctl", "add_key", "request_key", "ptrace", "process_vm_readv", "process_vm_writev", "perf_event_open",
  "userfaultfd", "open_by_handle_at", "init_module", "finit_module", "delete_module", "kexec_load", "kexec_file_load",
];

let built: Promise<string | null> | undefined;

function build(): string | null {
  let lib;
  try {
    lib = dlopen("libseccomp.so.2", {
      seccomp_init: { args: [FFIType.u32], returns: FFIType.ptr },
      seccomp_syscall_resolve_name: { args: [FFIType.ptr], returns: FFIType.i32 },
      seccomp_rule_add: { args: [FFIType.ptr, FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.i32 },
      seccomp_export_bpf: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      seccomp_release: { args: [FFIType.ptr], returns: FFIType.void },
    });
  } catch {
    return null;
  }
  const s = lib.symbols;
  const ctx = s.seccomp_init(ALLOW);
  if (!ctx) return null;
  const nr = (name: string) => s.seccomp_syscall_resolve_name(ptr(Buffer.from(`${name}\0`)));
  try {
    for (const name of DENIED) {
      const n = nr(name);
      if (n >= 0 && s.seccomp_rule_add(ctx, errno(EPERM), n, 0) !== 0) return null;
    }
    // clone3 can't be filtered on its flags, so it reports "not there" and libc falls back to clone.
    const clone3 = nr("clone3");
    if (clone3 >= 0 && s.seccomp_rule_add(ctx, errno(ENOSYS), clone3, 0) !== 0) return null;
    const path = join(mkdtempSync(join(tmpdir(), "direx-seccomp-")), "filter.bpf");
    const fd = openSync(path, "w", 0o400);
    try {
      return s.seccomp_export_bpf(ctx, fd) === 0 ? path : null;
    } finally {
      closeSync(fd);
    }
  } finally {
    s.seccomp_release(ctx);
  }
}

/** The filter file, built on first use; null where libseccomp isn't there, so nothing confined can start. */
export function seccompFilter(): Promise<string | null> {
  built ??= Promise.resolve().then(build);
  return built;
}

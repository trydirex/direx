# Signing the Placement circle's member list

The Placement circle's member list lives in a private git repository. Only you, as the signer,
change it, with `scripts/placement-signer.ts` on your own machine. Every install reads the list from
its own checkout of that repository and trusts it only when it carries your signature and the signer
key is pinned in the Direx release it runs.

Keep two things apart:

- **The signer key file.** Keep it outside the Direx checkout and outside the list repository. The
  script refuses a key inside either one, and refuses a key file that other users can read. Never
  commit it, and keep a backup somewhere offline.
- **The list directory.** This is your checkout of the private repository. The script writes
  `members.json` there, plus `signer-state.json`, which holds open invites and the hashes of their
  join codes, never the codes themselves. `signer-state.json` stays on your machine and is never
  committed: the script adds it to the folder's `.gitignore`.

Every command takes `--dir <list directory>` and `--key-file <signer key>`. You can set
`DIREX_PLACEMENT_LIST` and `DIREX_PLACEMENT_SIGNER_KEY` once instead. Each command that changes the
list checks the new version exactly as an install would, and writes nothing if an install would
refuse it.

## 1. Make the key

```
bun scripts/placement-signer.ts init --key-file ~/direx-signer.pem --dir ~/placement-list
```

This makes a new key, saves it readable by you alone, and won't replace a file that already
exists. With `--dir` it also signs an empty first list. It prints your public key and the line to
paste into `PINNED_ROOT` in `apps/api/src/modules/placement/domain/root.ts`.

## 2. Pin the key

Paste that line into `root.ts` and ship it in a release. Until the key is pinned, every install
refuses every list, and the script reminds you of that each time it runs.

## 3. Invite a Mailbox

```
bun scripts/placement-signer.ts invite you@example.com --inviter signer \
  --criteria-named-person --criteria-business-website --criteria-domain-six-months \
  --founder-controlled
```

- `--inviter` names who invites: `signer` for you, or the address of a member who may still invite.
- The three `--criteria-` flags are your answers to the admission criteria: a named person known to
  the inviter or to you, a business website on the Mailbox's domain, and a domain at least 6 months
  old. All three must be yes, or the invite is refused.
- Until the stop rule has passed, only Mailboxes you control may join. `--founder-controlled`
  records your statement "I control this Mailbox" with the invite. Once you have written the dated
  stop-rule note, pass `--stop-rule-passed <path to the note>` instead for a Mailbox you don't
  control.

The script prints two join codes. They expire after 24 hours.

- Email **part 1** by hand from your own address to the invited Mailbox.
- Paste **part 2** into the joining install's join form.

## 4. Accept the join reply

The person who joins pastes both parts into their install's join form, with the Message-ID of
your part 1 email and your address. Their install replies to that email with both parts and its
member key. In Gmail, open the reply, choose "Download message" from its menu, and run:

```
bun scripts/placement-signer.ts accept ~/Downloads/reply.eml
```

The script adds the Mailbox only when:

- the reply carries a passing DKIM signature over its whole body from its own From domain,
- the member key in it signed both parts and the address,
- both parts match an open invite, and
- it arrived before the invite expired. The arrival time is the top `Received` header, which your
  own mail server wrote; the `Date` header is the sender's to set, so it isn't used.

Each invite works once. Download the reply as it arrived: an edited or forwarded copy fails the
DKIM check.

## 5. Remove a member

```
bun scripts/placement-signer.ts remove you@example.com --left
bun scripts/placement-signer.ts remove you@example.com --abuse
```

Use `--left` when a member stops placement or asks to leave. Use `--abuse` when a member misused
the circle. An abuse removal also takes away its inviter's right to invite, in the same version.
An abuse removal keeps the list's expiry unchanged, so on an expired list it is refused: run `sign`
first, then remove.

## 6. Renew the list

```
bun scripts/placement-signer.ts sign
```

A signed list is valid for 30 days. `sign` signs the current members again as the next version
with a fresh expiry. Run it before the list expires, or every install stops trusting it.

## 7. Publish

After each command, commit the list directory and push it to the private repository. On each
install, pull that repository and set `DIREX_PLACEMENT_LIST` to the checkout's path.

## If the signer key is lost or stolen

The list can't be changed without the key, and nobody can sign a new root for you, so recovery
goes through a release.

1. If the key may have been stolen, treat every list signed after the theft as untrusted.
2. Run `init` with a new key file and no `--dir`.
3. Replace the key in `PINNED_ROOT` with the new public key and ship a release.
4. Sign the current members with the new key: `sign --key-file <new key>`.
5. An install on the new release forgets the old version count and trusts the first list valid under
   the new key, even if the thief published a higher version with the old one.
6. Ask every install to update. An install on the old release keeps refusing lists signed by the
   new key, and that's intended.

Until the new release is out, nobody can change the list, so no new member can join, and the last
list stays valid until it expires.

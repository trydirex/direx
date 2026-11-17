// SPDX-License-Identifier: AGPL-3.0-only
// Placement mail is taken aside before reply and bounce handling, so none of it reaches a Person
// record, reply intake, suppression, a model, Campaign results or the hand-written mail that makes
// correspondents. An event this claims goes to no other consumer.
import { isPlacementMessage, isPlacementSend } from "../../ledger/index";
import { messageIds } from "../../outreach/index";
import { MAIL_SENT, type CatalogueEvent } from "../../plugins/index";
import type { PlacementTx } from "../adapters/repo";
import { parseJoin } from "../domain/join";
import { parseReport } from "../domain/report";
import { countReport } from "./reports";

/** Whether inbound mail is a Placement check, report or join reply this install expects, found by its sender, subject and send window. */
export type MatchInbound = (tx: PlacementTx, e: CatalogueEvent<"email.received">) => Promise<boolean>;

/** Whether this mail event, its data parsed by the plugin host, is placement mail, which no other consumer may see. */
export async function routePlacement(tx: PlacementTx, e: CatalogueEvent, matchInbound: MatchInbound = async () => false, now = new Date()): Promise<boolean> {
  if (e.trigger === MAIL_SENT) {
    const sent = e.data;
    if (sent.messageId && (await isPlacementMessage(tx, [sent.messageId]))) return true;
    // Seen before its Message-ID was stored, or with none stored: known by whom it went to and when.
    return isPlacementSend(tx, sent.recipients, new Date(sent.sentAt));
  }
  // A reply, an auto-reply or a delivery notice names the message it answers.
  const m = e.data;
  if (await isPlacementMessage(tx, messageIds(m.headers.inReplyTo, m.headers.references))) return true;
  // A join reply reaching the signer's own Mailbox: it answers a hand-sent email, not an Action.
  if (parseJoin(m.text)) return true;
  // A report, known by its body alone, is counted before anything else could see it.
  const report = parseReport(m.text);
  if (report) {
    await countReport(tx, e, report, now);
    return true;
  }
  return matchInbound(tx, e);
}

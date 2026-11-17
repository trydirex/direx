// SPDX-License-Identifier: AGPL-3.0-only
// The counter-move Item kind, registered with items so items never imports competitors. Approving one
// records that a person made the move; nothing is published, sent or written to a page.
import type { ItemKind } from "../../items/index";
import { MOVE_KIND } from "../domain/moves";

export function competitorKinds(): Record<string, ItemKind> {
  return {
    [MOVE_KIND]: {
      permission: "item.approve",
      async apply(_tx, _item, actor) {
        return "userId" in actor ? { ok: true } : { ok: false, reason: "person_required" };
      },
    },
  };
}

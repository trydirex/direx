// SPDX-License-Identifier: AGPL-3.0-only
// Every language's replies. The gate opens per language, once its set is reviewed and its result passes.
import { DE } from "./de";
import { EN } from "./en";
import { ES } from "./es";
import { FR } from "./fr";
import { JA } from "./ja";
import { KO } from "./ko";
import { PL } from "./pl";
import { PT } from "./pt";
import type { ReplySet } from "./score";
import { ZH } from "./zh";

export const OPTOUT_SETS: readonly ReplySet[] = [EN, FR, DE, ES, PT, ZH, JA, KO, PL];

// SPDX-License-Identifier: AGPL-3.0-only
// The people module's only public entry point: Person records, their keys and their
// groups. Another module locks a Person only through lockGroup.
export { emailsOfGroup, listPeople, personIdWithEmail, type PeopleTx, type PersonRow } from "./adapters/people-repo";
export { normaliseKey, type KeyKind } from "./application/keys";
export { sharedMailDomain } from "./domain/shared-mail";
export {
  acceptLink,
  addKey,
  createPerson,
  findOrCreateByEmail,
  groupOf,
  lockGroup,
  rejectLink,
  withGroupRetry,
  type AddKeyResult,
  type Group,
  type LinkResult,
} from "./application/people";

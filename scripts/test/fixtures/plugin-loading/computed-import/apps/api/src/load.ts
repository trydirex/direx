// SPDX-License-Identifier: AGPL-3.0-only
export const load = (name: string) => import(`./plugins/${name}`);

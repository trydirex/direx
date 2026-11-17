// SPDX-License-Identifier: MIT

// Address verification as two query capabilities, so any vendor's plugin can stand behind it.
// A verification plugin declares both on one connection. The host parses what comes back with
// these schemas, since a plugin's answer is not trusted.
import { z } from "zod";
import { noInput } from "./entry";

/** Checks one address. Input: `{ email }`. Output: `VerifyAddressOutput`. */
export const VERIFY_ADDRESS = "email.verify";
/** What the vendor account has left. Input: null. Output: `VerifyBalanceOutput`. Throws when the key is refused. */
export const VERIFY_BALANCE = "email.verify_balance";

/** Only `deliverable` means an address may be sent to. A failed call is `unknown`, never `deliverable`. */
export const VERIFICATION_RESULTS = ["deliverable", "invalid", "catch_all", "unknown", "other"] as const;
export type VerificationResult = (typeof VERIFICATION_RESULTS)[number];

export const verifyAddressInput = z.strictObject({ email: z.email() });
export type VerifyAddressInput = z.infer<typeof verifyAddressInput>;

export const verifyAddressOutput = z.strictObject({
  result: z.enum(VERIFICATION_RESULTS),
  /** The vendor's own word for the result, or null when no answer came back. */
  vendorStatus: z.string().max(100).nullable(),
  /** Credits this check used; 0 when the vendor doesn't charge for it. */
  credits: z.number().int().min(0),
  costMicros: z.number().int().min(0),
});
export type VerifyAddressOutput = z.infer<typeof verifyAddressOutput>;

export const verifyBalanceOutput = z.strictObject({ remainingCredits: z.number().int().min(0) });
export type VerifyBalanceOutput = z.infer<typeof verifyBalanceOutput>;

export const verifyAddress = { name: VERIFY_ADDRESS, version: 1, input: verifyAddressInput, output: verifyAddressOutput } as const;
export const verifyBalance = { name: VERIFY_BALANCE, version: 1, input: noInput, output: verifyBalanceOutput } as const;

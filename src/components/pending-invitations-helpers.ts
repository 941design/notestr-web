/**
 * Pure helper functions for the PendingInvitations component.
 *
 * Extracted into a separate .ts file (no JSX) so these can be unit-tested
 * in the vitest node environment without a JSX transform.
 *
 * All functions are exported for testing; the component itself is the only
 * production consumer.
 */

import type { FailedWelcomeRecord } from "@/marmot/failed-welcomes";

/** Returns a short display form of the inviter's hex pubkey (first 8 chars). */
export function inviterShort(pubkey: string | null): string {
  if (!pubkey) return "unknown";
  return pubkey.slice(0, 8);
}

/** Maps a failure reason code to a human-readable label. */
export function failureReasonLabel(reason: string): string {
  switch (reason) {
    case "no_matching_kp":
      return "No matching key package";
    case "ciphersuite_mismatch":
      return "Ciphersuite mismatch";
    case "decrypt_failed":
      return "Decryption failed";
    default:
      return "Unknown failure";
  }
}

/**
 * Returns the concrete recovery instruction for a given failure reason and record.
 *
 * The `clientId` is only used for the `no_matching_kp` instruction.
 */
export function recoveryInstruction(
  record: Pick<FailedWelcomeRecord, "failureReason" | "innerCreatedAt">,
  clientId: string,
): string {
  switch (record.failureReason) {
    case "no_matching_kp": {
      const dateStr =
        record.innerCreatedAt > 0
          ? new Date(record.innerCreatedAt * 1000).toLocaleDateString(undefined, {
              year: "numeric",
              month: "short",
              day: "numeric",
            })
          : "the time of invitation";
      return (
        `Either open the browser you used around ${dateStr}, ` +
        `or ask the inviter to re-invite your current device (slot: ${clientId}).`
      );
    }
    case "ciphersuite_mismatch":
      return "Ask the inviter to use a compatible ciphersuite, or update your browser.";
    case "decrypt_failed":
      return "The invitation couldn't be decrypted. Try refreshing the page; if it persists, ask the inviter to re-send.";
    default:
      return "Contact the inviter for assistance.";
  }
}

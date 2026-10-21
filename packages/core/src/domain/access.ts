/**
 * Pure Telegram access decisions. Services call these with fresh state inside jobs.
 */

export type GrantState = "pending" | "invited" | "member" | "left" | "revoking" | "revoked" | "failed";
export type MemberStatus = "creator" | "administrator" | "member" | "restricted" | "left" | "kicked";

export type ReconcileAction = "issue_invite" | "revoke" | "none";

/**
 * What reconcile should enqueue given desired access and the grant's current state.
 * A user who left voluntarily is not re-invited automatically (they can ask via /status or the website).
 */
export function reconcileAction(desired: boolean, state: GrantState | null): ReconcileAction {
  if (desired) {
    if (state === null) return "issue_invite";
    return state === "invited" || state === "member" || state === "left" ? "none" : "issue_invite";
  }
  if (state === null) return "none";
  return state === "revoked" || state === "left" ? "none" : "revoke";
}

export type RevokeDecision =
  | { action: "skip_admin" }
  | { action: "already_gone" }
  | { action: "lift_stale_ban" }
  | { action: "remove" };

/** Decide how to remove a member given their current chat status. Owners and admins are never removed. */
export function revokeDecision(status: MemberStatus, flockBannedPreviously: boolean): RevokeDecision {
  if (status === "creator" || status === "administrator") return { action: "skip_admin" };
  if (status === "left") return { action: "already_gone" };
  if (status === "kicked") return flockBannedPreviously ? { action: "lift_stale_ban" } : { action: "already_gone" };
  return { action: "remove" };
}

export type GrantDecision =
  | { action: "already_member" }
  | { action: "banned_by_admin" }
  | { action: "create_invite" };

export function grantDecision(status: MemberStatus | null): GrantDecision {
  if (status === "creator" || status === "administrator" || status === "member") return { action: "already_member" };
  if (status === "kicked") return { action: "banned_by_admin" };
  // restricted users may or may not be members; Telegram reports is_member separately — caller maps to member/left.
  return { action: "create_invite" };
}

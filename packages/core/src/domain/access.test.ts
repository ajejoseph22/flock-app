import { describe, expect, it } from "vitest";
import { grantDecision, reconcileAction, revokeDecision } from "./access";

describe("reconcileAction", () => {
  it("issues an invite when access is desired and the user isn't in", () => {
    for (const s of [null, "pending", "revoked", "failed", "revoking"] as const) expect(reconcileAction(true, s)).toBe("issue_invite");
  });
  it("doesn't re-invite someone who left voluntarily", () => {
    expect(reconcileAction(true, "left")).toBe("none");
  });
  it("does nothing when desired and already invited or member", () => {
    expect(reconcileAction(true, "invited")).toBe("none");
    expect(reconcileAction(true, "member")).toBe("none");
  });
  it("revokes when not desired and access may exist", () => {
    for (const s of ["pending", "invited", "member", "failed", "revoking"] as const) expect(reconcileAction(false, s)).toBe("revoke");
  });
  it("does nothing when not desired and already gone", () => {
    expect(reconcileAction(false, null)).toBe("none");
    expect(reconcileAction(false, "revoked")).toBe("none");
    expect(reconcileAction(false, "left")).toBe("none");
  });
});

describe("revokeDecision", () => {
  it("never removes owners or admins", () => {
    expect(revokeDecision("creator", false)).toEqual({ action: "skip_admin" });
    expect(revokeDecision("administrator", true)).toEqual({ action: "skip_admin" });
  });
  it("removes members and restricted users", () => {
    expect(revokeDecision("member", false)).toEqual({ action: "remove" });
    expect(revokeDecision("restricted", false)).toEqual({ action: "remove" });
  });
  it("lifts a ban Flock left behind (crash between ban and unban) but not an admin's ban", () => {
    expect(revokeDecision("kicked", true)).toEqual({ action: "lift_stale_ban" });
    expect(revokeDecision("kicked", false)).toEqual({ action: "already_gone" });
  });
  it("treats left users as already gone", () => {
    expect(revokeDecision("left", false)).toEqual({ action: "already_gone" });
  });
});

describe("grantDecision", () => {
  it("recognises existing members", () => {
    expect(grantDecision("member")).toEqual({ action: "already_member" });
    expect(grantDecision("administrator")).toEqual({ action: "already_member" });
  });
  it("won't override a ban placed by a community admin", () => {
    expect(grantDecision("kicked")).toEqual({ action: "banned_by_admin" });
  });
  it("creates an invite otherwise", () => {
    expect(grantDecision("left")).toEqual({ action: "create_invite" });
    expect(grantDecision(null)).toEqual({ action: "create_invite" });
  });
});

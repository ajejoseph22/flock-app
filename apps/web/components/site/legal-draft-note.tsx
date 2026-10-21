/** Shown until counsel has reviewed the policy (tracked in docs/launch-checklist.md). */
export function LegalDraftNote() {
  return (
    <p className="rounded-md border border-warning/40 bg-warning-soft px-4 py-3 text-sm text-foreground">
      Draft: this plain-language policy has not yet been reviewed by a lawyer and may change before general availability.
    </p>
  );
}

import { Alert } from "./alert";

export type FormState = { ok?: boolean; error?: string | null; message?: string | null } | null;

export function FormMessage({ state }: { state: FormState }) {
  if (!state) return null;
  if (state.error) return <Alert tone="danger" title={state.error} />;
  if (state.message) return <Alert tone="success" title={state.message} />;
  return null;
}

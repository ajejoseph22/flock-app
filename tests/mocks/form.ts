/** Parse Stripe-style bracket form encoding (`a[b][0][c]=v`) into nested objects/arrays. */
export function parseBracketForm(input: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!input) return out;
  for (const pair of input.split("&")) {
    if (!pair) continue;
    const [rawKey, rawVal = ""] = pair.split("=");
    const key = decodeURIComponent(rawKey!.replace(/\+/g, " "));
    const value = decodeURIComponent(rawVal.replace(/\+/g, " "));
    const parts = key.split(/\[|\]\[|\]/).filter((p, i) => p !== "" || i === 0);
    let node: Record<string, unknown> | unknown[] = out;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const last = i === parts.length - 1;
      const nextIsIndex = !last && /^\d*$/.test(parts[i + 1]!);
      if (Array.isArray(node)) {
        const idx = part === "" ? node.length : Number(part);
        if (last) node[idx] = value;
        else node = (node[idx] ??= nextIsIndex ? [] : {}) as Record<string, unknown> | unknown[];
      } else {
        if (last) node[part] = value;
        else node = (node[part] ??= nextIsIndex ? [] : {}) as Record<string, unknown> | unknown[];
      }
    }
  }
  return out;
}

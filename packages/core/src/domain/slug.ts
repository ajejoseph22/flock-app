const RESERVED = new Set([
  "admin", "api", "app", "account", "billing", "dashboard", "help", "join", "login", "logout", "pricing",
  "privacy", "settings", "signup", "status", "support", "terms", "contact", "flock", "www", "static", "new",
]);

export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,46})[a-z0-9]$/;

export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
}

export function validateSlug(slug: string): string | null {
  if (!SLUG_PATTERN.test(slug)) return "Use 3–48 lowercase letters, numbers or hyphens, starting and ending with a letter or number.";
  if (slug.includes("--")) return "Avoid consecutive hyphens.";
  if (RESERVED.has(slug)) return "That address is reserved.";
  return null;
}

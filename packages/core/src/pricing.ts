/** Flock's own SaaS pricing (decision D-010). Change here; Stripe price IDs come from env. */
export const PLATFORM_PLANS = [
  {
    key: "beta",
    name: "Early access",
    priceMonthlyMinor: 0,
    currency: "usd",
    blurb: "Everything in Flock, free while we're in beta.",
    features: ["1 community", "Unlimited members", "0% Flock transaction fee", "Email support"],
  },
  {
    key: "starter",
    name: "Starter",
    priceMonthlyMinor: 1900,
    currency: "usd",
    blurb: "For a single paid community getting started.",
    features: ["1 community", "Up to 500 active members", "0% Flock transaction fee", "Email support"],
  },
  {
    key: "growth",
    name: "Growth",
    priceMonthlyMinor: 4900,
    currency: "usd",
    blurb: "For established communities that need room to grow.",
    features: ["Up to 5 communities", "Unlimited members", "0% Flock transaction fee", "Priority support"],
  },
] as const;

export type PlatformPlanKey = (typeof PLATFORM_PLANS)[number]["key"];

/** MVP product limits (D-009). */
export const LIMITS = {
  communitiesPerCreator: 1,
  activePlansPerCommunity: 1,
  benefitsPerCommunity: 8,
} as const;

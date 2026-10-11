export type Tier = "standard" | "premium";

export interface PlanConfig {
  starsPrice: number;
  durationDays: number;
  maxBookmarks: number;
  dailyDownloads: number;
  allowNsfw: boolean;
}

export const PLANS: Record<Tier, PlanConfig> = {
  standard: {
    starsPrice: 0,
    durationDays: 0,
    maxBookmarks: 20,
    dailyDownloads: 50,
    allowNsfw: false,
  },
  premium: {
    starsPrice: 50,
    durationDays: 30,
    maxBookmarks: Infinity,
    dailyDownloads: Infinity,
    allowNsfw: true,
  },
};

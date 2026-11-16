/**
 * Clip review labels. Shared by the review UI (client) and the training
 * export (server), so keep this file free of Node-only imports.
 */

/** Why a clip is bad. Fixed tags (not free text) so they can be counted. */
export const REJECT_REASONS = {
  starts_mid_thought: "Starts abruptly",
  ends_early: "Ends abruptly",
  runs_past_payoff: "Drags at the end",
  boring: "Boring",
  wrong_moment: "Off-topic / mixed topics",
  needs_context: "Needs earlier context",
  teaser: "Intro teaser",
  duplicate: "Repeat of another clip",
  promo: "Has a promo / ad",
} as const;

/** What made a good clip good, so the model learns which strengths matter. */
export const GOOD_REASONS = {
  strong_start: "Strong start",
  clean_ending: "Clean ending",
  one_topic: "One clear topic",
  insightful: "Useful / insightful",
  emotional: "Funny / emotional",
  would_post: "Would post as is",
} as const;

export type RejectReason = keyof typeof REJECT_REASONS;
export type GoodReason = keyof typeof GOOD_REASONS;
export type ReviewReason = RejectReason | GoodReason;

/** A person's verdict on a clip. This is the label the model is trained on. */
export interface ClipReview {
  verdict: "good" | "bad";
  /** Reject reasons for a bad clip, good reasons for a good one. */
  reasons: ReviewReason[];
  note: string;
  reviewedAt: number;
}

export function isRejectReason(value: unknown): value is RejectReason {
  return typeof value === "string" && value in REJECT_REASONS;
}

export function isGoodReason(value: unknown): value is GoodReason {
  return typeof value === "string" && value in GOOD_REASONS;
}

/**
 * Clip review labels. Shared by the review UI (client) and the training
 * export (server), so keep this file free of Node-only imports.
 */

/** Why a clip is bad. Fixed tags (not free text) so they can be counted. */
export const REJECT_REASONS = {
  teaser: "Intro teaser / montage",
  wrong_moment: "Wrong moment (doesn't match title)",
  starts_mid_thought: "Starts mid-thought",
  ends_early: "Ends before the payoff",
  runs_past_payoff: "Runs past the payoff",
  boring: "Not interesting",
  needs_context: "Needs earlier context",
  duplicate: "Duplicate of another clip",
  promo: "Includes a promo (like/share/subscribe, ad)",
} as const;

export type RejectReason = keyof typeof REJECT_REASONS;

/** A person's verdict on a clip. This is the label the model is trained on. */
export interface ClipReview {
  verdict: "good" | "bad";
  reasons: RejectReason[];
  note: string;
  reviewedAt: number;
}

export function isRejectReason(value: unknown): value is RejectReason {
  return typeof value === "string" && value in REJECT_REASONS;
}

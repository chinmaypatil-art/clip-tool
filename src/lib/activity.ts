import { processSingleton } from "./processState";

/**
 * What the self-restart in instrumentation.ts waits on: the open Library and
 * project pages poll every few seconds, so a few quiet minutes means nobody
 * has the site open. Uploads are counted while they stream, however long.
 */
const activity = processSingleton("activity", () => ({ lastRequestAt: Date.now(), uploads: 0 }));

export function noteRequest() {
  activity.lastRequestAt = Date.now();
}

export function uploadStarted() {
  activity.uploads++;
  noteRequest();
}

export function uploadFinished() {
  activity.uploads = Math.max(0, activity.uploads - 1);
  noteRequest();
}

export function quietFor(ms: number) {
  return activity.uploads === 0 && Date.now() - activity.lastRequestAt >= ms;
}

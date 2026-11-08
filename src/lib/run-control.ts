/**
 * The token that lets this browser pause or stop a run it started. It's kept in this tab's session
 * storage rather than the URL, so sharing the progress page doesn't share control of the run.
 */
const key = (jobId: string) => `run-control:${jobId}`;

export function saveControlToken(jobId: string, token: string) {
  try {
    sessionStorage.setItem(key(jobId), token);
  } catch {
    // Without storage the run still goes ahead; it just can't be paused or aborted from the page.
  }
}

export function loadControlToken(jobId: string) {
  try {
    return sessionStorage.getItem(key(jobId));
  } catch {
    return null;
  }
}

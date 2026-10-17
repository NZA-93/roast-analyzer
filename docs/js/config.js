// Where finished swipe batches are POSTed. DISABLED in this release (empty): answers stay on this device; use Export answers.
// Auto-submit (worker/) is switched on in a follow-up PR once its scoring and image checks have been signed off.
// Set to the deployed Cloudflare Worker URL (see worker/README.md), e.g. 'https://roast-feedback.<you>.workers.dev/batch'.
export const FEEDBACK_ENDPOINT = '';
export const CARDS_PER_SESSION = 20;

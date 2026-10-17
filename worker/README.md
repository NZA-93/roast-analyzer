# roast-feedback Worker (not deployed yet)

Receives finished swipe-review batches from the page and commits them to the **`swipe-feedback` branch**, opening one PR into main (or adding to the open one). It never writes to main.

- `feedback/images/<sha16>.jpg`: the photo (downscaled JPEG), only for photos that aren't in the repo yet
- `feedback/swipe/raw/<name>.json`: the raw batch (every answer with image sha256, bean id + centre, detector version, params.json hash, answer, reason, random/targeted, raw L*, glare, timestamp) so it can be rescored against a newer detector.
- `feedback/swipe/<name>-random.json` and `feedback/swipe/<name>-targeted.json`: `roast-analyzer/ground-truth@1` files the benchmark already reads. The random file is the unbiased one and carries the missed-bean taps. The targeted file is marked `source.biased: true`.

Checks run before anything is written. The Origin header is required. The rate limit is mandatory: 30 batches/hour per IP, and the Worker returns 503 without its KV store. Size caps are 64 KB for answers and 1.5 MB for the photo. The full schema check is `validateBatch`, the same code the page uses. A photo that isn't in the repo must come with the batch, or the Worker refuses it with a 422 and a clear message. Dedupe uses a content hash of the answers: the same answers sent again return 409.

## One-time setup (Nicolò, in your 1:1 chat)

1. Create a fine-grained GitHub token: repository access **only NZA-93/roast-analyzer**, permissions **Contents: Read and write** and **Pull requests: Read and write**, nothing else.
2. Create a free Cloudflare account, then from this folder run:
   ```
   npx wrangler login
   npx wrangler kv namespace create RATE      # paste the id into wrangler.toml
   npx wrangler secret put GITHUB_TOKEN       # paste the token
   npx wrangler deploy
   ```
3. Put the Worker URL plus `/batch` into `docs/js/config.js` (`FEEDBACK_ENDPOINT`). Answers already saved on a device will then send on their own.

The benchmark reads `feedback/swipe/*.json` once that PR is merged. Files marked `source.biased` (targeted answers) are skipped, and whole photos are held out of tuning and of the regression gate.

# roast-feedback Worker (not deployed yet)

Receives finished swipe-review batches from the page and commits them to `feedback/`:

- `feedback/swipe/raw/<name>.json`: the raw batch (every answer with image sha256, bean id + centre, detector version, params.json hash, answer, reason, random/targeted, raw L*, glare, timestamp) so it can be rescored against a newer detector.
- `feedback/<name>-random.json` and `feedback/<name>-targeted.json`: `roast-analyzer/ground-truth@1` files the benchmark already reads. The random file is the unbiased one and carries the missed-bean taps. The targeted file is marked `source.biased: true`.

Checks run before anything is written: an origin check, a 64 KB size cap, a per-IP limit of 30 batches/hour (KV), and the full schema check (`validateBatch` in `docs/js/swipe-core.js`, the same code the page uses). A duplicate batch id returns 409.

## One-time setup (Nicolò, in your 1:1 chat)

1. Create a fine-grained GitHub token: repository access **only NZA-93/roast-analyzer**, permission **Contents: Read and write**, nothing else.
2. Create a free Cloudflare account, then from this folder run:
   ```
   npx wrangler login
   npx wrangler kv namespace create RATE      # paste the id into wrangler.toml
   npx wrangler secret put GITHUB_TOKEN       # paste the token
   npx wrangler deploy
   ```
3. Put the Worker URL plus `/batch` into `docs/js/config.js` (`FEEDBACK_ENDPOINT`). Answers already saved on a device will then send on their own.

Note: each batch pushes to `feedback/`, which triggers the benchmark workflow once `ci/workflows/benchmark.yml` has been moved into `.github/workflows/`.

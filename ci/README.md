# GitHub Actions for the feedback loop (to install)

The bot's GitHub login has no `workflow` scope, so it can't push files into `.github/workflows/`. To switch the automation on, move these two files there once, either on the GitHub web UI or locally:

    git mv ci/workflows/*.yml .github/workflows/ && git commit -m "Enable detector workflows" && git push

- `benchmark.yml`: on every push to `feedback/**` (or a detector change), it evaluates, tunes, writes `docs/params.json` and the metrics history, and fails on a regression.
- `feedback-issue.yml`: turns a `detector-feedback` issue from the owner into `feedback/issue-N.json`, re-tunes, and replies on the issue.

Until then, run the same loop locally: `cd tools && npm ci && node benchmark.mjs --ci`.

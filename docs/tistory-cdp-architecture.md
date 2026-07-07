# Tistory CDP Architecture

## Overview

The Tistory publish skill automates the Tistory editor through a Chrome
DevTools Protocol (CDP) endpoint. It assumes that the caller provides the
runtime target explicitly instead of relying on repository-specific defaults.

This public repository intentionally avoids documenting production account
names, credential paths, cron identifiers, browser profile locations, or blog
permission maps. Keep those details in a private operational repository.

## Runtime Inputs

Pass deployment-specific values from a private wrapper, CI job, or local
environment:

- `--blog`: target Tistory blog domain.
- `--category`: visible Tistory category name.
- `--cdp-port`: Chrome CDP port for the active browser session.
- `TISTORY_CDP_PORT`: optional default for `--cdp-port`.
- `TISTORY_LOGIN_CRED_FILE`: optional credential file for `scripts/login.sh`.

The `publish-post.sh` orchestrator forwards the active `--blog` and
`--cdp-port` values to `login.sh` when it attempts login recovery.

## Session Model

- Each CDP browser profile should be treated as a separate authenticated
  session.
- A workflow that uses more than one account or blog should keep those browser
  sessions isolated.
- Public skill code should not hardcode production account names, private file
  paths, cron identifiers, or account-to-blog mappings.

## Public Example

```bash
ALLOW_DIRECT_TISTORY_PUBLISH=1 \
bash scripts/publish-post.sh \
  --title "Post title" \
  --body-file body.html \
  --category "$TISTORY_CATEGORY" \
  --blog "$TISTORY_BLOG" \
  --cdp-port "$TISTORY_CDP_PORT"
```

## Operational Notes

Store private deployment details in the repository or runbook that owns the
actual publishing workflow. This skill repository should stay reusable and safe
to publish.

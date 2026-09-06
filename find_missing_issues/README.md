# find_missing_issues

Audit script: lists Jira work items present in **Data Center** but missing in **Cloud** after a DC→Cloud migration. Produces an `.xlsx` with one tab per project (only when missing > 0), plus a Summary tab.

## Setup

```bash
npm install
cp .env.example .env       # then fill in DC + Cloud credentials
# (or: cp ../migrate_jsu_rules_dc_to_cloud/.env .env)
```

`.env` variables (identical to `migrate_jsu_rules_dc_to_cloud`):

- `DC_BASE_URL` — e.g. `https://jira-dc.example.com`
- `DC_PAT` *(preferred)* — Personal Access Token, **or**
- `DC_USERNAME` + `DC_PASSWORD` — basic auth fallback
- `CLOUD_BASE_URL` — e.g. `https://your-site.atlassian.net`
- `CLOUD_API_TOKEN` — base64-encoded `email:api_token`

## Run

```bash
node main/find_missing_issues.js
```

Auto-discovers every project on DC, then for each project compares DC issue keys (paginated `/rest/api/2/search`) against Cloud issue keys (paginated `/rest/api/3/search/jql`). Sequential per project; resilient against 429 / 5xx with exponential backoff.

Output: `reports/missing_issues_<timestamp>.xlsx`.

## Excel layout

- **Summary** tab — `Project | DC count | Cloud count | Missing | Status | Notes` (color-coded, auto-filter on)
- One tab per project with `missing > 0`:
  `Work Item | Summary | Work type | Status | Has Comments | Has Attachments`

`Has Comments` / `Has Attachments` come from DC (the side where the issue still exists). Booleans rendered as `Yes` / `No`.

### Status values (Summary tab)

| Status | Meaning | Fill |
| --- | --- | --- |
| `OK` | DC and Cloud match, nothing missing | green |
| `OK_EMPTY` | Project is empty on both sides | grey |
| `MISSING` | DC has issues not in Cloud — see project tab | amber |
| `PROJECT_NOT_IN_CLOUD` | Cloud has no project with this key (returned 400). All DC issues land in the project tab. | red |
| `NO_PERMISSION_CLOUD` | API token can't browse this Cloud project (403) | red |
| `FAILED` | DC or Cloud unrecoverable error after retries — see `Notes` column, then re-run | red |

## Notes

- No date filter: every DC issue is compared against Cloud. DC issues created after the migration cutoff will appear as "missing" — that's expected noise.
- Read-only: no writes to either instance.
- DC retry budget: 8 attempts (backoff 2,4,8,16,32,60,60,60s). Cloud: 6 attempts (2,4,8,16,30,30s).
- Safety cap: 500,000 issues per project (warns and stops).
- Sequential per project — no concurrency. Predictable, gentle on both APIs.
- Re-running is safe: each run writes a new timestamped file.

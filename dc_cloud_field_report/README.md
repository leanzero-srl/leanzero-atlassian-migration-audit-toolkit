# dc-cloud-field-report

Audits which **Data Center custom fields exist on Cloud** (matched by name) and
which don't — the answer to "what won't map after migration, and why."

## Run

```bash
cp .env.example .env   # fill in DC_PASSWORD + CLOUD_API_TOKEN
node field_report.js
```

Outputs to `./out/`:
- `dc_cloud_field_report_<stamp>.xlsx` — 2 sheets: **DC to Cloud Field Map** and
  **DC Fields NOT on Cloud** (with reason). Written only if an `exceljs` is
  resolvable from a sibling tool's `node_modules`; CSVs are always written.
- `dc_to_cloud_field_map_<stamp>.csv`
- `dc_fields_not_on_cloud_<stamp>.csv`

## Why it exists / lessons baked in

- The Cloud custom-field list is fetched via `GET /rest/api/3/field/search?type=custom`
  (paginated). **Plain `GET /rest/api/3/field` is INCOMPLETE** on some tenants — on
  a sandbox tenant it omitted Vendor / Support Area / Support Category, which
  produced false "not on Cloud" rows. Always use `/field/search` for completeness.
- Matching is by field **name** (exact, then ignoring a trailing `(migrated)` suffix,
  which JCMA sometimes appends). Cloud field IDs differ from DC, so name is the join key.

## Env

| var | meaning |
|-----|---------|
| `DC_BASE_URL`, `DC_USERNAME`, `DC_PASSWORD` | Data Center (Basic auth) |
| `CLOUD_BASE_URL` | e.g. `https://site.atlassian.net` |
| `CLOUD_API_TOKEN` | base64 of `email:api_token` |
| `STAMP` | optional filename suffix |

First built 2026-06-11 to report DC (`jira-dc.example.com`) → Cloud
(a sandbox tenant): 179 mapped, 32 DC-only.

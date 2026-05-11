# PolMonk Scraper — Project Documentation

This document describes the **polmonk-scraper** codebase: purpose, architecture, configuration, operational workflows, safeguards, and troubleshooting. Use it as the canonical reference when onboarding or archiving the project.

---

## 1. Purpose (what this project does)

**PolMonk Scraper** automates a utilities **overuse billing workflow** that spans:

1. **Polaroo** — Browser automation (Playwright) logs into Polaroo, navigates the accounting dashboard, searches per property, reads invoice tables, and selects electricity/water bills for a chosen **bimonthly period**.
2. **Overuse calculation** — Applies **room-based monthly allowances** (and special cases), sums selected bill costs, and computes **overuse = max(0, total cost − allowance)** for the period (with cohort-specific water/electricity rules).
3. **HouseMonk** — Optionally uploads bill PDFs and metadata to HouseMonk-backed storage and creates **invoices** tied to the correct **home / listing / tenant** using identifiers from your spreadsheet (`unitCode`).

The primary UX is a **local web app** (`Express` + static HTML/JS) that accepts an **Excel workbook**, runs Polaroo processing, shows results, and can trigger an **end-to-end** path: download PDFs → upload → create HouseMonk invoices.

---

## 2. High-level architecture

| Layer | Role |
|--------|------|
| **`index.html` + `script.js` + `styles.css`** | Browser UI: upload Excel, choose billing period, select properties, run processing, view results, trigger Step 2 end-to-end. Uses **Server-Sent Events** (`/api/process-properties-stream`) for live logs. |
| **`server.js`** | Express server: Polaroo automation, bill filtering, allowance/overuse math, batching, cancellation hooks, optional LLM-assisted bill selection, HouseMonk PDF upload + invoice endpoints. |
| **`test_modules/housemonk_auth.js`** | HouseMonk authentication (master token → user token), authenticated HTTP helper, **`HouseMonkIDResolver`** (`resolveFromUnitCode` → listing/home APIs). |
| **`test_modules/pdf_downloader.js`** | Polaroo PDF downloads using a shared Playwright **browser context** (reuse login session). |
| **`test_modules/aws_uploader.js`** | Presigned uploads of PDFs/metadata to HouseMonk storage. |
| **`test_modules/invoice_creator.js`** | Builds `/api/transaction` payloads and creates invoices; attaches `users: [tenantId]` when present. |
| **`scripts/`** | CLI utilities (name→home mapping export, optional listings). |
| **Root `test_*.js` / `extract_*.js` / `compare_*.js`** | One-off diagnostics, HouseMonk extracts, Book1 comparisons — **not** required for normal operation. |

**Note:** Folders such as `New try - backup/` contain older experiments and duplicate scripts; treat them as **archive**, not production entrypoints.

---

## 3. Prerequisites

- **Node.js** ≥ 18 (`package.json` `engines`).
- **npm** (`npm install` at project root).
- **Playwright Chromium** — Required if you run browsers locally (`npm run install-playwright` or `npx playwright install chromium`).
- **Polaroo** credentials (environment variables below).
- **Remote browser (recommended for production-like runs):** Browserless WebSocket URL — Playwright connects over CDP instead of launching local Chromium.

---

## 4. Installation & run

```bash
cd polmonk-scraper
npm install
# Optional: local Chromium for Playwright
npm run install-playwright

# Configure environment (see §5), then:
npm start
# Server listens on PORT or 3000 — open http://localhost:3000
```

**npm scripts** (from `package.json`):

| Script | Command |
|--------|---------|
| Start server | `npm start` → `node server.js` |
| Dev (nodemon) | `npm run dev` |
| HouseMonk smoke test | `npm run test:hm:smoke` |
| HouseMonk integration test | `npm run test:hm:full` |
| Map property names → homes (CLI) | `npm run map:homes` → `node scripts/map_names_to_homes.js` |
| Export mapped XLSX (needs JSON from mapper) | `npm run export:mapped` |

---

## 5. Environment variables

Set these in the shell, a `.env` file (if you load it — **this repo’s `server.js` reads `process.env` directly**; add `dotenv` yourself if you want `.env` auto-loaded), or your host’s dashboard.

### Polaroo & browser

| Variable | Purpose |
|----------|---------|
| `POLAROO_EMAIL` | Polaroo login email (**required** for processing). |
| `POLAROO_PASSWORD` | Polaroo password (**required**). |
| `BROWSER_WS_URL` or `BROWSERLESS_WS_URL` | WebSocket URL for remote Chromium (e.g. Browserless). If unset, behavior depends on `FORCE_LOCAL_CHROMIUM`. |
| `FORCE_LOCAL_CHROMIUM` | If `true`, launch **local** Chromium instead of remote WS. |
| `PROXY_URL` | Optional HTTP proxy for Playwright. |

### Optional intelligence / LLM

| Variable | Purpose |
|----------|---------|
| `OPENAI_API_KEY` | Used when **rule-based bill selection** is uncertain — **LLM-assisted** bill picking (`selectBillsWithLLM` in `server.js`). Comments in code still mention “Cohere” in places; the implemented fallback path uses this key. |

### HouseMonk

Configured primarily in **`test_modules/housemonk_auth.js`**:

| Variable | Purpose |
|----------|---------|
| `HM_ENVIRONMENT` | `production` (default) vs `sandbox` — switches base URL and baked-in defaults if env overrides are absent. |
| `HM_BASE_URL` | Override API host (e.g. production dashboard URL). |
| `HM_CLIENT_ID` | API client ID. |
| `HM_CLIENT_SECRET` | API client secret. |
| `HM_USER_ID` | User ID used for the integration access-token exchange. |

**Security:** Default client credentials and user IDs are **embedded in source** for convenience. For any shared or published copy of this repo, **rotate secrets** and move them to environment-only configuration.

### Server

| Variable | Purpose |
|----------|---------|
| `PORT` | HTTP port (default **3000**). |

---

## 6. Data format: Excel workbook

The UI reads the **first sheet** only.

| Column | Letter | Field | Required | Description |
|--------|--------|--------|----------|-------------|
| 1 | A | Property name | Yes | String matched against Polaroo search / internal logic; display name in results. |
| 2 | B | Rooms | No | Integer; drives **monthly allowance** (see §8). |
| 3 | C | `unitCode` | Strongly recommended for HouseMonk | Passed through to results and invoice flow. Resolver treats it as a **HouseMonk listing ID or home (`_id`)** — see `HouseMonkIDResolver.resolveFromUnitCode`. |

**Header row:** Row 1 is skipped; data starts at row 2 (`script.js` uses `slice(1)`).

---

## 7. UI workflow (typical)

1. **Upload** an `.xlsx` / `.xls` file.
2. **Properties tab:** Choose **billing period** (e.g. Jul-Aug), optionally **First 10 only**, select/deselect rows (list is **filtered by cohort** — see §9).
3. **Process** — POST `/api/process-properties` with selected properties. Modal shows progress + SSE logs.
4. **Results** — Per property: success/fail, bill counts, costs, **overuse**, warnings. Checkboxes select rows with overuse for downstream steps.
5. **Step 2 (End-to-end)** — Button runs `/api/run-overuse-end-to-end` with stored results: Polaroo PDF download → HouseMonk upload → **invoice creation** for eligible rows.

**Secrets tab** in `index.html` may be hidden by `script.js`; Polaroo credentials are expected from **environment**, not the form, in current flows.

---

## 8. Allowances & overuse

Implemented in `getMonthlyAllowance(propertyName, roomCount)` (`server.js`):

| Condition | Monthly allowance (€) |
|-----------|------------------------|
| Name matches **Padilla 1-3** (regex for various spellings) | **150** |
| Rooms ≤ 1 | 50 |
| 2 rooms | 70 |
| 3 rooms | 100 |
| ≥ 4 rooms | 130 |

**Overuse** (per processed period path):  
`overuse_amount = max(0, total_eligible_cost − total_allowance_for_period)`  
(Exact composition depends on one vs two months in the selected window — server aggregates costs vs allowances accordingly.)

High overuse (> **100 €**) can add a **warning** for manual review in logs.

---

## 9. Property cohorts & billing exceptions

The frontend **filters** which Excel rows appear for a given **period** using **EVEN vs ODD** cohorts (`PROPERTY_COHORTS` in `script.js`). Roughly:

- **EVEN** — Periods whose second month is even (e.g. Jul-Aug): Llull, Blasco, Torrent, Bisbe, Aribau, Comte, Borrell, Providencia.
- **ODD** — Second month odd (e.g. Aug-Sep): Padilla, Sardenya, Valencia, Sant Joan, St Joan.

**Important:** Authoritative business rules, **water-only / electricity-only** units, **date spillover (cutoff day 9)**, and naming aliases are documented in **`PROPERTY_COHORTS_AND_EXCEPTIONS.md`**. Server-side processing mirrors many of these lists — keep docs and code in sync when rules change.

---

## 10. HTTP API (main routes)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | SPA (`index.html`, no-cache). |
| GET | `/api/process-properties-stream` | **SSE** stream for logs/progress during runs. |
| POST | `/api/process-properties` | Main Polaroo scrape + bill selection + overuse (**resets in-flight run** — “nuclear” cancel of previous job). |
| POST | `/api/cancel-current-run` | Cooperative cancellation flag for long jobs. |
| POST | `/api/reset-browser-slots` | Clears stuck Browserless slot counters. |
| POST | `/api/process-properties-batch` | Batch variant (legacy / alternate batching). |
| POST | `/api/export-test-data` | Writes **`test_overuse_data.json`** for offline HouseMonk tests. |
| POST | `/api/process-overuse-pdfs` | PDF download/upload leg for overuse rows. |
| POST | `/api/housemonk/process-overuse` | HouseMonk-focused processing chain (see implementation). |
| POST | `/api/run-overuse-end-to-end` | **Download → S3 upload → create invoices** in one call. |

---

## 11. Fail-safes & operational behavior

### Concurrency & Browserless

- **`MAX_CONCURRENT_SESSIONS = 1`** — Only one active remote browser session at a time; others wait with timeout (**5 minutes**) then **reset slots** to avoid deadlock.
- **`waitForBrowserSlot` / `releaseBrowserSlot` / `resetBrowserSlots`** — Manual recovery if sessions crash without releasing.

### Batch / run locking

- **`ACTIVE_BATCH_PROCESSING`** — Prevents overlapping batch jobs (wait loop + timeout).
- **`CURRENT_PROCESSING_RUN` / `CURRENT_RUN`** — Cooperative **cancel** checks inside long loops; closing the modal can trigger **`/api/cancel-current-run`**.

### Processing start (“nuclear option”)

Starting **`/api/process-properties`** logs intent to **invalidate** previous runs so a stuck job does not block new work.

### Bill selection

1. **Rule-based** filtering by period, service type (electricity/water), cohort rules, exceptions (`NO_WATER_PROPERTIES`, `WATER_ONLY_PROPERTIES`, etc.).
2. **Retries** on empty table extraction (Polaroo flakiness).
3. **LLM fallback** when rules are ambiguous — requires **`OPENAI_API_KEY`**; if absent, falls back to rule-based with warnings.

### Polaroo session recovery

On certain failures, server may **recreate browser**, **re-login**, and retry **one property**.

### End-to-end invoice path

- Skips properties with **zero overuse** (unless debugging paths include “bills but no overuse”).
- **Retries** Browserless **429** with backoff when opening browser.
- Per-property **invoice errors** are caught so other properties still process; failures include **`unitCode`** in the response for debugging.

### Gas exclusion

PDF downloader **skips GAS** rows when iterating selected bills.

---

## 12. CLI: name ↔ HouseMonk mapping

**`scripts/map_names_to_homes.js`**

- **Input:** `Book1 - test.xlsx` by default, or path to `.xlsx`/`.csv` (columns: name, rooms, optional unitCode).
- **Behavior:** Fetches homes from HouseMonk API, scores **token Jaccard similarity** between Excel names and home names; writes **`housemonk_name_mapping.json`** and **`housemonk_name_mapping.csv`**.
- **Confidence:** `accepted` if exact normalized match **or** score ≥ **0.6**. Short labels vs long marketing titles yield **low scores** — prefer **full names** or use **`unitCode`** from Excel instead of fuzzy name matching.

**`scripts/export_mapped_xlsx.js`**

- Reads **`housemonk_name_mapping.json`** + optional original workbook for room counts.
- Outputs **`Book1_mapped.xlsx`** with columns `name`, `rooms`, `ID`.

---

## 13. HouseMonk invoice semantics

- **`createInvoiceForOveruse`** resolves **`unitCode`** → `homeId`, `projectId`, `listingId`, **`tenantId`**.
- Invoice **`users`** array is set to **`[tenantId]`** when the home has a tenant — HouseMonk may notify that user per platform settings (no separate SMTP in this repo).
- Files: PDFs + up to **3** small JSON blobs (summary / selected bills / monthly overuse when present).

---

## 14. Troubleshooting

| Symptom | Things to check |
|---------|------------------|
| `Cannot find module` / npm errors | Run `npm install` from project root; Node ≥ 18. |
| Polaroo login fails | `POLAROO_EMAIL` / `POLAROO_PASSWORD`; Polaroo DOM changes (selectors in `server.js` / `pdf_downloader.js`). |
| Empty bills / timeouts | Polaroo latency; increase waits; verify property search string matches Polaroo naming. |
| Browserless 429 / slots stuck | Wait; call **`POST /api/reset-browser-slots`**; reduce parallel usage elsewhere. |
| HouseMonk 401 / auth errors | Tokens expired; verify **`HM_*`** env and client secret; embedded defaults may be revoked. |
| Invoice creation fails | **`unitCode`** missing/wrong; home has no **tenant**; project missing **products/tax codes**. |
| Low mapping confidence | Use **full property names** or **`unitCode`**; adjust similarity threshold only if you accept false positives. |

---

## 15. Security & compliance

- **Secrets in repo:** Treat `housemonk_auth.js` (and any pasted tokens in docs) as **compromised** if the repo was ever public — **rotate** HouseMonk client secrets and review audit logs.
- **PII:** Logs may print tenant/property/bill metadata — restrict log storage and sharing.
- **Polaroo / HouseMonk:** Automation credentials grant significant access — use least-privilege accounts where possible.

---

## 16. Other markdown files in this folder

| File | Note |
|------|------|
| **`PROPERTY_COHORTS_AND_EXCEPTIONS.md`** | **Authoritative** billing/cohort notes — keep aligned with code. |
| **`HOUSEMONK_PRODUCTION_WORKFLOW.md`** | Useful workflow snippets; verify against current `invoice_creator.js` / URLs. |
| **`HOUSEMONK_INTEGRATION.md`** | Partially outdated (references export button / sandbox defaults); prefer this **`DOCUMENTATION.md`** + code. |
| **`QUICK_START.md`**, **`ARCHITECTURE_PLAN.md`** | Describe a **different** (Supabase/booking) architecture — **not** this app’s current behavior. |

---

## 17. Version & maintenance

- **Package name:** `login-portal` (legacy npm name); functionality is Polaroo + HouseMonk overuse automation.
- When updating rules, change **`server.js`** + **`script.js`** cohort lists + **`PROPERTY_COHORTS_AND_EXCEPTIONS.md`** together.
- After dependency or Polaroo UI changes, re-run a **single-property** test before full batches.

---

*Generated for inclusion in internal documentation / “books”; amend dates and owners locally as needed.*

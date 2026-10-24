# Shortlist Desk

Deployment address: **https://shortlist-desk.shortlists.workers.dev** · [Agent instructions](https://shortlist-desk.shortlists.workers.dev/agent) · [Upload workspace](https://shortlist-desk.shortlists.workers.dev/upload)

A website and HTTP API for company interview shortlists. Gemini (or another capable external agent) interprets company spreadsheets and joins them with a private student master. **The site validates and stores the result; it does not match students or call an AI API.**

Each result has exactly these columns, in this order, on one worksheet:

```text
name, roll, programme, branch, cpi, email
```

Rolls remain text; missing CPI stays blank/null, distinct from zero. Candidate order is preserved. Published lists are publicly viewable and downloadable. The master, originals, drafts, keys and processing notes require authentication.

The public interface contains the company shortlist index and student tables, with an **Owner login** link. Workspace navigation, upload controls, downloads and version management appear only after login. The login uses a plain text **Enter key** field: paste the portal owner key generated during setup and press Enter. Authorized uploader agents can still sign in at `/upload` or `/mail` with their separate uploader key.

CPI cells initially display `...`. One **Show CPI / Hide CPI** eye button above the student table controls every student in that shortlist, including other pages and filtered results. Revealed missing values display `—`. Reloading or opening another shortlist hides values again. This is a display preference, not an access restriction: the published data and public export API remain accessible. The public library keeps its shortlist/entry/latest-addition statistics; company pages show shortlisted students, CPI availability and Date added.

Company shortlist views include search and sorting, with a **Filters** button for programme, branch, batch, CPI availability and inclusive minimum/maximum CPI filters. Sort any column using its heading or the sort menu. Missing values stay last in both sort directions. **Original shortlist order** and **Reset view** restore the source ordering. These controls affect the displayed view; stored versions and the complete CSV/Excel downloads retain their original order.

The dashboard groups company names on the server, including case, spacing, punctuation and common legal-suffix variants; it does not fuzzy-match unrelated company names. The dashboard is a collapsible hierarchy: **Company → Round → Role → Shortlists**. Each level can be opened or closed independently. Company, round and role sections start collapsed; search and round filtering open matching paths automatically. Company, round and role groups are ordered by their latest **Date added**; shortlist events remain newest first. The round filter combines Test / Technical Test / Online Aptitude Test / OA / assessment as **Test**, interview variants as **Interview**, and GD / Group Discussion as **Group Discussion**. Buddy rounds and other stages stay distinct. Exact source round labels, event dates/times, seasons, candidate lists and IDs are retained. A combined GD / Interview source appears once under **Group Discussion + Interview** and is reachable from either filter. Unknown round labels are preserved. This is a read-only server view, automatically reflecting existing and newly published lists; agent prompts and stored identities are unchanged. `GET /api/v1/shortlists?grouped=1` adds `company_groups` and `round_categories`; the default flat API response stays unchanged.

Dashboard entries are ordered by **Date added**, newest first. For a mail-generated result this is the source mailbox receipt timestamp, read from IMAP `INTERNALDATE`; processing, publication, retry and duplicate-resend times do not replace it. A genuine revised version uses its own source date, and restoring a version restores that version's source date. Manual results fall back to their saved version date until an email is explicitly verified and linked; the earliest completed mail reference can then provide their source date. Internal creation/update timestamps remain available for audit and concurrency checks. The public label stays **Date added**.

## Published ambiguous identities

Ambiguous names are a valid published condition, not a draft-only state or a reason to put a mail job in review. Keep verified six-column identities in `rows`. Add one `unresolved_candidates` entry per uncertain source candidate, containing `source_name`, distinct one-based `source_index`, a short public `reason`, and `possible_rolls` from the selected `master_id` (up to 20 alternatives; `[]` when none is supported). The server snapshots each alternative's six-column details from that pinned master. Arbitrary option details and unknown master rolls are rejected. `rows: []` is supported when all candidates are ambiguous. The prepared JSON upload form supports this envelope; spreadsheets retain the six-column confirmed-row format.

The public shortlist shows these source candidates at the bottom with **Could be one of the following**, possible rolls, programme, branch, CPI and email. Alternatives are not presented as confirmed shortlisted people. The global CPI eye controls confirmed and possible-match CPIs together. `row_count` counts confirmed identities, `unresolved_count` counts uncertain source candidates, and `candidate_count` is their sum. Dashboard/detail student totals use that sum; three alternatives still count as one candidate. The default public JSON includes `unresolved_candidates[].possible_matches` separately from `rows`. No automatic identity selection or new eligibility decision is made.

Name ambiguity alone does not require warning approval, prevent publishing or block normal mail-job completion. Other missing-field warnings keep their existing acknowledgement requirement. Missing candidate evidence or unresolved company/role/event metadata still follows the existing mail review workflow. Completed mail sources follow the same seven-day retention policy; possible-match snapshots remain in immutable shortlist versions.

CSV and Excel retain one additional row per ambiguous source name with unknown identity/enrichment fields blank, without asserting any alternative as its roll or CPI. The CSV response includes `X-Unresolved-Candidates`. Full possible-match details remain in the website and JSON, which should be used for processing ambiguity. Never collapse alternatives into a guessed confirmed row.

## Mail workflow

Open **[Mail workflow](https://shortlist-desk.shortlists.workers.dev/mail)** to collect shortlist emails into a private processing queue. The owner and authorized uploader agents can read that queue. Email bodies, attachments, links and mailbox credentials are never public. The agent publishes only the prepared six-column company results.

The collector connects to the single configured IITK account at `qasid.iitk.ac.in:993` over TLS, using IITK's [documented external IMAP settings](https://www.iitk.ac.in/nt/faq/outlook.htm). It uses `EXAMINE`, `UID SEARCH` and `BODY.PEEK`, without sending mail, changing read flags, moving or deleting messages. It searches subjects/bodies for `shortlist`, `short list` and `short-list`, also covering plurals and variants such as `shortlists`, `short lists`, `shortlisted` and `short-listing`. Before storing a complete email, a second check requires a complete shortlist word in its decoded subject or body; generic `short`/`shortly`, hidden HTML and longer embedded substrings do not qualify. Incomplete sources remain review items. The agent determines actual company-shortlist relevance.

### Connect your mailbox privately

After deploying the migration and Worker, run this in the project folder in your own interactive terminal:

```bash
npm run setup:mail
```

Enter your IITK IMAP username and password when prompted. The password is hidden. The helper uploads both values through stdin to Cloudflare Worker secrets (`MAIL_USERNAME`, `MAIL_PASSWORD`), without printing them or saving a production credentials file. Never put them into an AI chat, GitHub, the public site, URLs or processing notes. Existing owner/uploader keys are unchanged. For isolated local development only, `npm run setup:mail -- --local` writes the ignored `.dev.vars` with file mode 0600.

Open `/mail` and click **Sync mailbox** to verify IITK connectivity and authentication. Secrets being present does not prove a successful login. If the institute requires a different IMAP authentication method, the application reports failure; it does not bypass OTP, disable 2FA or retry other accounts. The live IITK connection remains unverified until this first successful sync.

The owner can choose the IMAP folder, a 1–365 day lookback (default 30), optional exact sender addresses, approved link domains, and pause/resume syncing. Saving settings resets the scan cursor to recheck the lookback period; existing messages are deduplicated. Sender filters are matching rules, not proof that a sender is authentic.

### Run manually or from your own scheduled task

Copy **Copy task prompt** from `/mail` into your ChatGPT Work task and supply a separate uploader key. The clipboard contains the complete detailed workflow, including position/round interpretation, metadata examples, candidate-evidence checks, duplicate preflight, source-date behavior, matching, publication and recovery; it is not only a link. Configure its six-hour schedule in that product yourself. The website does not invoke an AI API or start/schedule a ChatGPT session. The full reusable workflow is at **[/mail-agent](https://shortlist-desk.shortlists.workers.dev/mail-agent)**.

To schedule it on ChatGPT Work web, first test the copied prompt in the same web chat and verify an actual run. Then ask: “Schedule this same workflow every day at 00:00, 06:00, 12:00 and 18:00 in Asia/Kolkata, returning to this chat. Fetch the latest portal workflow each run and use the uploader access already configured here. Notify me only about new/changed publications, failures or required decisions; stay quiet when nothing changes. Confirm the saved schedule.” Review it in [Scheduled](https://chatgpt.com/scheduled) and test **Run now**. Availability depends on workspace settings; web runs need the tools and access available to that chat. See the [official scheduled-task documentation](https://learn.chatgpt.com/docs/automations). This instruction does not create a task itself.

Each run calls `POST /api/v1/mail/sync`, then claims pending jobs and reads their sources. The queue is sorted by received date, newest first; undated messages use their import time. Sync batches are bounded to five matching messages, a 10 MiB byte budget and a time budget; repeat while `more` is true. A UID/UIDVALIDITY cursor tracks the mailbox and a lock prevents overlapping collectors. IMAP `INTERNALDATE` supplies received_at; a separate private sent_at preserves the original Date header for event/thread interpretation. A rescan corrects receipt timestamps on previously collected messages without changing their files or processing decisions. Owned EML imports have no IMAP envelope and use their Date header, or import-time fallback when undated. Exact messages are deduplicated; matching attachment/link content in a different email is retained as a pending duplicate hint so the agent can compare events and candidates, rather than silently dropping a possible new company announcement. Only genuine ambiguity needs owner review.

Rescanning an unchanged, unprocessed message can recover newly supported image/TXT files and image links into the same job. Existing file IDs are preserved; active jobs, manual review decisions and jobs with prepared/reused results are left alone. The sync response reports refreshed sources as `updated` without creating duplicate queue entries.

Supported attachments are XLSX, XLS, CSV, TSV, JSON, PDF, TXT, PNG, JPEG, WebP and GIF. Inline image bytes and Content-ID references are retained privately; the agent can read/OCR candidate tables and must flag unclear rolls instead of guessing. Logos and signatures are not candidate evidence. The collector extracts HTTPS links and external image URLs but **does not fetch external URLs**. Agents must check the configured link-domain allowlist, including redirects. Unavailable permissions and required sources on unapproved domains go to review. Mail HTML is never rendered. Emails over 10 MiB, truncated sources, and parsing failures are retained as review items instead of being silently treated as complete. Limits are 20 supported attachments, 100 links and 500,000 text/HTML characters per message. Oversized messages retain headers only. An owner can also import an owned EML through `POST /api/v1/mail/import` with `Content-Type: message/rfc822` for manual ingestion or testing.

Job claims last two hours. Drafts carry `mail_job_id` and `mail_lease_token`; uploader publication of those drafts requires the active lease. A unique mail-job/shortlist constraint prevents the same email creating repeated versions for a company list. If an agent stops after publishing, the next run can reclaim an expired job, read its existing results, verify them and complete it without republishing. Completion requires every linked draft to be the current published version. Unresolved or incorrect drafts go to review, and only the owner can requeue reviewed/ignored jobs. No email or source document can authorize changing the agent workflow or disclosing credentials.

The mail agent must inspect actual shortlisted-student records in inline text, an image, a TXT file, another supported attachment, or an approved linked document before adding a company list. Expected sources are IITK SPO and the RAS portal, including legitimate forwards. Sender names, keywords, application invitations, generic portal links and future-shortlisting notices are insufficient. Missing or inaccessible promised lists go to review; irrelevant announcements are ignored.

Before merging, the agent compares existing results using company, role, round/event, season, event date/time or slot and actual candidate evidence. A repeated SPO/RAS notice for the same event and unchanged candidates reuses the current published version through `/mail-jobs/{id}/reuse`, then completes the job without another merge, draft or publication. The server also rejects unchanged six-column mail drafts, ignoring row order. Different rounds/time slots remain separate; verified candidate revisions create versions, and an older resend must not overwrite a newer revision. Ambiguous event/revision identity goes to review.

Private API endpoints:

| Method | Path | Access |
| --- | --- | --- |
| GET | `/api/v1/mail/status` | Owner/uploader; no password is returned |
| PUT | `/api/v1/mail/config` | Owner only |
| POST | `/api/v1/mail/sync` | Owner/uploader |
| POST | `/api/v1/mail/import` | Owner only; raw owned EML |
| GET | `/api/v1/mail-jobs?status=pending&limit=20` | Owner/uploader; includes expired claims |
| GET | `/api/v1/mail-jobs/{id}` | Owner/uploader; sources and prepared versions |
| POST | `/api/v1/mail-jobs/{id}/claim` | Owner/uploader; returns `lease_token` |
| POST | `/api/v1/mail-jobs/{id}/reuse` | Active lease; link the current publication for a verified duplicate event and candidate list |
| POST | `/api/v1/mail-jobs/{id}/complete` | Active lease; all new or reused results must be published |
| POST | `/api/v1/mail/cleanup` | Owner only; fixed seven-day completed-source cleanup, also scheduled hourly |
| POST | `/api/v1/mail-jobs/{id}/review` or `/ignore` | Active lease; explanation required |
| POST | `/api/v1/mail-jobs/{id}/retry` | Owner only |

Processing limits and Cloudflare Free CPU/storage quotas still apply. The automated suite uses synthetic mail and an isolated local database; it cannot verify your password, IITK's authentication policy, or an external agent's scheduled-task capabilities.

## Hosting options

As checked on 24 October 2026:

| Option | Fit |
| --- | --- |
| **Cloudflare Workers Free + D1** | Recommended. Free quotas rather than a 30/60-day trial. This repository supports this option. |
| Static frontend + Supabase Free | Viable after a backend rewrite. Free projects pause after one week of inactivity. |
| Render Free | Needs backend adaptation. Web services sleep after 15 minutes idle; free Postgres expires after 30 days. Poor fit for two quiet months. |

Sources: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [Supabase pricing](https://supabase.com/pricing), [Render Free](https://render.com/docs/free).

This version uses a static React frontend, a small Worker API and D1 for database records and chunked private files. It needs no R2 subscription, ChatGPT hosting, ChatGPT sign-in, paid domain or AI API key.

Cloudflare Free includes 100,000 Worker requests/day, 5 million D1 rows read/day, 100,000 rows written/day, and **500 MB per D1 database**. All private files and retained versions count toward storage. Static asset requests are free. Stay on Workers Free and avoid paid add-ons. Exhausting D1 Free quotas causes errors instead of automatic paid overages. Platform terms and quotas can change; free hosting is not an uptime guarantee.

Cloudflare runs automatic mail cleanup **hourly**. Only jobs marked **completed (`done`) at least seven full days ago** are eligible, using their stable `completed_at` timestamp rather than email receipt/import/rescan dates. The cleanup deletes portal copies of the email body/links, superseded source JSON and attachment bytes. It never deletes or modifies any shortlist, draft/version history or student master. Pending, processing, review and ignored jobs remain intact. Mail attachments shared with an unfinished job or unpublished draft are retained until those references are resolved; later runs revisit them. Manually uploaded files are outside this policy. Original messages in the IITK mailbox are never deleted.

Receipt dates, result links, processing notes, source IDs and duplicate hashes remain as a small audit record, preventing rescans from recreating cleaned messages or changing **Date added**. Cleaned jobs show `source_deleted_at` and retain their prepared results; deleted attachment downloads return HTTP 410 and no longer appear among available uploads. An atomic database guard prevents drafts being saved against an attachment deleted during source validation. Historical completed jobs use their last recorded update time as the conservative initial completion time.

The private `/mail` page shows the policy and last cleanup time. `POST /api/v1/mail/cleanup` with `{}` runs the same fixed policy immediately for the owner; uploader keys cannot invoke cleanup or change its age/scope. This maintenance schedule runs on Cloudflare independently of ChatGPT tasks, browser sessions and mailbox sync settings. Runs are bounded to ten source jobs and twenty attachments, with a lease preventing overlap; any backlog continues on the next hourly run. `GET /api/v1/mail/status` includes the latest cleanup result. Review overall storage with `npx wrangler d1 info shortlist-db --json`.

Workers Free has a 10 ms CPU limit per invocation. Spreadsheet parsing runs in the browser and matching runs in the external agent. Large imports or heavy traffic may still hit limits: verify the actual master and sample files on the live deployment. The application's 10 MiB upload cap is not a performance guarantee.

## Deploy

Install Node.js 22.13+ and create a free [Cloudflare account](https://dash.cloudflare.com/sign-up). Then:

```bash
git clone https://github.com/karankk-05/shortlist-.git
cd shortlist-
npm ci
npx wrangler login
npm run setup:cloudflare
npm run deploy
npm run setup:owner
```

1. Approve Cloudflare's authorization page opened by `wrangler login`.
2. `setup:cloudflare` creates `shortlist-db`, updates its ID in `wrangler.jsonc`, and applies migrations. If that name already exists, enter the existing database ID in the config before rerunning. Commit the config change for future deployments; a database ID is not a credential.
3. `deploy` prints the HTTPS address, such as `https://shortlist-desk.<your-subdomain>.workers.dev`. Choose the free Workers subdomain if prompted. Owner access remains locked until the next step.
4. `setup:owner` generates a random 256-bit owner key and sends **only its SHA-256 hash** to Cloudflare's secret store. It prints the private key once in your terminal. Save it in a password manager. Do not share this owner key with AI agents or GitHub. Rerunning rotates owner access and invalidates prior owner sessions.

Open `/admin` on the new site and sign in with that key. Import your reviewed single-sheet student master. The importer stores only the six supported columns, even if the master has extra review columns. Import it through the private website; never put student data in this public repository.

This repository is configured for the owner's existing Cloudflare database. When deploying a fork to another account, reset `database_id` in `wrangler.jsonc` to `00000000-0000-0000-0000-000000000000` before running setup, so it creates a database in that account.

Create a separate, expiring uploader key in Owner settings for Gemini. Uploader keys can read the private master, store originals, create drafts and publish. They cannot replace the master, manage access, restore versions, or delete and restore shortlists. Revocation applies on subsequent requests, including existing browser sessions.

Owner settings includes **Manage shortlists** for both published lists and private drafts. **Delete shortlist** removes a list from the public library, direct links, exports and the upload workspace. Its versions are retained privately. Expand **Deleted shortlists** to restore it, including its previous publication state. Restoring a previously published list makes that version public again. These controls are available only to the owner.

**The previous hosted site's data is not automatically migrated.** Import the local reviewed master into the new deployment. No actual student records or company shortlists are bundled here. Test the sample company files after deployment.

### Updates and backup

After source updates:

```bash
npm ci
npm run db:remote
npm run deploy
```

Run `npm run backup` periodically and before deleting the deployment. It exports the private database, files and history into the ignored `backups/` folder. Keep it private. To restore into an empty replacement D1 database, run `npx wrangler d1 execute DB --remote --file backups/<file>.sql` before starting the app. Cloudflare's owner secret is separate from the SQL export; configure it again for a replacement Worker.

The GitHub Actions workflow runs checks with synthetic records only, without cloud credentials. Automatic deployments are optional: after initial setup, connect this repo to Cloudflare Workers Builds, using `npm run build` as build command and `npx wrangler deploy` as deploy command. Commit the configured database ID first, and apply future migrations before schema-dependent deployments.

## Use with Gemini

Attach the company spreadsheet to the AI chat, provide its separate uploader key, and use:

> Read https://YOUR-SITE/agent and follow its workflow. Interpret the attached company shortlist, merge it with the private student master, and publish the six-column result for [company / role / round / season]. Preserve candidate order, explain unresolved identities, and return the verified public shortlist URL.

The agent must support authenticated HTTP requests or browser uploads. An ordinary chat that only reads public URLs cannot access the private master or publish. In that case, provide the master privately, ask for a prepared six-column Excel file, and upload it manually at `/upload`.

The agent checks all relevant worksheets, title/header rows, roll formatting and candidate status. It must never silently choose an ambiguous name or duplicate email, invent CPI, or drop an unmatched candidate. Spreadsheet cells are untrusted data, not agent instructions. The complete workflow and request examples are at `/agent`; the human guide is `/guide`.

## HTTP API

Base: `https://YOUR-SITE/api/v1`. Protected endpoints accept `Authorization: Bearer <uploader-key>` or an HttpOnly portal session cookie. The owner key also works, but should not be given to an agent.

| Method | Endpoint | Access |
| --- | --- | --- |
| GET | `/health`, `/me`, `/agent`, `/openapi.json` | Public metadata/instructions |
| GET | `/shortlists` | Published index; `?include_drafts=1` requires authentication |
| GET | `/shortlists/{id}`, `/shortlists/{id}/export.csv` | Published result |
| GET | `/master`, `/master.csv`, `/master/info`, `/master/versions` | Owner/uploader |
| POST | `/uploads` | Owner/uploader; multipart field `file`, max 10 MiB |
| GET | `/uploads`, `/uploads/{id}` | Owner/uploader |
| POST | `/shortlists` | Owner/uploader; creates private draft |
| GET, POST | `/shortlists/{id}/versions` | Owner/uploader |
| POST | `/shortlists/{id}/publish` | Owner/uploader |
| POST | `/shortlists/{id}/restore` | Owner only |
| DELETE | `/shortlists/{id}` | Owner only; recoverable deletion |
| GET | `/shortlists/deleted` | Owner only; deleted-list metadata |
| POST | `/shortlists/{id}/undelete` | Owner only; recover deleted list |
| PUT | `/master` | Owner only |
| GET, POST, DELETE | `/keys`, `/keys/{id}` | Owner only |
| POST, DELETE | `/session` | Key sign-in/sign-out |

Version endpoints require expected concurrency IDs to prevent stale updates. Deletion and recovery require a JSON body containing `expected_updated_at` from the latest list metadata; stale changes return 409. Deleted versions cannot be read or republished until the owner restores the list. A new list cannot reuse a deleted list's company/role/round/season identity; restore the existing list first. Drafts stay private until explicitly published. A draft can link up to 20 private source uploads. Keys belong in headers or the login form, never URLs or public notes. Untrusted identity/email headers grant no owner access. Browser cookies are HttpOnly, SameSite=Strict and Secure on HTTPS; cookie-authenticated writes require the portal's origin.

## Local development and checks

```bash
npm ci
npm run setup:owner -- --local
npm run dev
```

Use the generated local key at `http://localhost:8787/admin`. Local D1 is isolated from cloud data. The dev command rebuilds the frontend, applies local migrations, then runs Wrangler; restart after source edits.

```bash
npm run typecheck
npm test
npm run build
npm run test:integration
```

Integration checks start an isolated local Worker/D1 on port 8788 and clean up afterward. They cover authentication, spoofed identity headers, multi-chunk private files, six-column validation, drafts, publishing, version conflicts, restoration, owner-only deletion, deleted export denial, stale deletion rejection, deleted-list recovery, CSRF and revoked keys, using synthetic records only. They do not verify Cloudflare account permissions, production CPU enforcement or Gemini's ability to operate the deployed site.

All setup, backup and test helpers live in `.helper/`. Builds, secrets, local databases, backups, student files and company samples are ignored by Git. The public repository contains source and synthetic fixtures only.

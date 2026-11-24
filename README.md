# ABCkit — ARICOM BUILDING CONTRACTORS Work Kit

Construction company management platform: projects, BOQs, site operations and daily reports, materials, procurement, plant, workforce/HR, finance, documents, tasks, reports, notifications, users and settings.

- **Frontend:** React 19 + TypeScript, Tailwind CSS 4, Radix primitives, Recharts, TanStack Query, React Router (hash routing)
- **Backend:** Firebase — Cloud Firestore, Firebase Authentication, Cloud Storage, one Cloud Function (`adminUsers`), Firebase Hosting
- **Delivery:** installable PWA (offline site-report drafting, Firestore offline cache), responsive mobile/tablet/desktop, Electron-ready
- **Demo Mode:** the full app with `[DEMO]` sample data, running only in the browser (no account, no server)

> The app was migrated from Supabase/PostgreSQL to Firebase. The original SQL (schema, triggers, RLS, seed) is kept in
> [`legacy-supabase/`](legacy-supabase/) as the reference the Firebase business rules were ported from.

---

## 1. Quick start (development)

```bash
npm install
cp .env.example .env.local        # Firebase web-app config (already filled in for project abckt-6b791)
npm run dev                        # http://localhost:5173
```

Without Firebase configuration the app shows a “Configuration required” screen with an **Open the demo** button.

## 2. Firebase setup (one time, Firebase console → project `abckt-6b791`)

1. **Plan:** Cloud Storage buckets created after Oct 2024 (`*.firebasestorage.app`) and Cloud Functions require the **Blaze** (pay-as-you-go) plan. Blaze keeps the free quotas; set a **budget alert** under Usage and billing.
2. **Authentication** → Get started → *Sign-in method* → enable **Email/Password**.
   - *Settings → User actions*: **disable “Enable create (sign-up)”** — staff accounts are created by administrators.
   - *Settings → User account management*: enable **email enumeration protection**.
   - *Settings → Authorized domains*: add your production domain.
   - *Templates → Password reset*: optionally set the action URL to `https://<your-domain>/#/reset-password`.
3. **Firestore Database** → Create database → *production mode* → region close to Tanzania (e.g. `europe-west` / `eur3`).
4. **Storage** → Get started (same region).
5. Deploy rules, indexes and the Cloud Function from this folder:
   ```bash
   npm i -g firebase-tools           # once
   firebase login
   npm --prefix functions install
   npm run deploy:rules              # firestore.rules + storage.rules + indexes
   npm run deploy:functions          # adminUsers (invite / activate / deactivate / set password)
   ```
6. **Hosting** (optional): `npm run deploy` builds the app and deploys Hosting + rules + functions (`firebase.json` → `dist/`).
   Any static host also works (Vercel, Netlify, Cloudflare Pages): build with `npm run build`, publish `dist/`, set the `VITE_FIREBASE_*` variables.
7. Recommended for production: **App Check** (reCAPTCHA Enterprise) for Firestore/Storage/Functions, **daily Firestore backups / PITR** (Firestore → Disaster recovery).

### Environment variables (`.env.local`)

| Variable | Secret? | Purpose |
|---|---|---|
| `VITE_FIREBASE_API_KEY`, `…_AUTH_DOMAIN`, `…_PROJECT_ID`, `…_STORAGE_BUCKET`, `…_MESSAGING_SENDER_ID`, `…_APP_ID` | No — public by design | Firebase web-app config. Security comes from Auth + rules, not from hiding these. |
| `VITE_FIREBASE_FUNCTIONS_REGION` | No | Region of `adminUsers` (default `us-central1`) |
| `VITE_USE_EMULATORS` | No | `true` = use local emulators (`npm run emulators`) |
| `VITE_DEMO_MODE` | No | `true` = force Demo Mode for the whole build (e.g. a public demo site) |

Never put a service-account key in a `VITE_*` variable or in the frontend.

## 3. Creating the first administrator (securely)

1. Firebase console → **Authentication → Users → Add user**: your own email and a strong password (≥ 10 characters, letters + digits).
2. Open ABCkit and sign in with it. On this **very first sign-in to an empty database**, ABCkit seeds the roles, permission matrix, company settings, numbering sequences and material categories, and makes that account the **active Super Administrator**. `firestore.rules` allow this only while `meta/bootstrap` does not exist, so it can happen exactly once.
3. Every account created later starts as an **inactive Employee** until an administrator activates it.
4. In ABCkit: **System Settings** (company details, logo, currency, taxes, numbering) → **User Management → Invite user** for each staff member with their role. The invited person receives a “set your password” email. (Without the `adminUsers` function — Spark plan — Invite still works: the browser creates the sign-in account through a separate in-memory Firebase instance, so the administrator stays signed in, then assigns the role and activates it under the normal security rules.)
5. Give site staff project access under **User Management → Project access** or the project's **Team** tab.
   **Changing a user's password:** User Management → user menu (⋯) → **Set new password** (type one or press *Generate*; by default the user is signed out of all devices). Needs the deployed `adminUsers` function (Blaze plan); only a Super Administrator can change a Super Administrator's password, and nobody can change their own here (use Profile). The password is never stored or logged — the audit log records only that it changed. Without the function, use **Send password reset email**.

No administrator password is stored in this repository.

Admin recovery (Firestore console): set `profiles/<uid>.is_active = true` and `role_id = "super_admin"`.

## 4. Sign-in, sessions and sign-out

| Feature | How it works |
|---|---|
| Sign in | **Email or username** + password. Usernames are optional (set under *My profile*); `usernames/{name}` maps a username to the account email and can only be read one document at a time. |
| Password storage | Never handled by ABCkit. Firebase Authentication verifies credentials server-side and stores only salted, memory-hard **scrypt** hashes (comparable to Argon2id/bcrypt). |
| Wrong password / unknown user | Same message for both (“Invalid email/username or password”), so the form cannot be used to discover accounts. |
| Brute-force protection | Firebase Auth server-side throttling (`auth/too-many-requests`) + a per-identifier cooldown in the browser (5 failures → 1 min, doubling up to 15 min). Enable App Check for stronger protection. |
| Remember me | On: the session survives browser restarts (local persistence). Off: it ends when the browser closes **and** after 30 minutes of inactivity. |
| Session expiry | Every session ends 30 days after sign-in. This is enforced **server-side** in `firestore.rules` (token `auth_time`), plus in the app. |
| Sign out | User menu → *Sign out*: clears the auth tokens and this device's offline Firestore cache, shows “You have been signed out”, and reloads on the sign-in page with the history entry replaced (Back cannot reopen a protected page). |
| Sign out of all devices | User menu or *My profile → Sessions*: writes `session_revocations/{uid}` with the **server** clock; `firestore.rules` then reject every token issued before it, on every device. Administrators can do this for a user (`revoke_sessions` with `user_id`). |
| Deactivation | `profiles.is_active = false` blocks all data access immediately (rules); the Cloud Function also disables the Auth account and revokes its refresh tokens. |
| Route protection | Every page except sign-in / password reset requires a session and an active profile; modules additionally require their permission (`Guard`), and the data itself is protected by the rules. |
| Cookies / CSRF | Firebase Auth uses bearer ID tokens (sent in the `Authorization` header), not cookies, so cross-site request forgery does not apply. Tokens are short-lived (1 h) and refreshed automatically. |

## 5. Demo Mode

- On the sign-in page click **Try the demo** (or set `VITE_DEMO_MODE=true` for a demo-only build).
- Pick a role from the list, or type a demo username/email. **Every demo account uses the password `demo1234`.**

| Role | Username | Email |
|---|---|---|
| Super Administrator | `demo.admin` | admin@demo.abckit |
| Administrator | `demo.sysadmin` | administrator@demo.abckit |
| Managing Director | `demo.md` | md@demo.abckit |
| Project Manager | `demo.pm` | pm@demo.abckit |
| Site Engineer | `demo.engineer` | engineer@demo.abckit |
| Site Supervisor | `demo.supervisor` | supervisor@demo.abckit |
| Quantity Surveyor | `demo.qs` | qs@demo.abckit |
| Accountant | `demo.accountant` | accountant@demo.abckit |
| Procurement Officer | `demo.procurement` | procurement@demo.abckit |
| Storekeeper | `demo.store` | store@demo.abckit |
| HR Officer | `demo.hr` | hr@demo.abckit |
| Employee | `demo.employee` | employee@demo.abckit |

- An orange **DEMO MODE** banner is always visible, with *Switch role*, *Reset demo* and *Exit demo*.
- Demo data (all `[DEMO]`) and uploaded files are stored only in that browser (IndexedDB). Demo Mode **never contacts Firebase**, and production accounts do not work in it.
- **Demo sign-in is not security**: the accounts and password are public and anyone with the browser can change the data. Never enter real company data in Demo Mode.

## 6. Roles and permissions

12 roles × 39 permissions, editable in *User Management → Roles & permissions*: Super Administrator (everything), **Administrator** (users, roles, settings, audit + read-only modules), Managing Director, Project Manager, Site Engineer, **Site Supervisor**, Quantity Surveyor, Accountant, Procurement Officer, Storekeeper, HR Officer, Employee.
`roles/{role}.perms` is the copy of the matrix that the security rules read. Project-level visibility comes from `projects.view_all` (company-wide) or project membership / being the project manager.

## 7. Architecture and security model

```
src/backend/
  index.ts            picks the backend: Firebase (production) or Demo Mode
  firebase.ts         Firebase init + auth / storage / functions adapters
  demo.ts, demoSeed.ts  browser-only demo backend and its [DEMO] data
  client.ts, query.ts   `db` — same call shapes as the supabase-js client the pages were written for
  engine.ts           runs queries (filters, joins, project scoping) and writes (one Firestore transaction
                      per write incl. numbering, stock ledger, notifications, audit log, cascades)
  domains/*.ts        business rules ported from the SQL triggers / views / functions
  schema.generated.ts table metadata generated from legacy-supabase/migrations (npm run schema:gen)
firebase/rules/*.rules  security-rule fragments → firestore.rules (npm run rules:build)
storage.rules           Cloud Storage rules (documents/, site-photos/, project-photos/, branding/)
functions/              Cloud Function adminUsers (invite, activate/deactivate, set password)
```

- **Firestore security rules are the enforcement layer** (the role of PostgreSQL RLS before): permission checks per collection, project scoping, pay-data confidentiality, immutable ledgers (inventory, GRN lines, financial transactions cannot be deleted), approvals only by holders of the approve permission, no self-approval of finance, locked approved BOQs/reports, append-only audit log, session validity.
- The business hooks in `src/backend/domains` run in the browser inside the same Firestore transaction as the write; rules re-check the security-relevant parts so a modified client cannot bypass them.
- Every insert/update/delete on business tables writes an **audit log** entry (who, when, before/after).

## 8. Testing

```bash
npm run typecheck     # TypeScript (strict)
npm run test          # unit tests: engine, auth/sessions/demo, every business domain (in-memory store, real hooks)
npm run test:rules    # security rules end-to-end on the Firebase emulators (needs Java 21+ and firebase-tools)
npm run build         # production build + service worker
```

On Windows run vitest from PowerShell or a path starting with `C:/` (from Git Bash `/c/...` vitest fails to load its config).

| Suite | Result |
|---|---|
| TypeScript `tsc -b` | ✅ 0 errors |
| Unit tests (7 files) | ✅ 94 / 94 |
| Security rules on emulators — Firestore + Storage (4 files) | ✅ 29 / 29 |
| Lint (`oxlint`) | ✅ 0 errors (style warnings only) |
| Production build + PWA | ✅ |

Authentication scenarios covered: successful sign-in (email and username), wrong password, unknown user (same message), throttling/cooldown, session persistence across a page refresh, 30-day expiry (rules reject old tokens), inactivity timeout without “Remember me”, sign-out of all devices (old tokens rejected, new sign-in works, back-dating refused), first-user bootstrap exactly once, new users inactive, no self-activation or role escalation, anonymous access denied, username mapping cannot be hijacked, role-based access per role, Demo Mode sign-in and separation (demo passwords/resets disabled, Firebase never initialised).

**Not yet tested:** clicking through the UI in a real browser against the live Firebase project (Auth and Firestore must first be enabled in the console, §2), the deployed `adminUsers` function, and email delivery. Do these in a staging run before go-live.

### Floating AI assistant (voice, sees the open page)

Users with `ai.view` get a round ✨ button on every page (`src/components/ai/FloatingAssistant.tsx`).
- **Sees the page:** each question carries the route and the visible text of the main area (`src/lib/ai/pageContext.ts`: table rows as `cell | cell`, no form values, no buttons except table headings/tabs, max 12,000 characters). The server fences it as untrusted data (`functions/src/ai/prompts.ts` `pageBlock`), so text on a page cannot instruct the AI.
- **Voice:** tap the microphone and speak Kiswahili (sw-TZ) or English (`src/lib/ai/voice.ts`, the browser's Web Speech API — Chrome or Edge; in those browsers the vendor's speech service transcribes the audio, ABCkit stores no audio). Answers are read aloud (`speechSynthesis`); in voice mode the model is told to answer briefly in plain spoken sentences (`VOICE_MODE_BLOCK`, effort `low`). *Hands-free* listens again after each answer.
- **Kiswahili voice:** reading answers in Kiswahili needs a Swahili voice on the device. Microsoft Edge provides natural online voices (e.g. "Rehema", "Daudi"); on Windows you can also add one under Settings → Time & language → Speech → Add voices. Without one, answers are read with the default voice and the panel says so.
- Same tools and permissions as the AI chat: it reads only what the user's role can open. Each question is logged in `ai_activity`. In Demo Mode a [DEMO] rule-based stand-in answers from the page text (e.g. stock below minimum) without any AI model.

### Hybrid AI voice engine (phase 1)

- **Providers (server, `functions/src/ai/providers/`):** the chat assistant goes through one provider-neutral turn format; adapters for **OpenAI** (Responses API, primary), **Google Gemini** (fallback) and **Anthropic Claude** (optional third). Order and on/off per provider in *AI Control Center → Assistant providers*. A provider is asked only when the ones before it are missing or fail; the answer says which one replied (`provider`, `fallback_from`) and usage/activity rows record it. Reports, email analysis and replies stay on Claude until phase 2.
- **Live voice (`src/lib/ai/realtime.ts`):** OpenAI Realtime over WebRTC. The `voiceSession` callable (needs `ai.view`, daily cap, *Live voice* switch) returns a 2-minute client secret for a session configured on the server (prompt, user context, open page, voice, tools). Tool calls arrive over the data channel and run in the browser under the user's permissions; the model can be interrupted (barge-in or the ✋ button); listening / speaking indicators, waveform and live transcripts in the panel. When the user opens another page during a call, the new page is sent as fenced, untrusted context.
- **Fallback voice:** without an OpenAI key, in browsers without WebRTC, or in Demo Mode, the microphone uses the browser's speech recognition + the chat assistant (OpenAI → Gemini → Claude, or [DEMO]).
- **"Hey ABC" (`src/lib/ai/wakeWord.ts`):** optional (panel → settings). Recognised **offline in the browser** with Vosk (WebAssembly); the English small model (`public/models/vosk-small-en.tar.gz`, 41 MB, Apache-2.0, downloaded once and cached; the 6 MB engine is not precached). No audio leaves the device for wake-word detection. It wakes only on an utterance that starts with "hey a b c" recognised with ≥ 0.8 confidence per word; a grammar of common words absorbs ordinary speech (tested with ordinary and near-miss sentences: no false wake-ups). It pauses while the tab is hidden and while the assistant listens or speaks, and switches itself off on microphone errors. Kiswahili wake phrases are not possible with this model ("Hey ABC" only).
- **Actions with confirmation (`ACTION_TOOLS` in `src/lib/ai/tools.ts`):** create a task, update a task (status / progress / due date), raise a purchase request (submitted for approval — never approved or ordered), mark notifications read. Offered only in the floating assistant, within the user's role. Each one shows a confirmation card and is read aloud; it runs only after "ndiyo" / "yes" **spoken after the question** (a sentence containing both yes and no is ignored, so the assistant's own question picked up by the microphone cannot confirm it) or the button. Every attempt is recorded in `ai_activity` as `assistant_action` (done / declined / not done). **Not available to the assistant at all:** sending email (stays *Approve & Send*), approving or making payments, approvals, deleting records, issuing purchase orders, changing financial records.
- **New read tools:** `get_employee_directory`, `get_attendance_summary` (HR access), `get_inventory`, `generate_project_report`. The phase-1 command list maps to: get_projects → `list_projects`, get_project_details / get_project_progress → `get_project_details` / `list_projects`, get_pending_approvals → `list_pending_approvals`, summarize_email → `get_email` (stored AI summary), draft_email → `prepare_email_reply` (draft only), open_dashboard → `open_page`.
- **Demo Mode:** never calls `voiceSession` or any provider; the [DEMO] rule-based assistant understands spoken / typed commands in Kiswahili and English ("Unda kazi ya … kesho kwa mradi wa …", "Kamilisha kazi ya …", "Omba mifuko 50 ya cement kwa mradi wa …", "Soma arifa zote") and runs them through the same confirmation cards on demo data.

### The assistant opens and reads company files

Tools (`src/lib/ai/tools.ts`, only for roles with `documents.view`; files are downloaded under the user's own Storage rules):
- `search_documents` — finds files in Documents by title/description/tags/file name (English + Kiswahili words such as *mkataba*, *kumbukumbu*, *nukuu*), project or category.
- `open_document` — shows the file on the user's screen in the in-app viewer (`src/components/ai/FileViewer.tsx`): PDF and pictures as they are, Word/Excel/PowerPoint/CSV/text as text, with a Download button.
- `read_document` — gives the AI the content (`src/lib/ai/fileText.ts`): .docx/.pptx/.xlsx/.csv/.txt as text (long files in 12,000-character parts); **PDFs and pictures are attached for Claude to read/look at** (scanned PDFs and site photos included; pictures are downscaled to 1568 px; PDFs up to 3 MB are attached, larger ones are read as text only). Old .doc/.xls, CAD (.dwg/.dxf) and ZIP files cannot be read, only opened/downloaded.
- `open_page` — takes the user to a menu page they are allowed to open.

File content is untrusted: text is fenced in `<document_content>` and the model is told never to follow instructions inside files. The server accepts only base64 JPEG/PNG/WebP/GIF images and PDF documents inside tool results (≤ 4.8 MB each, ≤ 7 MB per request; `functions/src/ai/complete.ts`). In Demo Mode four [DEMO] sample files are generated on first use (`src/backend/demoFiles.ts`: PDF contract, Word minutes, Excel quotation, CSV BOQ). In production, Documents needs Firebase Storage (Blaze plan).

## 9. Known limitations of the Firebase port

- **Queries run partly in the browser.** Equality filters go to Firestore; text search, ranges, joins and sorting are applied in the app. That is fine for a company-sized dataset (thousands of rows); very large collections (e.g. years of attendance) may later need composite indexes and server-side ranges.
- **Recent activity feed** reads the audit log, which only roles with `audit.view` may read; other roles see an empty feed.
- **Overdue-task reminders** are generated for the signed-in user's own tasks (once a day, at sign-in), not for everyone by a server job.
- **Storage rules** decide company-wide file access from a fixed list of roles (`storage.rules`); a custom role given `projects.view_all` later keeps member-only file access until it is added there.
- Business hooks run in the client; the security-critical checks are duplicated in the rules, but a few consistency details (e.g. generated amounts, equipment meter readings) are trusted from the client. Moving hooks to Cloud Functions triggers is the next hardening step.

## 10. Backups

- Enable **scheduled backups / Point-in-Time Recovery** in the Firestore console.
- `npm run db:backup` runs a managed export to `gs://abckt-6b791-backups` (create the bucket first; needs `gcloud`).
- Storage files are not in Firestore exports: copy the bucket separately (`gcloud storage cp -r`).

## 11. Feature status

### Completed

| Module | Highlights |
|---|---|
| Dashboard | Live KPIs (active/completed/pending projects, contract value, expenditure, remaining budget, receivables/payables, stock alerts, attendance), charts for revenue vs expenses, monthly expenditure, budget vs actual, project performance (progress vs time elapsed), workforce man-hours; progress list, deadlines, activity feed. All from Firestore and filtered by the viewer's permissions. Every chart has a data-table view. |
| Projects | Create/edit/archive/restore, clients, PM assignment, team members, dates, contract value, budget, progress, status, dedicated workspace with 11 tabs, project photos, documents |
| BOQ & Estimates | Sections/items with inline editing, units, live Amount = Qty × Rate, section totals, configurable multi-tax, grand total, submit/approve/lock, revisions, PDF, Excel **with live formulas**, print, estimate vs actual and cost by category |
| Site operations & daily reports | Mobile-first report form (labour by trade, work done, materials, equipment, weather, progress, problems, safety, recommendations, photos from camera, signature), offline drafting & sync with conflict handling, approval/return, printable view & PDF, safety incident register, “today across sites” overview |
| Materials & inventory | Material register, categories, units, prices, min levels, receipts/issues/returns/adjustments ledger, negative-stock protection with authorised override, low-stock alerts, consumption by project, valuation |
| Procurement | Suppliers (rating, terms), purchase requests with approval, POs from requests, PO approval, PDF PO, GRN against PO (posts stock, tracks partial delivery), supplier invoices with paid/balance, supplier performance (delivery %, on-time %, value, balance) |
| Equipment | Register with auto IDs, assignment to projects, usage/fuel/hour-meter logs, maintenance & breakdowns (status updates equipment), utilisation report |
| Workforce & HR | Employee register, positions/departments, project assignments, daily attendance & timesheet sheet with overtime, leave with approval, confidential pay details, payroll generation from attendance, performance/attendance report, self-service profile (attendance, leave request, payslips) |
| Finance | Income/expense transactions with categories, multi-currency + exchange rate, methods, references, attachments, approval/reject/void, payment vouchers and receipts (PDF), petty cash, client invoices/certificates with retention and balances, cash flow, P&L by project, cost breakdown |
| Documents | Upload (drag & drop, multi-file), categories, project filter, search, access levels, version history, download via access-checked download URLs |
| Tasks & scheduling | Tasks & milestones, assignment, priority, deadlines, progress, overdue detection, list and calendar views, quick status, notifications |
| Reports & analytics | 12 reports (progress, cost, budget variance, BOQ, inventory, procurement, workforce, attendance, equipment, cash flow, financial ledger, profitability); every table exports PDF/Excel/CSV |
| Notifications | In-app, realtime bell, approvals, assignments, low stock, report submission/decision, overdue reminders; company-level switches |
| Users | Invite, role assignment, activate/deactivate, password reset, project access, editable permission matrix, last-active tracking |
| Settings | Company profile & logo, currencies, taxes, units, document numbering, financial year, notification settings, audit log viewer, backup guidance |
| Platform | Responsive layout (sidebar/desktop, drawer + bottom quick actions/mobile), dark/light mode, global search (Ctrl K), loading/empty/error/success states, installable PWA with update prompt, Electron shell |


### Desktop (Electron)

The app runs from `file://` (relative asset paths + hash routing): `npm run build && npm i -D electron && npx electron electron/main.cjs`.

# ABCkit — ARICOM BUILDING CONTRACTORS Work Kit

Construction company management platform: projects, BOQs, site operations and daily reports, materials, procurement, plant, workforce/HR, finance, documents, tasks, reports, notifications, users and settings.

- **Frontend:** React 19 + TypeScript, Tailwind CSS 4, Radix primitives (shadcn-style components), Recharts, TanStack Query, React Router (hash routing)
- **Backend:** Supabase — PostgreSQL 15+, Auth, Storage, Row Level Security, one Edge Function
- **Delivery:** installable PWA (offline site-report drafting), responsive mobile/tablet/desktop, Electron-ready

---

## 1. Quick start (development)

```bash
npm install
cp .env.example .env.local        # fill in your Supabase URL + anon key
npm run dev                        # http://localhost:5173
```

Without `.env.local` the app shows a “Configuration required” screen instead of failing.

### Interactive demo (no account, no Docker)

On the “Configuration required” screen click **Open interactive demo**. The full app then runs against an in-browser PostgreSQL database (PGlite) that applies the real migrations, RLS policies and the `[DEMO]` seed. Pick any role on the sign-in screen (password for all demo accounts: `demo1234`). Data is stored only in that browser; use **Reset demo** / **Exit demo** in the orange banner. Demo mode is never active when real Supabase credentials are configured (or force it with `VITE_DEMO_MODE=true`). File uploads in the demo are kept in the browser's IndexedDB.

## 2. Database configuration

All schema, security and seed SQL lives in `supabase/`:

| File | Contents |
|---|---|
| `migrations/…0100_core.sql` | roles/permissions tables, profiles, permission helpers, company settings, document numbering, audit log, notifications |
| `migrations/…0200_projects_boq.sql` | clients, projects, project members, BOQs/sections/items, BOQ totals view, BOQ revision RPC |
| `migrations/…0300_operations.sql` | daily site reports & photos, safety incidents, materials & stock ledger, suppliers, purchase requests/orders, GRNs, supplier invoices, equipment, usage, maintenance |
| `migrations/…0400_hr_finance_docs_tasks.sql` | employees, confidential compensation, assignments, attendance, leave, payroll, client invoices, financial transactions, documents & versions, tasks |
| `migrations/…0500_roles_rls.sql` | the 10 default roles, permission matrix, **Row Level Security on every table** |
| `migrations/…0600_analytics_storage.sql` | reporting views, dashboard RPCs, storage buckets and storage policies |
| `seed.sql` | **demo data for local development only** (every row flagged `is_demo` and prefixed `[DEMO]`) |
| `functions/admin-users/` | Edge Function for inviting users and suspending sessions (uses the service-role key server-side) |

### Option A — hosted Supabase (production)

1. Create a project at <https://supabase.com> (region close to Tanzania, e.g. `eu-central` or `af-south` if offered).
2. Link and push the migrations (this does **not** load demo data):
   ```bash
   npx supabase login
   npx supabase link --project-ref <your-project-ref>
   npm run db:push
   ```
3. Deploy the Edge Function: `npm run functions:deploy`
   Optional: `npx supabase secrets set ALLOWED_ORIGIN=https://your-app-domain` to restrict CORS.
4. **Auth settings** (Dashboard → Authentication):
   - *Sign In / Providers → Email*: keep email+password, **disable “Allow new users to sign up”** after the first admin exists (staff are invited from the app).
   - *URL Configuration*: set **Site URL** to your app URL and add `https://your-app-domain/**` to Redirect URLs (needed for invitation and password-reset links).
   - *SMTP*: configure your own SMTP sender for production volumes; the built-in sender is rate limited.
5. Optional — daily overdue-task reminders on the server (the app also triggers this once a day per device):
   ```sql
   create extension if not exists pg_cron;
   select cron.schedule('abckit-overdue', '0 5 * * *', 'select public.notify_overdue_tasks()');
   ```

### Option B — local stack (Docker)

Requires Docker Desktop **with WSL 2** on Windows (`wsl --install`, then reboot).

```bash
npm run db:start      # starts Postgres, Auth, Storage, Studio locally; prints URL + anon key
npm run db:reset      # re-applies migrations + seed.sql (demo data)
```

Put the printed `API URL` and `anon key` into `.env.local`.

## 3. Environment variables

| Variable | Where | Secret? | Purpose |
|---|---|---|---|
| `VITE_SUPABASE_URL` | `.env.local` / hosting env | No | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | `.env.local` / hosting env | No (public by design) | Anon/publishable key; RLS protects the data |
| `SUPABASE_SERVICE_ROLE_KEY` | injected automatically into Edge Functions | **Yes** | Used only by `admin-users`; **never** put it in a `VITE_*` variable |
| `ALLOWED_ORIGIN` | Edge Function secret (optional) | No | CORS origin for `admin-users` |

The frontend refuses to start if a service-role key is supplied by mistake.

## 4. Admin account setup

1. Make sure public sign-up is still enabled (temporarily).
2. Create the first account: Dashboard → Authentication → Users → **Add user** (email + password, “Auto confirm”), or sign up once.
3. The **first account ever created automatically becomes an active Super Administrator** (database trigger). Every later self-registered account is created **inactive** with the *Employee* role until an administrator activates it.
4. Sign in to ABCkit, then **disable public sign-up** in the Supabase dashboard.
5. Go to **System Settings** → set company details, logo, currency, taxes, units, numbering and financial year.
6. Go to **User Management** → **Invite user** for each staff member, choosing their role. (Requires the `admin-users` function. Without it: add the user in the Supabase dashboard, then activate them and set their role in User Management.)
7. For users without company-wide access (site engineers, employees), add them to projects under **User Management → Project access** or on the project's **Team** tab.

To recover admin access manually (SQL editor):
```sql
update public.profiles set is_active = true,
  role_id = (select id from public.roles where key = 'super_admin')
where email = 'admin@yourcompany.co.tz';
```

## 5. Deployment

The build output is static files in `dist/` (hash routing — no server rewrites needed).

```bash
npm run build      # typecheck + production build + service worker
```

| Host | Settings |
|---|---|
| **Vercel** | Framework: Vite · Build: `npm run build` · Output: `dist` · add the two `VITE_*` env vars |
| **Netlify** | Build: `npm run build` · Publish: `dist` · env vars as above |
| **Cloudflare Pages** | Build: `npm run build` · Output: `dist` · env vars as above |

After the first deploy, add the production URL to Supabase **Site URL / Redirect URLs** (step 2.4).
HTTPS is required for installation as a PWA and for camera capture.

### Desktop (Electron) packaging

The app already runs from `file://` (relative asset paths + hash routing). `electron/main.cjs` is a minimal, sandboxed shell:
```bash
npm run build && npm i -D electron && npx electron electron/main.cjs
```
For installers add `electron-builder` and point it at `electron/main.cjs` + `dist/`.

## 6. Security model

- **Authentication:** Supabase Auth (email + password, PKCE). Passwords: min. 10 characters with letters and digits (enforced in the UI; also set the same policy under Auth → Password settings).
- **Roles & permissions:** 10 default roles × 39 permissions in `roles` / `permissions` / `role_permissions`; editable in *User Management → Roles & permissions*. Super Administrator always has everything.
- **Row Level Security on every table.** The UI hides what a role can't use, but **every rule is enforced in PostgreSQL**:
  - project data is visible only to company-wide roles, the project manager, or project members;
  - employee pay data (`employee_compensation`, `payroll_records`) only to payroll-authorised roles;
  - restricted/management documents only to authorised roles; storage paths are scoped by project ID.
- **Server-side business rules (triggers):** stock can't go negative without an authorised approver; stock balances only change through the ledger; ledger and finance rows can't be deleted; approved transactions can't be edited (void with reason only); accountants can't approve their own transactions; BOQs lock on approval; approvals (BOQ, site reports, purchase requests/orders, finance, leave) check the approver's permission; the last Super Administrator can't be demoted.
- **Audit trail:** every insert/update/delete on business tables is logged with before/after values and the user (*System Settings → Audit log*).
- **Deactivation:** revokes all database access immediately; the Edge Function also bans the auth user so sessions stop refreshing.
- **Uploads:** client checks (type, 50 MB) plus bucket-level MIME allow-lists and size limits.

## 7. Backups

- Supabase takes daily backups automatically; enable **Point-in-Time Recovery** for production.
- Weekly logical dump to separate, encrypted storage: `npm run db:backup` (writes `backups/schema.sql` and `backups/data.sql`).
- Storage files are not in database dumps: sync the buckets (`documents`, `site-photos`, `project-photos`, `branding`), e.g. with `rclone` against the Supabase S3 endpoint.
- Restore-test into a staging project quarterly.

## 8. Testing

```bash
npm run test       # unit tests (calculations)
npm run test:db    # database integration tests (no Docker needed)
npm run test:all   # typecheck + both suites
```

`test:db` applies every migration to a real PostgreSQL engine running in-process (PGlite/WASM) with stubs for Supabase's `auth` and `storage` schemas, then runs scenarios **as each role** through RLS.

### Testing report (latest run)

| Check | Result |
|---|---|
| TypeScript (`tsc -b`, strict) | ✅ 0 errors |
| Production build + service worker | ✅ 90 precached entries |
| Unit tests (BOQ amounts/section totals/taxes/grand total, variance, stock, payroll) | ✅ 6 / 6 |
| Database integration tests | ✅ 34 / 34 |
| Lint (`oxlint`) | ✅ 0 errors (style warnings only) |
| Built app served over HTTP: page, manifest, service worker, icons | ✅ |

Database scenarios covered: first-user bootstrap · inactive users see nothing · role self-escalation blocked · project scoping per role · BOQ math, approval lock and revision copy · site-report submit → PM notification → approval → project progress roll-up · idempotent offline sync key · stock receipts/issues, negative-stock block and authorised override, immutable ledger · full procurement cycle PR → approval → PO → approval → partial/complete GRN updating stock and PO status · over-receipt rejection · finance segregation of duties, edit/delete protection, void-with-reason, invoice payment status · audit visibility · pay-data confidentiality · attendance → payroll generation · document versioning and restricted access · storage path scoping · task notifications and idempotent overdue reminders · dashboard/analytics RPCs per role · deactivation · anonymous access denied · demo seed integrity.

The tests found and fixed three defects before release: project creation failed under RLS (`INSERT … RETURNING`), voiding an approved transaction was always rejected, and negative-stock approvers could not post the movement they were authorising.

**Not yet tested:** clicking through the UI in a browser against a live Supabase project, the `admin-users` Edge Function (needs a deployed project), and offline sync on a physical phone. Do these in staging before go-live (checklist in §10).

## 9. Feature status

### Completed

| Module | Highlights |
|---|---|
| Dashboard | Live KPIs (active/completed/pending projects, contract value, expenditure, remaining budget, receivables/payables, stock alerts, attendance), charts for revenue vs expenses, monthly expenditure, budget vs actual, project performance (progress vs time elapsed), workforce man-hours; progress list, deadlines, activity feed. All from the database and filtered by the viewer's permissions. Every chart has a data-table view. |
| Projects | Create/edit/archive/restore, clients, PM assignment, team members, dates, contract value, budget, progress, status, dedicated workspace with 11 tabs, project photos, documents |
| BOQ & Estimates | Sections/items with inline editing, units, live Amount = Qty × Rate, section totals, configurable multi-tax, grand total, submit/approve/lock, revisions, PDF, Excel **with live formulas**, print, estimate vs actual and cost by category |
| Site operations & daily reports | Mobile-first report form (labour by trade, work done, materials, equipment, weather, progress, problems, safety, recommendations, photos from camera, signature), offline drafting & sync with conflict handling, approval/return, printable view & PDF, safety incident register, “today across sites” overview |
| Materials & inventory | Material register, categories, units, prices, min levels, receipts/issues/returns/adjustments ledger, negative-stock protection with authorised override, low-stock alerts, consumption by project, valuation |
| Procurement | Suppliers (rating, terms), purchase requests with approval, POs from requests, PO approval, PDF PO, GRN against PO (posts stock, tracks partial delivery), supplier invoices with paid/balance, supplier performance (delivery %, on-time %, value, balance) |
| Equipment | Register with auto IDs, assignment to projects, usage/fuel/hour-meter logs, maintenance & breakdowns (status updates equipment), utilisation report |
| Workforce & HR | Employee register, positions/departments, project assignments, daily attendance & timesheet sheet with overtime, leave with approval, confidential pay details, payroll generation from attendance, performance/attendance report, self-service profile (attendance, leave request, payslips) |
| Finance | Income/expense transactions with categories, multi-currency + exchange rate, methods, references, attachments, approval/reject/void, payment vouchers and receipts (PDF), petty cash, client invoices/certificates with retention and balances, cash flow, P&L by project, cost breakdown |
| Documents | Upload (drag & drop, multi-file), categories, project filter, search, access levels, version history, download via short-lived signed URLs |
| Tasks & scheduling | Tasks & milestones, assignment, priority, deadlines, progress, overdue detection, list and calendar views, quick status, notifications |
| Reports & analytics | 12 reports (progress, cost, budget variance, BOQ, inventory, procurement, workforce, attendance, equipment, cash flow, financial ledger, profitability); every table exports PDF/Excel/CSV |
| Notifications | In-app, realtime bell, approvals, assignments, low stock, report submission/decision, overdue reminders; company-level switches |
| Users | Invite, role assignment, activate/deactivate, password reset, project access, editable permission matrix, last-active tracking |
| Settings | Company profile & logo, currencies, taxes, units, document numbering, financial year, notification settings, audit log viewer, backup guidance |
| Platform | Responsive layout (sidebar/desktop, drawer + bottom quick actions/mobile), dark/light mode, global search (Ctrl K), loading/empty/error/success states, installable PWA with update prompt, Electron shell |

### Pending / recommended next steps

1. **Deploy**: create the production Supabase project, push migrations, deploy the Edge Function, host the frontend (§2, §5). No live URL exists yet. It needs your Supabase and hosting accounts.
2. **Staging acceptance test** in a browser and on Android/iOS phones: full workflows per role, offline report → reconnect → sync, photo upload, PDF/Excel exports, invitation & password-reset emails.
3. **Error monitoring**: add Sentry (or similar) to the frontend and Edge Function. Currently errors are shown to users and logged to the console only.
4. **Email/SMS notifications**: notifications are in-app only.
5. **Payroll statutory calculations** (PAYE, NSSF, SDL, WCF): deductions are entered manually today.
6. **Offline scope**: offline *editing* covers daily site reports; other screens show previously loaded data while offline but need a connection to save. Sync runs while the app is open (on reconnect, focus and every 2 minutes), not in the background when the app is closed.
7. Gantt/timeline view for schedules; Swahili translation; end-to-end browser tests (Playwright); automatic FX rates; deleting a document doesn't yet remove its stored files.

## 10. Go-live checklist

- [ ] Production Supabase project created, `npm run db:push` done, **seed.sql not loaded**
- [ ] `admin-users` deployed; Site URL & redirect URLs set; custom SMTP configured
- [ ] First Super Administrator created; public sign-up disabled
- [ ] Company settings, numbering, taxes and units reviewed
- [ ] Users invited with correct roles and project access
- [ ] PITR enabled; first `db:backup` stored off-site
- [ ] Staging acceptance test passed on desktop and phones

## Project structure

```
src/
  components/   ui kit, DataTable, config-driven CRUD (ResourcePage/ResourceForm), charts, layout
  lib/          supabase client, hooks, export (PDF/Excel/CSV), offline sync, calculations, permissions
  pages/        one folder per module
  providers/    auth/session/permissions/settings
supabase/       migrations, seed (demo), edge function
tests/db/       PGlite integration tests
electron/       optional desktop shell
```

# ABCkit AI Intelligence: server setup

This guide covers the Cloud Functions half of ABCkit AI Intelligence: the chat and report proxy, email accounts, sync, analysis, replies and monitoring. It lists every credential the functions need and how to deploy them.

Firebase project: `abckt-6b791`. Region: `us-central1`, or the value of the `FUNCTIONS_REGION` env var at deploy time.

## 0. Requirements

- **Blaze (pay-as-you-go) plan.** Cloud Functions v2, Secret Manager, Cloud Scheduler and outbound network calls to Anthropic, Google and Microsoft all need it. In the Firebase console, open *Usage and billing*, then *Modify plan*.
- Firebase CLI 13 or later, signed in: `firebase login`.
- Node 22 (the functions runtime is `nodejs22`).

## 1. Secrets

> **Easier for the AI keys: the admin page.** A user with `ai.manage` can add, replace, test and remove the OpenAI, Google Gemini and Anthropic keys in *AI → Settings (AI Control Center) → AI API keys*, without a redeploy. The `aiManageKeys` function tests each key with the provider (a read-only "list models" call) before saving it. It then encrypts the key with AES-256-GCM using `EMAIL_TOKEN_KEY` (section 1.2, which must be set first) and stores it in `ai_provider_keys`. No client can read that collection; `firestore.rules` deny every read and write. The page only ever shows the key's last 4 characters. A key saved there **takes precedence** over the Secret Manager secret, and removing it falls back to the secret. Every change is recorded in the AI audit log, without the key. The secrets below still have to exist for `firebase deploy`; set the AI ones to `unset` if you manage them from the admin page.

Each function declares the secrets it reads. **`firebase deploy` fails if any declared secret does not exist**, so create all eight. For a provider you do not use, set the value to `unset`. The server treats an empty value or `unset` as "not configured", shows the provider as unavailable in `ai_status/status`, and returns a clear error if someone tries to use it.

```bash
firebase functions:secrets:set OPENAI_API_KEY         # sk-...      (chat assistant: primary; live voice)
firebase functions:secrets:set GEMINI_API_KEY         # AIza...     (chat + live voice: fallback) or: unset
firebase functions:secrets:set ANTHROPIC_API_KEY      # sk-ant-...  (reports, email analysis/replies; optional chat) or: unset
firebase functions:secrets:set EMAIL_TOKEN_KEY        # 32 random bytes, base64 (see 1.2)
firebase functions:secrets:set GOOGLE_CLIENT_ID       # or: unset
firebase functions:secrets:set GOOGLE_CLIENT_SECRET   # or: unset
firebase functions:secrets:set MS_CLIENT_ID           # or: unset
firebase functions:secrets:set MS_CLIENT_SECRET       # or: unset
```

Each command prompts for the value. Changing a secret later takes effect at the next deploy, or right away for new instances when you redeploy with `firebase deploy --only functions`.

### 1.0 Which provider does what (phase 1)

| Feature | Provider |
|---|---|
| Chat assistant (AI page chat, floating "ABC AI" text) | Order set in *AI Control Center → Assistant providers*. Default: **OpenAI → Google Gemini → Anthropic Claude**. The first provider with a key answers; the next ones are used **only if it fails**, so company data is not sent to a second provider unnecessarily. A conversation stays on the provider that answered it. |
| Live voice ("ABC AI" phone button, "Hey ABC") | **OpenAI Realtime** over WebRTC first; **Google Gemini Live API** over WebSocket as the fallback (`voiceSession` callable). Gemini is used only when OpenAI has no key, refuses on the server, or the browser cannot connect to it — one call runs on one provider. Without either key the app falls back to the browser's speech recognition + the chat assistant. |
| Reports, email analysis, reply drafts, monitor | **Anthropic Claude** (moves to the provider layer in phase 2). |

Model names are parameters with defaults (override in `functions/.env.abckt-6b791`, or answer the prompt at deploy):

| Parameter | Default | Used for |
|---|---|---|
| `OPENAI_CHAT_MODEL` | `gpt-5.5` | chat assistant (Responses API) |
| `OPENAI_REALTIME_MODEL` | `gpt-realtime` | live voice |
| `OPENAI_REALTIME_VOICE` | `marin` | live voice (e.g. `marin`, `cedar`, `alloy`) |
| `GEMINI_MODEL` | `gemini-3.5-flash` | chat fallback |
| `GEMINI_LIVE_MODEL` | `gemini-3.8-live` | live voice fallback (Gemini Live API) |
| `GEMINI_LIVE_VOICE` | `Kore` | live voice fallback (prebuilt Gemini voice) |

### 1.0a OPENAI_API_KEY

1. https://platform.openai.com → *API keys* → *Create new secret key* (a project key for ABCkit is best). Add billing and set a monthly budget / usage limit for the project.
2. The key must have access to the Responses API (chat) and the Realtime API (voice). The browser never sees this key: `voiceSession` creates a **client secret valid for 2 minutes** (the browser uses it once to open the WebRTC call), with the ABCkit instructions and tools configured on the server.
3. Live voice sends microphone audio to OpenAI during a call only (not for the wake word — "Hey ABC" is recognised offline in the browser).

### 1.0b GEMINI_API_KEY

1. https://aistudio.google.com → *Get API key* (or a Google Cloud project with the Gemini API enabled). Set a budget in Google Cloud billing.
2. Gemini is only called when OpenAI fails (or if you put it first in the provider order).
3. Live voice fallback: `voiceSession` calls `POST https://generativelanguage.googleapis.com/v1beta/auth_tokens` with the key and gets a **single-use ephemeral token** (must be used within 2 minutes, dead after 30). The Live setup — model, ABCkit instructions, voice, tool definitions — is **locked inside the token**, so the browser cannot change it. The browser opens `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=…` (retries once on `v1alpha` if refused), streams the microphone as 16 kHz PCM and plays the 24 kHz answer. Tools still run in the browser under the user's permissions.
4. Gemini Live limits to know: a connection lasts about 10 minutes (the app says so and you start a new call); the page you open during a call is not forwarded (the call keeps the page it started on, the tools still read live data); while the assistant speaks the microphone is paused to avoid echo — use the **Interrupt** button to cut it off.

### 1.1 ANTHROPIC_API_KEY

1. Go to https://console.anthropic.com, open *Settings*, then *API keys*, then *Create key*. Use a dedicated workspace for ABCkit if you want separate spend limits.
2. Add credit or billing under *Plans & billing*, and set a monthly spend limit for the workspace.
3. The functions use the model `claude-opus-5-5` (single constant `MODEL` in `src/ai/claude.ts`). They send the beta header `server-side-fallback-2026-07-01` with `fallbacks: "default"`, so a request the model declines on policy grounds is retried server-side on Anthropic's recommended fallback model. If your organisation has not been granted that beta, requests fail with a 400 that names the header. In that case remove `FALLBACK_PARAMS` from `src/ai/claude.ts`.

### 1.2 EMAIL_TOKEN_KEY

This key encrypts the stored OAuth refresh tokens and IMAP app passwords (AES-256-GCM) in `email_account_secrets`. Generate 32 random bytes as base64:

```bash
openssl rand -base64 32
# or
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Keep a copy somewhere safe, such as a password manager. **If you change or lose this key, every connected mailbox has to be reconnected**, because the stored credentials can no longer be decrypted.

### 1.3 Redirect URI (needed for Gmail and Microsoft)

The OAuth callback is the HTTP function `emailOAuthCallback`. Register **exactly** this URL with Google and Microsoft:

```
https://us-central1-abckt-6b791.cloudfunctions.net/emailOAuthCallback
```

- If you deploy to another region, replace `us-central1`.
- To use another URL, such as the function's `run.app` URL or a Hosting rewrite, set the param `OAUTH_REDIRECT_URI` (for example in `functions/.env.abckt-6b791`: `OAUTH_REDIRECT_URI=https://…`) and register that URL instead.
- Local emulator: `http://127.0.0.1:5001/abckt-6b791/us-central1/emailOAuthCallback`. Add it as a second redirect URI if you test locally.

### 1.4 Gmail: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET

1. Go to https://console.cloud.google.com and select the project `abckt-6b791`. That is the Firebase project; any project works.
2. **Enable the Gmail API**: *APIs & Services*, then *Library*, search "Gmail API", then *Enable*.
3. **OAuth consent screen** (*APIs & Services*, then *OAuth consent screen*, or *Google Auth Platform*):
   - User type: **Internal** if all mailboxes are in your own Google Workspace domain. This needs no Google verification and is the recommended option. Otherwise choose **External**.
   - App name "ABCkit", support email, and authorised domain `abckt-6b791.web.app` (and `cloudfunctions.net` if asked).
   - Scopes: `openid`, `email`, `https://www.googleapis.com/auth/gmail.readonly`, `https://www.googleapis.com/auth/gmail.send`.
   - For **External** apps: while the app is in *Testing*, add each mailbox as a *Test user*. Refresh tokens of Testing apps **expire after 7 days**, so mailboxes must be reconnected weekly until you publish the app. Gmail scopes are "restricted", so publishing an External app needs Google's verification, which can include a security assessment. Internal Workspace apps avoid all of this.
4. **Credentials**: *Credentials*, then *Create credentials*, then *OAuth client ID*, then *Web application*.
   - Authorised redirect URI: the URL from 1.3.
   - Copy the client ID and secret into the two secrets.
5. The server requests offline access with `prompt=consent`, so Google always returns a refresh token. If a user connected earlier and gets "did not grant offline access", remove ABCkit at https://myaccount.google.com/permissions and connect again.

### 1.5 Outlook / Microsoft 365: MS_CLIENT_ID and MS_CLIENT_SECRET

1. Go to https://portal.azure.com, then *Microsoft Entra ID*, then *App registrations*, then *New registration*.
   - Name "ABCkit".
   - Supported account types: **"Accounts in any organizational directory and personal Microsoft accounts"**. The server uses the `common` endpoint, which supports both work and outlook.com accounts.
   - Redirect URI: platform **Web**, with the URL from 1.3.
2. *Certificates & secrets*, then *New client secret*. Copy the **Value** (not the Secret ID) into `MS_CLIENT_SECRET`. Note the expiry date and create a new secret before it expires.
3. *Overview*: copy the **Application (client) ID** into `MS_CLIENT_ID`.
4. *API permissions*, then *Add a permission*, then *Microsoft Graph*, then **Delegated**: `offline_access`, `openid`, `email`, `User.Read`, `Mail.Read`, `Mail.Send`. In a Microsoft 365 tenant, an admin can click *Grant admin consent* so users are not prompted.
5. Some tenants block user consent to third-party apps. If users get "Need admin approval", a tenant admin must grant consent once.

### 1.6 Other mailboxes over IMAP/SMTP (app password)

No server secret is needed beyond `EMAIL_TOKEN_KEY`. In ABCkit, go to *AI*, then *Settings*, then *Connect IMAP*, and enter the IMAP and SMTP host, port, TLS setting, username and an **app password**. The server logs in to both IMAP and SMTP before it saves anything.

- **Gmail over IMAP** (instead of OAuth): turn on 2-Step Verification, then create an app password at https://myaccount.google.com/apppasswords. Use `imap.gmail.com:993` with TLS and `smtp.gmail.com:465` with TLS.
- **Outlook.com / Microsoft 365**: Microsoft has turned off basic-auth IMAP/SMTP for most tenants. Use the Microsoft OAuth option (1.5) instead.
- **cPanel or hosting mailboxes**, such as `mail.yourdomain.co.tz`: usually IMAP 993 with TLS and SMTP 465 with TLS (or 587 with STARTTLS, `secure: false`), using the mailbox password or an app password.
- Mail sent over SMTP is not copied into the mailbox's Sent folder by every server. Gmail does this automatically; many cPanel servers do not.

#### ARICOM company mailbox: info@aricom.tz

`aricom.tz` mail is **not** on Google Workspace: MX is `mail.aricom.tz` (102.211.186.77) with `g.sivecloud.co.za` (Sive Cloud), so Google OAuth / the Gmail API cannot reach it. Connect it over IMAP/SMTP. The *IMAP / SMTP* dialog has a **Use ARICOM settings** button that fills in:

| Setting | Value |
|---|---|
| Address / username | `info@aricom.tz` |
| IMAP | `mail.aricom.tz`, port 993, TLS |
| SMTP | `mail.aricom.tz`, port 465, TLS |

The certificate on `mail.aricom.tz` (Let's Encrypt) covers `mail.`, `smtp.` and `pop.aricom.tz`. Only the password is typed by the administrator. It goes to `emailConnectImap` over HTTPS once, the server logs in to IMAP and SMTP before saving, and stores it AES-256-GCM-encrypted in `email_account_secrets` (no client can read that collection). Prefer a dedicated mailbox password for ABCkit if the host's control panel allows it, and change it if ABCkit is ever retired. If `aricom.tz` later moves to Google Workspace, disconnect the IMAP account and connect with Gmail OAuth (1.4) — that removes the stored password.

### 1.7 Allowed app origins (APP_ORIGINS)

The OAuth flow returns users only to these origins. The default is `https://abckt-6b791.web.app,https://abckt-6b791.firebaseapp.com,http://localhost:5173,http://127.0.0.1:5173`. To change it, add this line to `functions/.env.abckt-6b791` (a plain param, not a secret):

```
APP_ORIGINS=https://abckt-6b791.web.app,https://erp.example.co.tz
```

On the first deploy the Firebase CLI may ask for `APP_ORIGINS` and `OAUTH_REDIRECT_URI`. Press Enter to accept the defaults: `unset` for `OAUTH_REDIRECT_URI` means "use the URL in 1.3". The CLI saves your answers in `functions/.env.abckt-6b791`.

## 2. Permissions in ABCkit

Assign these permission keys to roles in the ABCkit role editor. `super_admin` holds all of them.

| Permission | Lets the user |
|---|---|
| `ai.view` | Use the dashboard, alerts, reports and chat (`aiComplete`, `aiRunMonitor`), and receive alert notifications |
| `ai.email` | Read email intelligence, re-analyse email (`emailAnalyze`), draft replies (`emailGenerateReply`) and sync now (`emailSyncNow`) |
| `ai.email_send` | Approve and send a reply draft (`emailSendDraft`). This is the only path that sends email |
| `ai.manage` | Connect and disconnect mailboxes, toggle sync (`emailConnectStart`, `emailConnectImap`, `emailDisconnect`, `emailSetSync`), sync now, and open the Control Center |

**Per-user access (User Management → Email access).** An administrator with `users.manage` can also give **one user** `ai.email`, `ai.email_send` or `ai.manage` without changing their role. Each tick calls `adminUsers` (`action: 'set_access'`), which writes `user_access/{uid}` and an `audit_logs` entry with the before and after state. Approve & send implies email access, and every grant includes `ai.view`. Only these AI keys can be granted this way; everything else stays role-based. Nobody can change their own access, and a Super Administrator needs no grant. `firestore.rules` (`aiPerm` in `50_ai.rules`), every AI function (`requireCaller`) and the app (`loadMe`) all honour the grant immediately. No client can write `user_access`, and deactivating a user removes the grant's effect at once.

### 2.1 Assistant command tools

The chat and voice assistant can only act through the tool registry in `src/lib/ai/tools.ts`. It has no SQL or free-form database access. Tools run in the browser under the signed-in user's own Firestore rules, re-check the role's permission first, and validate their arguments against a JSON schema.

| Tool | Needs | What it does |
|---|---|---|
| `get_projects` | `projects.view` | Visible projects with progress vs. time elapsed |
| `get_project_details` | `projects.view` | One project: schedule, budget\*, tasks, approvals, site issues, emails\* |
| `get_project_progress` | `projects.view` | Progress %, slip, days left, task completion\*, latest site report\* |
| `get_financial_summary` | `finance.view` | Receivables, payables, budgets |
| `get_pending_approvals` | any | Items waiting for a decision that the user can see |
| `get_inventory` | `inventory.view` and related | Stock levels |
| `get_employee_directory` | `hr.view` | Staff directory |
| `get_attendance_summary` | `hr.view` | Attendance for a period |
| `search_emails` / `summarize_email` | `ai.email` | Email search and a stored summary (email text is wrapped as untrusted) |
| `draft_email` | `ai.email` | Creates a reply **draft** only. It is never sent; a person with `ai.email_send` presses *Approve & Send* |
| `open_dashboard` | menu permission | Opens a dashboard the role may open |
| `generate_project_report` | `projects.view` | Project report |

\* Only included when the role can read that data.

The old names `list_projects`, `list_pending_approvals` and `prepare_email_reply` still run, so saved conversations keep working.

### 2.2 Sensitive actions

Sending email, approving or making payments, deleting records, issuing purchase orders and changing financial records are **sensitive**. The assistant has no tool for any of them today. The registry also refuses to load one (`assertToolPolicy`) unless it is a confirmed action tool that declares its category and describes what the user approves. `executeTool` then asks the user **before** the tool runs.

Every confirmation, whether a button or a spoken "ndiyo / yes", gets its own id (`act_…`). Only an answer to that pending question counts. During a live call, only speech that starts after the question is taken as the answer. A hedged reply ("yes, but…", "subiri", "labda") is not taken as approval. The id and the answer are written to `ai_activity` together with the outcome (`done` / `declined` / `not done`).

## 3. Deploy

```bash
npm --prefix functions install
npm --prefix functions run build          # prebuild copies src/shared/ai into functions/src/shared/ai
firebase deploy --only functions          # or: npm run deploy:functions
```

The first deploy also creates two Cloud Scheduler jobs: `emailSyncScheduled` (every 10 minutes) and `aiMonitorScheduled` (every 30 minutes), both in the Africa/Dar_es_Salaam time zone. The functions write `ai_status/status`, which shows what is configured, along with the last sync and monitor results.

Tests (no network or credentials needed): run `node node_modules/vitest/vitest.mjs run --config functions/vitest.config.ts` from the repo root.

## 4. How it behaves

- **Chat and reports** (`aiComplete`): the server owns the system prompt, and the app runs the data tools under the user's own Firestore permissions. Each call is one model turn with adaptive thinking at `effort: medium`, using the cached system prompt. It is capped at `ai_settings.daily_chat_limit_per_user` model calls per user per day (default 200). The day resets at midnight EAT.
- **Sync**: the first sync fetches the last 14 days of INBOX and Sent mail. Later syncs fetch only new mail, up to 150 inbox and 50 sent messages per account per run (a backlog continues on the next run). Bodies are stored as plain text up to 50,000 characters.
- **Analysis**: only new **inbox** email is analysed, with structured output at `effort: low`, plus up to 3 PDF or text attachments of 4 MB or less. Sent mail is stored as conversation context only (`status: 'skipped'`). Each run analyses with 3 workers until about 7 minutes have passed, and the next run picks up anything left. If `ai_settings.enabled` is false or no API key is set, email is still synced but stays `status: 'new'`.
- **Alerts**: `computeAlerts` (in `src/shared/ai/monitor.ts`) runs every 30 minutes and after each sync that analysed something. The functions create notifications only for **new** high or urgent alerts whose type is switched on in `ai_settings.notify`. Each user gets at most 10 per run, plus a summary line.
- **Sending**: email is sent only when a user with `ai.email_send` approves a draft (`emailSendDraft`). Demo drafts and demo accounts are never sent.

## 5. Costs and limits (rough guide)

- Claude Opus 5.5 costs $4 per million input tokens, $20 per million output tokens, and $0.20 per million cached input tokens. ABCkit records every call in `ai_usage` with an estimated cost.
  - Email analysis: about 2,000 to 6,000 input tokens (reference data is cached) and 300 to 1,500 output tokens per email, roughly **$0.01 to $0.05 per email**. PDF attachments cost more, about 1,500 to 3,000 tokens per page.
  - Chat turn: a few thousand to tens of thousands of input tokens, depending on tool results. Typically **$0.02 to $0.20 per question**. Reports cost more.
  - Reply draft: roughly **$0.02 to $0.08**.
- Firebase: Cloud Functions invocations and compute (the scheduled jobs run about 4,300 times a month, mostly as short no-ops), Cloud Scheduler (3 free jobs per billing account, then $0.10 per job per month), Secret Manager (a few cents a month) and Firestore reads and writes. The monitor reads the open-work collections every 30 minutes.
- Gmail API and Microsoft Graph have generous per-user quotas that this sync stays well within.

## 6. Troubleshooting

- `ai_status/status.ai_configured: false`: none of `OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` is set. `ai_status/status.ai_providers` shows each one (also in AI Control Center → Synchronisation & AI processing).
- Live voice button missing: the app shows it only when `ai_providers.openai` is true, the browser supports WebRTC, and *Live voice* is on in the AI Control Center. Otherwise the microphone uses browser voice.
- "The voice service refused the connection": the client secret expired (2 min) or the Realtime model name is wrong — check `OPENAI_REALTIME_MODEL`.
- No microphone on the deployed site: the hosting header `Permissions-Policy` must allow `microphone=(self)` (set in `firebase.json`).
- `providers.gmail` or `providers.microsoft` is false: the client ID or secret is missing or `unset`, or `EMAIL_TOKEN_KEY` is missing or invalid (it must decode to exactly 32 bytes).
- Account `status: 'error'` with "authorisation was revoked or expired": reconnect the mailbox. Causes include a Google Testing-mode token older than 7 days, a changed password, revoked access, or an expired Azure client secret.
- "redirect_uri_mismatch" (Google) or AADSTS50011 (Microsoft): the registered redirect URI does not exactly match 1.3.
- Logs: `firebase functions:log`, or Cloud Logging in the Google Cloud console.

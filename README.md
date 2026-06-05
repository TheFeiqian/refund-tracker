# Refund Tracker — hosted app (Supabase)

Your existing tracker, turned into a real multi-user web app:

- **Postgres** holds the orders and store registry (shared across your team).
- **Supabase Storage** holds the PDF/label files (no size hacks — real file storage).
- **Auth** gives everyone a real login; all 19 of you share one live dataset.
- **Edge Functions** are where the automations run (receipt parsing, delivery-photo checks, SLA reminders).

The UI and all the logic (method engine, BBM collection workflow, evidence→stage triggers, etc.) are unchanged — only the storage layer was swapped from your browser to Supabase.

```
app/
  web/index.html         the app (deploy this)            ← front end
  web/app-config.js      your Supabase URL + anon key      ← you fill in
  supabase/migrations/0001_init.sql   tables + security
  supabase/functions/    parse-receipt / analyze-photo / sla-reminders
  scripts/import-demo-data.mjs        one-time data seed
  data/                  orders.json + stores.json (the seed)
```

---

## One-time setup (about 20 minutes)

### 1. Create the project
Go to supabase.com → **New project**. Note the project URL and, under **Project Settings → API**, the **anon public** key and the **service_role** key.

### 2. Create the database
Open **SQL Editor**, paste the whole of `supabase/migrations/0001_init.sql`, and run it. That creates the tables, the security policies (logged-in users share one workspace), and an audit log.

### 3. Create the file bucket
**Storage → New bucket** → name it exactly `labels`, keep it **Private**. (The SQL in step 2 already added the access policies for it.)

### 4. Turn on logins
**Authentication → Providers → Email**: enable it. For a quick internal pilot, **Authentication → Sign In / Providers → email**: turn **Confirm email OFF** so your team can sign up and use it immediately. (Leave it on later, or pre-invite users under **Authentication → Users → Add user**.)

**Admin vs member roles.** Everyone signs up as a `member` by default — they see a focused view: My Tasks, their Orders, and Delivery. To make yourself (or anyone) an **admin** — who sees all eight tabs, store setup, the info-priority queue, the blocking matrix, analytics, and can delete orders — run this once in the SQL editor after they've signed up:
```sql
update public.profiles set role = 'admin' where email = 'you@teloshouse.com';
```
Members can't switch themselves to admin; the view is set from their profile at login.

### 5. Load your data
On your machine:
```bash
cd app
npm i @supabase/supabase-js
SUPABASE_URL="https://YOUR-PROJECT.supabase.co" \
SUPABASE_SERVICE_ROLE_KEY="YOUR-SERVICE-ROLE-KEY" \
node scripts/import-demo-data.mjs
```
This loads all 67 orders and 56 stores, and lifts any embedded file (e.g. the DoorJammerUK confirmation) into the `labels` bucket. The service_role key bypasses security — only use it locally, never put it in the browser.

### 6. Point the app at your project
Edit `app/web/app-config.js`:
```js
window.APP_CONFIG = {
  url: "https://YOUR-PROJECT.supabase.co",
  anonKey: "YOUR-PUBLIC-ANON-KEY"   // the anon public key, safe for the browser
};
```

### 7. Put it online with GitHub + Vercel (your own URL)

This gives you automatic redeploys: every time you push a change to GitHub, Vercel rebuilds the live site.

**a. Push the project to GitHub.** From the unzipped folder:
```bash
git init
git add .
git commit -m "Refund Tracker"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/refund-tracker.git
git push -u origin main
```
(Create the empty `refund-tracker` repo on github.com first. It can be private.)

Note: committing `web/app-config.js` is fine — it only holds the project URL and the **anon public key**, which are designed to be visible in the browser. Nothing secret is in the repo (the service_role key lives only in your terminal's env vars during seeding, and `.gitignore` keeps `.env` out).

**b. Import the repo into Vercel.** Go to vercel.com → **Add New → Project** → import your GitHub repo. In the configure screen:
- **Framework Preset:** Other
- **Root Directory:** click **Edit** and set it to `web`  ← this is the one setting that matters
- Build Command: leave empty · Output Directory: leave empty (it's static)

Click **Deploy**. In under a minute you'll have a live `your-project.vercel.app` URL.

**c. Add your custom domain.** Vercel → your project → **Settings → Domains** → add `tracker.teloshouse.com` (or whatever you want) and follow the DNS instructions (usually one CNAME record at your registrar).

**d. Tell Supabase about the URLs.** In Supabase → **Authentication → URL Configuration**, add **both** your `*.vercel.app` URL and your custom domain to **Site URL** and **Redirect URLs**. Skipping this is the #1 cause of "login does nothing" — don't.

From now on, `git push` redeploys automatically. Your team visits the URL, signs in, and shares one live dataset; uploaded labels go straight to Storage.

---

## Automations (the Edge Functions)

Install the CLI once (`npm i -g supabase`), then `supabase login` and `supabase link --project-ref YOUR-REF`.

```bash
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...     # for the two AI functions
supabase functions deploy parse-receipt
supabase functions deploy analyze-photo
supabase functions deploy sla-reminders
```

What they do:
- **parse-receipt** — when someone attaches a proof-of-postage receipt or return label, the app sends it here and gets back `{tracking_number, courier, postage_date, posted_from}`, which auto-fills those fields. **Wired:** the app calls this automatically on upload.
- **analyze-photo** — handles two checks via a `kind` flag. `kind:"delivery"` returns `{shows_person}` to drive the DNA branch; `kind:"damage"` returns `{damage_visible, note}` to confirm a damage photo before the return label goes out. **Wired:** the app calls this automatically when a delivery or damage photo is uploaded.
- **sla-reminders** — sweeps all orders, flags ones overdue for their stage into `audit_log`, and writes a row into the `notifications` table for each (de-duped to one per order/stage per day). If you set a Slack webhook it also posts a digest. Schedule it under **Database → Cron**, e.g. daily at 08:00:
  ```sql
  select cron.schedule('sla-daily','0 8 * * *', $$
    select net.http_post(
      url := 'https://YOUR-PROJECT.functions.supabase.co/sla-reminders',
      headers := '{"Authorization":"Bearer YOUR-ANON-KEY"}'::jsonb) $$);
  ```
  Optional Slack digest:
  ```bash
  supabase secrets set SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
  ```

The schema (step 2) also creates two supporting tables automatically: `app_state` (stores the shared weekly burndown history) and `notifications` (the SLA function's output, which the app can surface).

---

## What's done vs. next

**Done and working now:** logins, shared Postgres data, PDF/label files in real Storage with signed URLs, the full UI/logic (all eight tabs, the method flowcharts, the info-priority queue with the 45-field blocking matrix, the Delivery tab, the working task forms, the audit trail, per-field timestamps, stage 8), and all three automation functions **wired into the app**:
- Uploading a proof-of-postage receipt auto-fills tracking/courier/date via `parse-receipt`.
- Uploading a delivery photo runs `analyze-photo` (person detection → DNA); uploading a damage photo runs the damage check before the return label.
- The evidence→stage-advance automation runs in-app; the form round-trip writes submissions straight back to the order.
- `sla-reminders` writes overdue notifications (and Slack if configured).
- Weekly burndown snapshots persist to `app_state`, shared across the team.

**Next (optional polish):**
- Real email sending in `sla-reminders` (Slack digest is wired; email needs a provider key e.g. Resend — a few lines in the function).
- Generate an external Google/Typeform link for the "Send as form" flow if you ever want to send tasks to people who don't log in (today everyone on the team logs in and the in-app form does the round-trip).
- If you want spreadsheet-style SQL reporting, normalise the most-queried fields (price, stage, store) out of the single JSON column into real columns.

## Notes
- **Security model:** every signed-in user sees the whole dataset (right for one trusted team). To separate external clients later, swap the three "shared workspace" policies in the SQL for per-owner ones — the structure's already there.
- **Costs:** Supabase free tier (500 MB DB, 1 GB storage, 50k monthly active users) covers this pilot comfortably. The two AI functions use your Anthropic API key per call.
- Keep the **service_role** key out of the browser and out of the deployed site — it's only for the local import script.

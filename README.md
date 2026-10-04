# Home Game Tracker

A single-page tracker for home poker tournaments: players, buy-ins, sessions, chip checks, standings and payouts.

- Open `index.html` directly to use it offline (data stays in that browser, optionally auto-saved to a file).
- Hosted on GitHub Pages with shared data in Supabase: anyone with the link can view; sign-in via Supabase Auth: the admin edits everything, players edit their own profile.
  Database setup: put your admin email in `.env` (see `.env.example`), run `npm run setup-sql`,
  and paste the generated `supabase-setup.local.sql` into the Supabase SQL Editor.

## Online poker (test feature)

`play.html` is an online no-limit hold'em table for the group. The server deals; every hand can be
verified afterwards. See [FAIRNESS.md](FAIRNESS.md) for how the shuffle works and how to check it.

## Running everything locally

The same code runs against a local Supabase (in Docker) or production. `config.js` picks the local
one whenever the page is opened from `localhost`/`127.0.0.1`, so only the data differs.

    npm install          # once
    npm run dev          # local Supabase + the game server function + the site on http://127.0.0.1:3000
    npm run seed         # once: test accounts + a sample tournament (logins in supabase/local-users.json)

    npm test             # rules and shuffle tests
    npm run sim          # plays full sessions against the local server and checks them
    npm run bots -- <table id> 3    # seat 3 test players at a table so you can play against them
    npm run db:reset     # wipe the local database (then run seed again)
    npm run db:stop      # stop the Docker containers

Database changes live in `supabase/migrations/` and are safe to commit: nothing personal is in them.
Your admin email lives only in `.env` (git-ignored). `npm run setup-sql` combines the migrations and
that email into `supabase-setup.local.sql` (also git-ignored) for the Supabase SQL Editor; it is safe
to run again after adding a migration. The server function is deployed with
`npx supabase functions deploy game`.

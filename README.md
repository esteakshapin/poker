# Home Game Tracker

A single-page tracker for home poker tournaments: players, buy-ins, sessions, chip checks, standings and payouts.

- Open `index.html` directly to use it offline (data stays in that browser, optionally auto-saved to a file).
- Hosted on GitHub Pages with shared data in Supabase: anyone with the link can view; sign-in via Supabase Auth: the admin edits everything, players edit their own profile.
  One-time database setup is in `supabase-setup.sql`.

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

Database changes live in `supabase/migrations/`. Production gets them by running the new migration
file in the Supabase SQL Editor (and `supabase functions deploy game` for the server function).

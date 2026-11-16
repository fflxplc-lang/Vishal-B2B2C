# Merged BOSS — what came from where

Built from three copies that split from the same commit (Development `c4a8655`, 6 Nov 2026):

| Source | What it brings |
|---|---|
| **FreedomLifex_BOSS** | Partner Journey (PPS, Onboarding, PMS, PQS, payouts, targets, levels), Payout system (`payout/`, MF brokerage imports, ledger, reports), empanelment & partner forms, team-wipe guard, read retries, account relink, Freedom LifeX logo |
| **FINOWISE_BOSS** | Client-wise import, client merge, import comparison, patch-based saves (only changed fields are sent), password reset links + `/set-password` page, delete-request page, insurance policy store, Finowise deploy scripts (`deploy/boss-finowise`) |
| **Finowise_BOSS_Development** | RIA AI assistant (B2C mode), insurance journey re-order + Life/Health/General modules, client form links working for signed-out clients |

## Where both forks had built the same thing
- **Passwords**: Finowise server flow (reset links, `/set-password` before the app opens) plus the FreedomLifex change-password form and status labels. Both `/api/me/password` and `/api/account/password` work.
- **Delete approval**: new requests use the FreedomLifex mechanism (covers records, goals, documents, sub-tasks, manual holdings); the Delete Requests page lists and decides both kinds.
- **Saving**: Finowise patch saves + FreedomLifex retries, failed-load screen and team guard.
- **Portfolio hand edits**: both kept — scheme-level "+ Add investment" and platform-level "+ Add / Update Investment".
- **Branding**: Freedom LifeX logo is the default; any logo uploaded in Setup still overrides it.

## Install
    npm ci
    node server.js        # http://localhost:3000

The payout module needs `multer`, `pdf-parse` and `xlsx` (already in package.json). Browser tests: `cd tests && npm ci && bash parallel.sh` (204 suites).

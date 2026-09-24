# User access design

## Requirements and assumptions

- The existing `is_admin=true` account is the sole **Foundator** (stored as `founder`).
- Only Foundator can create users, set their passwords, or change their role and active status from the web app.
- Team roles are **Editor** (read and change stock, see history) and **Viewer** (read internal stock details and movement history, including customer and document fields, without changing data).
- Foundator cannot be changed or disabled through the web app. A project owner can recover access in the Supabase dashboard if needed.
- Self-signup stays disabled. Foundator enters each member's email and initial password in the web app and conveys the password to the member separately.

## Components and data flow

```text
GitHub Pages app ── publishable key + user JWT ──► Supabase Auth
       │                                  │
       ├── stock reads/writes ───────────► PostgREST + RLS ──► items, movements
       │
       └── list/create/update users ─────► manage-users Edge Function
                                            │  verify JWT and active founder row
                                            ├── Auth admin create/update API
                                            └── staff table (service role)
```

The service-role key is injected into the Edge Function by Supabase. It never appears in GitHub Pages or the public repository.
The `service_role` database role needs explicit `SELECT`, `INSERT`, and `UPDATE` grants on `staff`. Browser roles have only `SELECT` on that table, further limited by RLS.

## Access matrix

| Action | Visitor | Viewer | Editor | Foundator |
|---|---:|---:|---:|---:|
| View product list and balances | ✓ | ✓ | ✓ | ✓ |
| View movement history and private stock fields | | ✓ | ✓ | ✓ |
| Export stock and movement history | | ✓ | ✓ | ✓ |
| Record movements and edit products | | | ✓ | ✓ |
| Create users, set passwords or change rights | | | | ✓ |
| Change Foundator rights through the web | | | | |

The `staff.role` column is authoritative. `is_reader()` returns true for active `founder`, `editor`, or `viewer` rows and gates internal reads. `is_staff()` returns true only for active `founder` or `editor` rows and gates writes. `my_role()` returns only the caller's active role for the UI. Direct writes to `staff` are not granted to browser users.

## API contract

`POST /functions/v1/manage-users` requires a Supabase Auth user JWT. Every request verifies the token against Supabase Auth and rechecks the caller's active `founder` row. The Edge Function accepts:

In function settings, **Verify JWT with legacy secret** is off so JWTs using current Supabase signing keys reach the function. A missing or invalid user token still returns 401 from the function.

- `{ "action": "list" }` → team accounts.
- `{ "action": "create", "email": "...", "name": "...", "role": "editor|viewer", "password": "..." }` → creates a confirmed Auth user and a `staff` row without email.
- `{ "action": "set_password", "user_id": "...", "password": "..." }` → sets a password for a non-Founder team member, including a pending invitation account, without email.
- `{ "action": "update", "user_id": "...", "role": "editor|viewer", "is_active": true|false }` → changes a non-Founder account.

The function rejects requests to create a second Founder or modify the existing Founder. Deactivation preserves the Auth user and stock audit references; RLS denies future editor access immediately.

## Reliability and tradeoffs

Auth user creation and the `staff` insert are separate operations. If Auth creation succeeds but the insert fails, the function returns an error for database repair; the account cannot access private stock without a `staff` row. Passwords are sent over HTTPS to Supabase Auth, are stored there as hashes, and are never returned by the Edge Function or written to the repository. Foundator should deliver initial passwords privately and tell members to change them after first login. If the team later needs separate permissions for receiving, dispatching, reporting, or multiple Founders, revisit the three-role model and add explicit permission records and an access-change audit log.

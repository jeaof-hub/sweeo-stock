# User access design

## Requirements and assumptions

- The existing `is_admin=true` account is the sole **Foundator** (stored as `founder`).
- Only Foundator can invite users or change a user's role and active status from the web app.
- Team roles are **Editor** (read and change stock, see history) and **Viewer** (see only the same stock balances as visitors).
- Foundator cannot be changed or disabled through the web app. A project owner can recover access in the Supabase dashboard if needed.
- Self-signup stays disabled. Invitations go to the email address entered by Foundator; recipients set their own passwords.

## Components and data flow

```text
GitHub Pages app ── publishable key + user JWT ──► Supabase Auth
       │                                  │
       ├── stock reads/writes ───────────► PostgREST + RLS ──► items, movements
       │
       └── list/invite/update users ─────► manage-users Edge Function
                                            │  verify JWT and active founder row
                                            ├── Auth admin invite API
                                            └── staff table (service role)
```

The service-role key is injected into the Edge Function by Supabase. It never appears in GitHub Pages or the public repository.
The `service_role` database role needs explicit `SELECT`, `INSERT`, and `UPDATE` grants on `staff`. Browser roles have only `SELECT` on that table, further limited by RLS.

## Access matrix

| Action | Visitor | Viewer | Editor | Foundator |
|---|---:|---:|---:|---:|
| View product list and balances | ✓ | ✓ | ✓ | ✓ |
| View movement history and private stock fields | | | ✓ | ✓ |
| Record movements and edit products | | | ✓ | ✓ |
| Invite users or change their rights | | | | ✓ |
| Change Foundator rights through the web | | | | |

The `staff.role` column is authoritative. `is_staff()` returns true only for active `founder` or `editor` rows, so existing stock RLS policies enforce the matrix. `my_role()` returns only the caller's active role for the UI. Direct writes to `staff` are not granted to browser users.

## API contract

`POST /functions/v1/manage-users` requires a Supabase Auth user JWT. Every request verifies the token against Supabase Auth and rechecks the caller's active `founder` row. The Edge Function accepts:

In function settings, **Verify JWT with legacy secret** is off so JWTs using current Supabase signing keys reach the function. A missing or invalid user token still returns 401 from the function.

- `{ "action": "list" }` → team accounts.
- `{ "action": "invite", "email": "...", "name": "...", "role": "editor|viewer" }` → sends an invitation and creates a `staff` row.
- `{ "action": "update", "user_id": "...", "role": "editor|viewer", "is_active": true|false }` → changes a non-Founder account.

The function rejects requests to create a second Founder or modify the existing Founder. Deactivation preserves the Auth user and stock audit references; RLS denies future editor access immediately.

## Reliability and tradeoffs

Auth invitation and the `staff` insert are separate operations. If the invite request succeeds but the insert fails, the function returns an error for database repair; the recipient cannot access private stock without a `staff` row. Supabase's default email service has delivery restrictions and no delivery guarantee, so configure custom SMTP for regular team use. An Auth `mail.send` event records an attempted send, not recipient delivery. Expired invite links require a fresh invitation for the same Auth user; the app shows an explicit expiry message. If the team later needs separate permissions for receiving, dispatching, reporting, or multiple Founders, revisit the three-role model and add explicit permission records and an access-change audit log.

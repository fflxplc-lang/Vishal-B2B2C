# Freedom LifeX — two platforms, one backend

| | Partner Platform | Company Platform |
|---|---|---|
| Address | `partner.freedomlifex.co.in` | `one.freedomlifex.co.in` |
| Who signs in | Partners (L1–L7) and the staff L5+ partners hire | Company employees |
| Sign-in page | "Partner Platform" | "Company Platform" |
| Data | The same store, cut to the partner's reach | The same store, cut to the employee's scope |

Both addresses are served by the same app (`server.js`) and the same store. A
record has one id and lives in one place. A change saved on one platform
reaches the other with the next live update, so there is no import and no
refresh. `boss.freedomlifex.co.in` still works as a combined address where
everybody can sign in.

Company admins and L7 Super Admins may sign in on both platforms. Anybody else
who signs in on the wrong one is told where to go.

## Where the rules live

| File | What it decides |
|---|---|
| `access.js` | Who is asking, which records they get, and which writes are allowed. Every `/api/storage` read, write and delete goes through it. |
| `public/partner-levels.js` | The L1–L7 ladder. Both the browser and the server load it, so the screen and the server apply the same rule. |
| `server.js` | Wires the above in. It also handles sign-in per platform, `/config.js` (`BOSS_PLATFORM`, `BOSS_ACCESS`), `/api/me/access`, the write log and team accounts. |
| `public/index.html` | Platform branding, the partner menu per level, L7 as super admin, **My Team** (L5+) and Setup › Partner Levels. |

The server does the enforcing; the page only reflects it. A partner who calls
the API directly gets the same slice the screen shows, and the same
refusals.

## L1–L7 (partners)

| Level | Data they get | Adds |
|---|---|---|
| L1 Ninja | Own data only | Client Journey, Communications, Blueprint, Forms, Insights. No company Ops support: PQS is view-only. |
| L2 Super Ninja | Own data only | Company Ops support: Operations, and raising PQS queries. |
| L3 Sherpa | Own + mapped partners | Visibility of every partner reporting to them, at any depth. Sales (Business). |
| L4 Master Sherpa | As L3 | Partner recruitment and onboarding (PPS, PMS, Onboarding). |
| L5 Monks | As L4 | Builds and manages their own team (**My Team**: RMs and Operations staff). |
| L6 Zen Monks | As L5 | The administrative controls ticked for L6 in Setup › Partner Levels, and no others. |
| L7 Super Admin | Everything | Complete system access, on both platforms. |

- **L1 and L2 never see other people's data.** This holds whatever Setup says; the server forces it.
- **Closed below L7:** company HR, employee records, company configuration, connectors, logs, imports and payout administration.
- **Colleagues outside a partner's reach:** the partner sees their name and nothing else (no email, permissions or HR).
- **L6 never becomes a company admin account,** even if given Manage Users. Its controls never widen whose records it sees.
- **Level changes apply at once.** Changing a partner's level or reporting line changes what the server allows on their next request, with no new sign-in.

**Staff of an L5+ partner** are team members carrying `partnerTeamOf`:

- An **RM** sees their own work.
- **Operations** staff work the partner's whole book.
- Both sign in on the Partner Platform.
- A partner cannot give staff company-wide scope, administrative controls or HR.
- Only the owning partner (or an admin) can make their sign-in accounts.

## Employees

Partner L1–L7 rules are **not** applied to employees. An employee's records
follow their own role and scope:

| Scope | Leads, clients and the records that hang off them |
|---|---|
| Admin role, or "Everyone" | Everything |
| Team | Themselves and everyone below them in the reporting line |
| Branch | Their branch |
| Own | Themselves |

On Team, Branch and Own scope, an employee also gets the records of every
partner they are the assigned RM of (PMS `assignedTo`). That is their support
responsibility. Company Ops staff are usually on "Everyone".

## How a record is "in reach"

A record is in reach when any of these is true:

1. Somebody in reach owns it: `assignedTo`, `rmName`, `assignTo`, `owner`, `createdBy`, `userId`, …
2. It is the business of a partner in reach (`partnerPobId`, …).
3. It is mapped to somebody in reach on the payout hierarchy (`mappedTo`).
4. It hangs off a record in reach: a task on a visible lead, a document of a visible client (`leadId`, `clientId`, `recordId`, …).

## Writes

The rules for anybody restricted (partners, their staff, scoped employees):

- **Records outside reach:** they cannot change, add over or remove them.
- **Hand-offs:** they cannot move a record out of their own reach, or give it to another partner.
- **Whole-list saves** are turned into a field-level patch against what that person was shown. Records they never saw cannot be wiped or overwritten.
- **Wholesale saves** (`X-CRM-Replace`, `X-CRM-Bulk`) are refused.
- **Partners' own team row:** they may change their contact details, but not their level, role, access or reporting line.
- **Concurrent saves:** two people saving the same record keep the existing per-field merge and conflict report. Records are never duplicated, because ids are shared.

## Activity log

The server appends one JSON line per save to `access-audit.log`, beside
`data.json`. Each line records:

- who saved, and as what (level, role or scope);
- which platform it came from;
- the store;
- the record ids created, changed and removed;
- every refused attempt, with its reason.

Admins read it at `GET /api/audit/writes?key=leads&id=…&by=…`. The CRM's own
audit trail (`auditLog`) keeps recording field-level changes as before.

## Deploying the two addresses

1. **DNS:** add `A` records for `partner` and `one` (on `freedomlifex.co.in`), pointing at the same server as `boss`.
2. **Server:** run `deploy/boss-finowise/setup.sh` again, as root.
   - nginx then answers on all three addresses.
   - It gets HTTPS certificates for every address that already points at the server.
   - It adds `CRM_PARTNER_HOSTS`, `CRM_COMPANY_HOSTS`, `CRM_PARTNER_URL` and `CRM_COMPANY_URL` to `app.env`.
   - Run it again after DNS changes to pick up a late address.
3. **Partner levels:** open Setup › Partner Levels once as an admin.
   - Partner levels saved before L7 existed are replaced by the new defaults.
   - Check them and press **Save & Apply to Partners**.

## Tests

`tests/suites/dual-platform.js` tests all of the above end to end against a running server:

- sign-in per platform;
- what L1, L2, L3, L5, L6 and L7 and employees are handed;
- every refused write, and the whole-list save;
- two-way sync between a partner and company Ops;
- L5 team building, a live level change and the write log;
- the partner's own screen in a browser.

## Skill Development Center (courses and videos)

`public/skill-center.js` is the page; `skill-center-server.js` is the server half.

**Who sees which course.** An admin or course manager sets an access rule on each course. They do it in the builder's last step or from ⋯ › Manage Access.

| Rule | Who can open it |
|---|---|
| All employees & partners | Everyone signed in |
| Employees only | Company staff |
| Partners only | Partners L1–L7 and their staff |
| Specific people | The employees and partners picked by name |

Admins see and manage every course, drafts included, and so do course managers. A course manager is:
- an employee with the Admin role or Manage Module Settings;
- or an L7 partner.

The server enforces the rule in three places:
- `GET /api/storage/sdcCourses` sends a learner only the published courses they were given. The list of people on a course is not sent to learners.
- `GET /api/sdc/media/:id` streams a video or thumbnail only to someone who may see a course that uses it.
- Only course managers may save the library or upload.

**Videos.** Course managers upload a video straight into a lesson from the builder: MP4, WEBM, OGG or MOV, up to `CRM_SDC_VIDEO_MAX_MB` (1024 by default). The browser reads the video's length and makes a thumbnail before it uploads. The server streams the file to disk as it arrives (`POST /api/sdc/media`) and serves it back with byte ranges, so the player can seek.

**Where videos are kept.** `CRM_SDC_MEDIA_DIR` sets the folder. `setup.sh` sets it to `/home/vishal-b2b2c/media`, beside `data/` rather than inside it. That keeps gigabytes of video out of the data backup taken on every deploy, so back up `media/` separately. nginx allows uploads up to 1100 MB on `/api/sdc/media` only; every other address keeps the 25 MB limit.

A dedicated video-upload page is not in the menu yet. Uploads go through the course builder.

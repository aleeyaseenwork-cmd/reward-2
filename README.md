# Reward Bot

A production-ready Discord bot for **automatic weekly/monthly chat leaderboard rewards** and a
**fixed-tier invite credit system**, with tickets, staff payout tracking, announcements, and
scheduled posts. Built with **discord.js v14** and **MongoDB (Mongoose)**.

## What it does

### 1. Chat Leaderboards (fully automatic)
The **top 3** most active members are paid every period. Every amount is offered as either USDT or
Discord Nitro — the winner picks in their ticket.

| Place | Weekly (min. 100 msgs) | Monthly (min. 400 msgs) |
|---|---|---|
| 🥇 1st | $5  | $25 |
| 🥈 2nd | $3  | $10 |
| 🥉 3rd | $2  | $5  |

- **Weekly** runs Monday 00:00 → Sunday 23:59 UTC and is announced every Monday.
  **Monthly** runs over the calendar month and is announced on the 1st.
- Both payout ladders are editable in `/admin` → **Chat Reward Settings**, entered comma-separated
  best place first (`$5, $3, $2`). The number of entries decides how many places get paid — add a
  fourth to pay a 4th place, or leave one to go back to winner-takes-all.
- The minimum only makes you **eligible**; your rank decides your reward. The same person can win
  weekly and monthly.
- **Valid-message rules** (enforced automatically): 5+ meaningful characters, not from a bot,
  not a repeat of a message they already sent, not emoji/symbol-only, max 1 qualifying message
  per 15 seconds, and only in approved channels. Edited messages never add points. Deleted
  messages have their point removed automatically.
- **Tie-breaking**: (1) more active days wins, (2) whoever reached the tied score first wins,
  (3) otherwise staff decides manually in the ticket.
- At reset the bot **freezes the ranking, saves every placing to history, announces + tags all
  winners publicly, opens one private ticket per winner** with their own payout, and staff mark
  each paid.

### 2. Anti-Spam (fully automatic)
Farming the leaderboard is detected and punished without staff involvement. Three patterns are
flagged, all judged over a short window so ordinary chatting is never caught:

| Pattern | Trigger |
|---|---|
| Flooding | 8+ messages in under 15 seconds |
| Repetition | 5+ near-identical messages (85% similar) within 3 minutes |
| Canned filler | 12+ messages in 3 minutes recycled from a handful of phrases |

- Flagged messages **never count** toward the leaderboard.
- The member gets a **DM warning** explaining what was detected and how many strikes remain.
- **Third strike = a 24-hour Discord timeout (mute)**, and the counter resets so the next offence
  starts the ladder again.
- One strike per spam episode (5-minute cooldown), and strikes decay after **7 clean days**.
- **Staff are exempt.** Warnings and mutes are posted to the mod log channel with a one-click
  **Unmute & Clear Warnings** button, and staff can also use `/warnings view|clear|unmute`.
- The whole system can be switched off with `/admin` → **🚫 Toggle Spam Detection**.
- The bot needs the **Moderate Members** permission and a role above the members it mutes; if a
  mute fails, the mod log says so explicitly.

### 3. Invite Credit Rewards
- Every valid invite earns 1 **credit**. An invited user only counts once **all** of these are true:
  real (non-bot) Discord member, has the server's **verified/member role**, and their Discord
  account was **30+ days old on the day they joined**.
- **Fake invites** — an account younger than 30 days at join is permanently marked fake. Account age
  is judged once, at join time, so an alt farm can't wait for its accounts to age into validity.
- **Rejoins** — anyone already tracked in this server is logged as a rejoin and **never** earns a
  credit for anyone, even if a different member's invite link was used.
- There is **no message-count requirement**. Message activity is still recorded for staff
  visibility, but it does not gate credits.
- If an invited user leaves **before** their credit was spent on a paid reward, the credit is
  removed. Credits already reserved or paid out are never touched (so payment history never goes
  negative).
- Default reward tiers (fully editable in `/admin`):

  | Credits | Reward |
  |---|---|
  | 20  | $3  |
  | 50  | $8  |
  | 100 | $18 |
  | 200 | $40 |

- Members run **`/claim invite`**, pick an available tier, choose **Nitro or USDT**, the bot
  re-checks eligibility, **reserves** the credits, and opens a private ticket. Staff sends the
  reward and clicks **Mark as Paid** — credits are then permanently consumed. Staff can also
  **Reject/Cancel** a claim, which returns the reserved credits.
- Rewards are repeatable — once a member earns enough new credits, they can claim again.
- **Invite claims are never announced publicly unless staff enables it** (`Toggle Public Invite
  Announce` in `/admin`).

### 4. Also included
- **`/invite`** — a member's own invite breakdown: real invites, pending verification, fake invites,
  rejoins, and members who left, plus their credit balance. Staff can pass a `user` option to look
  up someone else.
- **`/leaderboard-msgs`** — public weekly + monthly message Top 10.
- **`/leaderboard-invites`** — public Top 10 inviters by credits.
- **`/warnings view|clear|unmute`** — staff-only spam warning management. Not gated by Discord
  permissions (your staff role may not carry any), so the bot checks the configured staff role
  itself and refuses anyone else.
- **Live invite leaderboard** — an auto-refreshing Top 10 message, updated every 24 hours.
- **Announcements** — send now or schedule for a specific UTC date/time.
- **Scheduled posts** — plain content/image posts, manageable via `/scheduled list` / `cancel`.
- **`/progress`** — the chat leaderboard standings with your own rank, plus your credit balance.

## Project Structure

```
reward_bot/
├── commands/
│   ├── admin.js                 # /admin — configuration panel
│   ├── claim.js                 # /claim invite — redeem invite credits
│   ├── invite.js                # /invite — real / fake / rejoin breakdown
│   ├── leaderboard-invites.js   # /leaderboard-invites — Top 10 inviters
│   ├── leaderboard-msgs.js      # /leaderboard-msgs — Top 10 chatters
│   ├── progress.js              # /progress — standings + personal progress
│   ├── scheduled.js             # /scheduled list|cancel
│   └── warnings.js              # /warnings view|clear|unmute
├── handlers/
│   ├── tracker.js       # message validity, spam checks, invite tracking, credits
│   ├── moderation.js    # spam strikes, DM warnings, 24h mute, unmute
│   ├── chatRewards.js   # top-3 detection, announce, per-winner tickets
│   ├── leaderboard.js   # live invite leaderboard (build/publish/refresh)
│   ├── interactions.js  # all buttons, modals, select menus
│   └── scheduler.js     # sends due announcements & scheduled posts
├── models/
│   └── index.js          # all Mongoose schemas
├── utils/
│   └── helpers.js         # permissions, valid-message rules, date helpers
├── index.js               # bot entry point + all cron jobs
├── deploy-commands.js      # registers slash commands with Discord
├── package.json
├── .env.example
└── .gitignore
```

## 1. Prerequisites

- Node.js 18+ (Node 20 LTS recommended)
- A MongoDB database (Atlas free tier is fine)
- A Discord Application + Bot (https://discord.com/developers/applications)

## 2. Discord Bot Setup

1. Create an application, then add a **Bot**.
2. Under **Bot → Privileged Gateway Intents**, enable:
   - **Server Members Intent**
   - **Message Content Intent**
3. Copy the **Bot Token** and **Application (Client) ID**.
4. Invite the bot with scopes `bot` + `applications.commands`, and enough permissions to
   manage channels/tickets:
   ```
   https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=8&scope=bot%20applications.commands
   ```
   (`permissions=8` = Administrator, simplest for a fast launch. Scope it down for production.)

## 3. Install & Configure

```bash
cd reward_bot
npm install
cp .env.example .env
```

Fill in `.env`:
```
BOT_TOKEN=your-bot-token
CLIENT_ID=your-application-client-id
MONGODB_URI=your-mongodb-connection-string
```

## 4. Deploy Slash Commands & Start

```bash
npm run deploy
npm start
```

You should see:
```
✅ Connected to MongoDB
✅ Logged in as YourBot#1234
🕐 Announcement/post scheduler started (every minute).
🎟️ Invite credit evaluation scheduled (every 15 minutes).
🏆 Weekly chat reward scheduled (Monday 00:00 UTC).
👑 Monthly chat reward scheduled (1st of month, 00:00 UTC).
📊 Leaderboard auto-refresh scheduled (every 24 hours).
```

The bot is live at this point — the moment it's running, chat tracking and invite tracking are
already active. There's nothing else required to "go live."

## 5. First-Time Setup — `/admin`

1. **🔧 Server Roles** — set Admin Role, Staff Role, **Verified Role**, and Ticket Category.
   The Verified Role is required: without it **no invite can ever be validated**.
2. **💬 Chat Reward Settings** — minimums and the per-place payout ladders (`$5, $3, $2` weekly,
   `$25, $10, $5` monthly by default).
3. **📋 Approved Channels** — pick which channels count toward the chat leaderboard (leave empty
   to allow every channel).
4. **📢 Announce Channel** — where weekly/monthly winners (and optionally invite payouts) are
   posted.
5. **🛡️ Mod Log Channel** — where spam warnings and mutes are logged, each with an Unmute button.
6. **🎟️ Invite Credit Tiers** — edit the `credits:reward` list if you want different numbers
   than the defaults.
7. **🔁 Toggle Public Invite Announce** — off by default, per the spec.
8. **📊 Publish Invite Leaderboard** — optional live Top 10 inviters board.
9. **🎟️ / 💬 Publish Panels** — post the self-service invite and chat reward panels.

That's it — from here everything runs automatically.

## 6. How It Behaves Day-to-Day

- Every qualifying message in an approved channel silently adds to a member's weekly + monthly
  count. `/progress` lets anyone check their own standing.
- Every Monday 00:00 UTC and every 1st-of-month 00:00 UTC, the bot picks the **top 3**, announces
  them publicly in one embed, opens a private ticket per winner with that place's payout, and
  resets the period's counters for everyone.
- Spam is caught as it happens: the messages don't score, the member gets a DM, and the third
  strike is a 24-hour mute that staff can lift from the mod log or with `/warnings unmute`.
- Invite credits accrue automatically in the background (checked every 15 minutes) as invited
  members receive the verified role. Members can audit their own numbers with `/invite`.
- `/claim invite` is the only member-facing action needed for invite rewards.

## 7. Notes on Design Decisions

- **Reset timing**: weekly/monthly counters reset immediately when the cron freezes the ranking
  (not after the ticket is paid). This keeps each period's numbers exact even if a staff member
  takes a while to pay out a reward — deferring the reset would risk double-counting into the
  next period.
- **"Reached the score first" tie-break**: approximated using the timestamp of each member's most
  recent qualifying message during that period (since counts only increase, an earlier "last
  message" timestamp at a tied count means they got there first). If it's still tied after that,
  the ticket is created for staff to resolve manually.
- **Credit accounting**: each `UserInvite` document tracks `grantedCredits` (lifetime earned),
  `reservedCredits` (held by open `/claim invite` tickets), and `consumedCredits` (permanently
  paid). Available balance = granted − reserved − consumed, and it can never go negative.
- **Spam thresholds are time-bounded on purpose.** An earlier draft flagged "5 near-identical
  messages out of the last 20" with no time limit, which would punish someone typing "ok" a few
  times across an afternoon. Every pattern check now only looks at the last 3 minutes.
- **Attachment-only messages are skipped entirely** before spam checks, so posting several images
  in a row can't be read as repeating the same (empty) message.
- **Strikes reset after a mute** rather than escalating forever. Repeat offenders are still visible
  through `muteCount` and `totalWarnings` in `/warnings view`.

## 8. Common Issues

| Symptom | Likely Cause |
|---|---|
| Slash commands don't show up | Run `npm run deploy`, wait a few minutes, or re-invite with `applications.commands` scope |
| Messages aren't being counted | Enable **Message Content Intent**; check `/admin` → Approved Channels isn't excluding the channel |
| Invite credits never appear | Enable **Server Members Intent**; **set the Verified Role in `/admin` → Server Roles** (without it no invite can ever be validated); credits are only granted every 15 minutes |
| An invite shows as "fake" | Their Discord account was under 30 days old when they joined. This is judged once at join and never re-evaluated |
| An invite shows as "rejoin" | That user had already been in the server before. Rejoins never earn credits for anyone |
| Spam mutes never apply | The bot needs **Moderate Members** and its role must sit above the member's. The mod log shows the exact error |
| Warnings are issued but nobody sees them | Set a **Mod Log Channel** in `/admin`. DMs also fail silently if the member has DMs closed — the log records that too |
| `/warnings` is visible to everyone | By design — it's guarded by the configured staff role, not Discord permissions. Restrict it in Server Settings → Integrations if you prefer |
| Tickets fail to create | Bot needs **Manage Channels** permission and a valid ticket category |
| Winner never announced | Set an **Announce Channel** in `/admin`, or the bot falls back to the server's system channel |

## 9. Production Deployment Tips

- Use a process manager: `pm2 start index.js --name reward-bot` (or Docker/systemd).
- Keep the process running continuously — all reward automation depends on the cron jobs firing
  on schedule inside this process.
- Use a replica-set MongoDB connection string in production for reliability.
- Rotate your bot token immediately if it's ever committed to version control.

# Reward Bot

A production-ready Discord bot for **automatic weekly/monthly chat leaderboard rewards** and a
**fixed-tier invite credit system**, with tickets, staff payout tracking, announcements, and
scheduled posts. Built with **discord.js v14** and **MongoDB (Mongoose)**.

## What it does

### 1. Chat Leaderboards (fully automatic)
- **Weekly reward** — the member with the most valid messages Monday 00:00 → Sunday 23:59 UTC
  wins (default: $5 USDT or $5 Discord Nitro, min. 100 valid messages). Announced automatically
  every Monday.
- **Monthly reward** — same idea over the calendar month (default: $20, min. 400 valid messages).
  Announced automatically on the 1st of the following month.
- The same person can win both.
- **Valid-message rules** (enforced automatically): 5+ meaningful characters, not from a bot,
  not a repeat of a message they already sent, not emoji/symbol-only, max 1 qualifying message
  per 15 seconds, and only in approved channels. Edited messages never add points. Deleted
  messages have their point removed automatically.
- **Tie-breaking**: (1) more active days wins, (2) whoever reached the tied score first wins,
  (3) otherwise staff decides manually in the ticket.
- On a win, the bot **freezes the ranking, saves it to history, announces + tags the winner
  publicly, opens a private ticket, lets the winner pick Nitro or USDT**, and staff mark it paid.

### 2. Invite Credit Rewards
- Every valid invite earns 1 **credit**. An invited user only counts once **all** of these are true:
  real (non-bot) Discord member, has the server's verified role, stayed 7+ days, sent 10+ valid
  messages, account is 30+ days old, and hasn't already been credited to a different inviter.
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

### 3. Also included
- **Live invite leaderboard** — Top 10 inviters by credits, auto-refreshing every 24 hours.
- **Announcements** — send now or schedule for a specific UTC date/time.
- **Scheduled posts** — plain content/image posts, manageable via `/scheduled list` / `cancel`.
- **`/progress`** — a member's own weekly/monthly chat progress and invite credit balance.

## Project Structure

```
reward_bot/
├── commands/
│   ├── admin.js       # /admin — configuration panel
│   ├── claim.js        # /claim invite — redeem invite credits
│   ├── progress.js     # /progress — personal chat + invite progress
│   └── scheduled.js    # /scheduled list|cancel
├── handlers/
│   ├── tracker.js       # message validity, invite tracking, credit evaluation
│   ├── chatRewards.js   # weekly/monthly winner detection, announce, ticket
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

1. **🔧 Server Roles** — set Admin Role, Staff Role, Verified Role, and Ticket Category.
2. **💬 Chat Reward Settings** — adjust the weekly/monthly minimums and reward text if you don't
   want the defaults (100 msgs → $5 weekly, 400 msgs → $20 monthly).
3. **📋 Approved Channels** — pick which channels count toward the chat leaderboard (leave empty
   to allow every channel).
4. **📢 Announce Channel** — where weekly/monthly winners (and optionally invite payouts) are
   posted.
5. **🎟️ Invite Credit Tiers** — edit the `credits:reward` list if you want different numbers
   than the defaults.
6. **🔁 Toggle Public Invite Announce** — off by default, per the spec.
7. **📊 Publish Invite Leaderboard** — optional live Top 10 inviters board.

That's it — from here everything runs automatically.

## 6. How It Behaves Day-to-Day

- Every qualifying message in an approved channel silently adds to a member's weekly + monthly
  count. `/progress` lets anyone check their own standing.
- Every Monday 00:00 UTC and every 1st-of-month 00:00 UTC, the bot picks the winner, **announces
  it publicly with the exact wording style** you specified (`🏆 Weekly Chat Winner — Congratulations
  to @Member for finishing #1 with 1,245 valid messages! Reward: $5 USDT or $5 Discord Nitro.`),
  opens a private ticket, and resets that period's counters for everyone.
- Invite credits accrue automatically in the background (checked every 15 minutes) as invited
  members satisfy all five validity requirements.
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

## 8. Common Issues

| Symptom | Likely Cause |
|---|---|
| Slash commands don't show up | Run `npm run deploy`, wait a few minutes, or re-invite with `applications.commands` scope |
| Messages aren't being counted | Enable **Message Content Intent**; check `/admin` → Approved Channels isn't excluding the channel |
| Invite credits never appear | Enable **Server Members Intent**; make sure the verified role is set and members actually receive it; credits only post every 15 minutes |
| Tickets fail to create | Bot needs **Manage Channels** permission and a valid ticket category |
| Winner never announced | Set an **Announce Channel** in `/admin`, or the bot falls back to the server's system channel |

## 9. Production Deployment Tips

- Use a process manager: `pm2 start index.js --name reward-bot` (or Docker/systemd).
- Keep the process running continuously — all reward automation depends on the cron jobs firing
  on schedule inside this process.
- Use a replica-set MongoDB connection string in production for reliability.
- Rotate your bot token immediately if it's ever committed to version control.

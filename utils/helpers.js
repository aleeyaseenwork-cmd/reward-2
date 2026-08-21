const { PermissionsBitField } = require('discord.js');
const { ServerConfig } = require('../models');

function generateId(prefix = 'ID-') {
  return prefix + Math.random().toString(36).substr(2, 9).toUpperCase();
}

async function isAdmin(member, guildId) {
  if (!member) return false;
  if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
  try {
    const config = await ServerConfig.findOne({ guildId });
    if (config?.adminRoleId && member.roles.cache.has(config.adminRoleId)) return true;
  } catch (_) {}
  return false;
}

async function isStaff(member, guildId) {
  if (await isAdmin(member, guildId)) return true;
  try {
    const config = await ServerConfig.findOne({ guildId });
    if (config?.staffRoleId && member.roles.cache.has(config.staffRoleId)) return true;
  } catch (_) {}
  return false;
}

function progressBar(current, required, length = 10) {
  if (!required || required <= 0) return '█'.repeat(length);
  const pct = Math.min(current / required, 1);
  const filled = Math.round(pct * length);
  return '█'.repeat(filled) + '░'.repeat(length - filled);
}

function parseColor(color) {
  if (!color) return '#5865F2';
  if (/^#[0-9A-Fa-f]{6}$/.test(color)) return color;
  if (/^[0-9A-Fa-f]{6}$/.test(color)) return '#' + color;
  return '#5865F2';
}

const RATE_LIMIT_MS = 15 * 1000; // one qualifying message per 15 seconds

// ── Chat reward places ───────────────────────────────────────────────────────
const DEFAULT_WEEKLY_REWARDS = ['$5', '$3', '$2'];
const DEFAULT_MONTHLY_REWARDS = ['$25', '$10', '$5'];
const PLACE_MEDALS = ['🥇', '🥈', '🥉'];

function ordinal(n) {
  const suffix = (n % 100 >= 11 && n % 100 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  return `${n}${suffix}`;
}

// place is 1-based
function placeLabel(place) {
  const medal = PLACE_MEDALS[place - 1];
  return medal ? `${medal} ${ordinal(place)}` : `#${place}`;
}

// Winners pick their payout in the ticket, so every amount is offered both ways.
function rewardLabel(amount) {
  return `${amount} USDT or ${amount} Discord Nitro`;
}

function rewardsFor(config, period) {
  const configured = period === 'weekly' ? config?.weeklyRewards : config?.monthlyRewards;
  if (configured?.length) return configured;
  return period === 'weekly' ? DEFAULT_WEEKLY_REWARDS : DEFAULT_MONTHLY_REWARDS;
}

// ── Spam detection ───────────────────────────────────────────────────────────
const SPAM_HISTORY_SIZE = 20;
const SPAM_BURST_COUNT = 8;                   // messages...
const SPAM_BURST_WINDOW_MS = 15 * 1000;       // ...inside this window
const SPAM_RECENT_WINDOW_MS = 3 * 60 * 1000;  // "recent" for the pattern checks below
const SPAM_SIMILARITY = 0.85;                 // 0-1, how alike two messages must be
const SPAM_SIMILAR_COUNT = 5;                 // near-identical messages among the recent ones
const SPAM_DIVERSITY_SAMPLE = 12;             // only judge variety once there's enough history
const SPAM_DIVERSITY_RATIO = 0.35;            // unique / total below this means canned filler

function normalizeContent(text) {
  return (text || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 120);
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return prev[b.length];
}

function similarity(a, b) {
  const x = normalizeContent(a);
  const y = normalizeContent(b);
  if (!x.length && !y.length) return 1;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

/**
 * Flags message farming — chatting purely to inflate the leaderboard. Runs on
 * the rolling window kept in ChatStats and looks for three patterns:
 *  - bursts of messages fired off in seconds
 *  - the same thing said over and over with tiny variations
 *  - a stream of canned filler recycled from a handful of phrases
 * The 15s rate limit already stops these from scoring; this is what escalates
 * them to a warning.
 */
function detectSpam(content, recentMessages = [], recentTimestamps = [], now = Date.now()) {
  const age = at => (at ? now - new Date(at).getTime() : Infinity);

  const burst = recentTimestamps.filter(t => age(t) <= SPAM_BURST_WINDOW_MS).length + 1;
  if (burst >= SPAM_BURST_COUNT) {
    return { spam: true, reason: `sent ${burst} messages in under ${SPAM_BURST_WINDOW_MS / 1000} seconds` };
  }

  // The pattern checks are deliberately time-bounded: saying "ok" five times
  // over an afternoon is normal, saying it five times in three minutes is not.
  const recent = recentMessages.filter((_, i) => age(recentTimestamps[i]) <= SPAM_RECENT_WINDOW_MS);

  const similar = recent.filter(m => similarity(m, content) >= SPAM_SIMILARITY).length + 1;
  if (similar >= SPAM_SIMILAR_COUNT) {
    return { spam: true, reason: `posted ${similar} near-identical messages in a few minutes` };
  }

  const sample = [...recent, content].map(normalizeContent).filter(Boolean);
  if (sample.length >= SPAM_DIVERSITY_SAMPLE) {
    const unique = new Set(sample).size;
    if (unique / sample.length <= SPAM_DIVERSITY_RATIO) {
      return { spam: true, reason: `recycled just ${unique} different messages across ${sample.length} posts` };
    }
  }

  return { spam: false };
}

/**
 * Implements the "Valid-message rules":
 *  - at least five meaningful (alphanumeric) characters
 *  - not from a bot (checked by the caller before this runs)
 *  - not copied and repeatedly posted (exact repeat of a recent message)
 *  - not composed only of emojis, symbols, or mentions
 *  - not sent more frequently than one qualifying message every 15 seconds
 *  - sent in an approved server channel (checked by the caller)
 */
function isValidChatMessage(content, recentMessages = [], lastValidMessageAt = null) {
  if (!content) return { valid: false, reason: 'empty' };

  const trimmed = content.trim();
  const meaningfulChars = (trimmed.match(/[a-zA-Z0-9]/g) || []).length;
  if (meaningfulChars < 5) return { valid: false, reason: 'too_short_or_symbols_only' };

  if (recentMessages.some(m => m.toLowerCase() === trimmed.toLowerCase())) {
    return { valid: false, reason: 'repeated' };
  }

  if (lastValidMessageAt && (Date.now() - new Date(lastValidMessageAt).getTime()) < RATE_LIMIT_MS) {
    return { valid: false, reason: 'rate_limited' };
  }

  return { valid: true };
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

// Monday 00:00:00 UTC of the current week
function currentWeekStart(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = d.getUTCDay(); // 0 = Sunday
  const diff = (day === 0 ? -6 : 1) - day; // shift to Monday
  d.setUTCDate(d.getUTCDate() + diff);
  return d;
}

// 1st of the current month, 00:00:00 UTC
function currentMonthStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function daysBetween(a, b) {
  return (new Date(b).getTime() - new Date(a).getTime()) / (1000 * 60 * 60 * 24);
}

const MIN_ACCOUNT_AGE_DAYS = 30;

// Account age is judged once, at join time, so an alt farm can't simply wait
// for its accounts to age past the limit and become valid later.
function isFakeAccount(accountCreatedAt, joinedAt = new Date()) {
  if (!accountCreatedAt) return false;
  return daysBetween(accountCreatedAt, joinedAt) < MIN_ACCOUNT_AGE_DAYS;
}

// Reads the stored flag, falling back to a computed value for entries recorded
// before the flag existed.
function isFakeInvite(entry) {
  if (typeof entry.fake === 'boolean') return entry.fake;
  return isFakeAccount(entry.accountCreatedAt, entry.joinedAt);
}

/**
 * Buckets an inviter's tracked joins. Fakes and rejoins are counted separately
 * and never contribute to `real`, which is the number that earns credits.
 */
function computeInviteStats(doc) {
  const entries = doc?.invitedUsers || [];
  const stats = { total: entries.length, real: 0, pending: 0, fake: 0, rejoins: 0, left: 0 };
  for (const entry of entries) {
    if (entry.rejoin) { stats.rejoins++; continue; }
    if (isFakeInvite(entry)) { stats.fake++; continue; }
    if (entry.leftAt) { stats.left++; continue; }
    if (entry.verified || entry.creditGranted) stats.real++;
    else stats.pending++;
  }
  return stats;
}

function creditBalance(doc) {
  const granted = doc?.grantedCredits || 0;
  const reserved = doc?.reservedCredits || 0;
  const consumed = doc?.consumedCredits || 0;
  return { granted, reserved, consumed, available: Math.max(0, granted - reserved - consumed) };
}

// The next upcoming Monday 00:00:00 UTC (i.e. the next weekly reset).
function nextMonday(now = new Date()) {
  const day = now.getUTCDay();
  const daysUntilMonday = day === 1 ? 7 : ((8 - day) % 7 || 7);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilMonday));
}

// The 1st of next month, 00:00:00 UTC (i.e. the next monthly reset).
function nextMonthStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

// Formats a date in US Eastern Time, since the client wants US timezone shown.
function formatUSTime(date) {
  return new Date(date).toLocaleString('en-US', {
    timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
}

// "3 days, 4 hours remaining" style countdown text.
function formatCountdown(targetDate) {
  const ms = new Date(targetDate).getTime() - Date.now();
  if (ms <= 0) return 'resetting soon';
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  const hours = Math.floor((ms % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  if (days > 0) return `${days}d ${hours}h remaining`;
  const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
  return `${hours}h ${minutes}m remaining`;
}

module.exports = {
  generateId, isAdmin, isStaff, progressBar, parseColor,
  isValidChatMessage, todayUTC, currentWeekStart, currentMonthStart, daysBetween,
  nextMonday, nextMonthStart, formatUSTime, formatCountdown,
  isFakeAccount, isFakeInvite, computeInviteStats, creditBalance,
  ordinal, placeLabel, rewardLabel, rewardsFor,
  detectSpam, similarity, normalizeContent,
  RATE_LIMIT_MS, MIN_ACCOUNT_AGE_DAYS, SPAM_HISTORY_SIZE,
  DEFAULT_WEEKLY_REWARDS, DEFAULT_MONTHLY_REWARDS,
};

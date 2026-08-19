const mongoose = require('mongoose');

// ── SERVER CONFIG ─────────────────────────────────────────────
const ServerConfigSchema = new mongoose.Schema({
  guildId: { type: String, unique: true },
  adminRoleId: String,
  staffRoleId: String,
  verifiedRoleId: String,
  ticketCategoryId: String,
  approvedChannelIds: { type: [String], default: [] }, // empty = all channels count
  chatAnnounceChannelId: String,                        // where weekly/monthly winners are announced
  chatTrackingStartAt: { type: Date, default: null },   // messages before this time don't count (avoids a broken partial week)
  publicInviteAnnounce: { type: Boolean, default: false }, // invite claims stay private unless enabled
  weeklyMinMessages: { type: Number, default: 100 },
  monthlyMinMessages: { type: Number, default: 400 },
  weeklyReward: { type: String, default: '$5 USDT or $5 Discord Nitro' },
  monthlyReward: { type: String, default: '$20 USDT or $20 Discord Nitro' },
  timezone: { type: String, default: 'UTC' },
});
const ServerConfig = mongoose.model('ServerConfig', ServerConfigSchema);

// ── CHAT STATS (weekly + monthly leaderboard tracking) ────────
const ChatStatsSchema = new mongoose.Schema({
  guildId: String,
  userId: String,
  weeklyMessages: { type: Number, default: 0 },
  monthlyMessages: { type: Number, default: 0 },
  weeklyActiveDays: { type: Number, default: 0 },
  monthlyActiveDays: { type: Number, default: 0 },
  lastActiveDate: String,          // YYYY-MM-DD, used to increment active-day counters once/day
  lastValidMessageAt: Date,        // 15s rate-limit gate
  weeklyLastMessageAt: Date,       // tie-break proxy for "reached the score first"
  monthlyLastMessageAt: Date,
  recentMessages: { type: [String], default: [] }, // last few contents, for repeat-post detection
});
ChatStatsSchema.index({ guildId: 1, userId: 1 }, { unique: true });
const ChatStats = mongoose.model('ChatStats', ChatStatsSchema);

// Tracks which messages contributed a point, so a deletion can reverse it.
// TTL-expires automatically after 40 days (longer than any leaderboard period).
const CountedMessageSchema = new mongoose.Schema({
  guildId: String,
  userId: String,
  messageId: { type: String, unique: true },
  channelId: String,
  countedAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 40 },
});
const CountedMessage = mongoose.model('CountedMessage', CountedMessageSchema);

// Frozen snapshot of each weekly/monthly winner, kept permanently for history.
const ChatRewardHistorySchema = new mongoose.Schema({
  guildId: String,
  period: { type: String, enum: ['weekly', 'monthly'] },
  periodStart: Date,
  periodEnd: Date,
  winnerId: String,
  score: Number,
  rewardLabel: String,
  ticketId: String,
  createdAt: { type: Date, default: Date.now },
});
const ChatRewardHistory = mongoose.model('ChatRewardHistory', ChatRewardHistorySchema);

// ── INVITE CREDIT TIERS (configurable, seeded with sensible defaults) ─────
const InviteTierConfigSchema = new mongoose.Schema({
  guildId: { type: String, unique: true },
  tiers: {
    type: [{ credits: Number, reward: String, _id: false }],
    default: [
      { credits: 20, reward: '$3' },
      { credits: 50, reward: '$8' },
      { credits: 100, reward: '$18' },
      { credits: 200, reward: '$40' },
    ],
  },
});
const InviteTierConfig = mongoose.model('InviteTierConfig', InviteTierConfigSchema);

// ── USER INVITE CREDITS ────────────────────────────────────────
const UserInviteSchema = new mongoose.Schema({
  guildId: String,
  userId: String,
  grantedCredits: { type: Number, default: 0 },   // lifetime credits earned (valid invites)
  reservedCredits: { type: Number, default: 0 },  // held by pending /claim invite tickets
  consumedCredits: { type: Number, default: 0 },  // permanently spent on paid rewards
  invitedUsers: [{
    userId: String,
    joinedAt: Date,
    leftAt: Date,
    verified: { type: Boolean, default: false },
    verifiedAt: Date,
    messageCount: { type: Number, default: 0 },
    accountCreatedAt: Date,
    creditGranted: { type: Boolean, default: false },
    valid: { type: Boolean, default: true }, // still in the server
  }],
  inviteCode: String,
  updatedAt: { type: Date, default: Date.now },
});
UserInviteSchema.index({ guildId: 1, userId: 1 }, { unique: true });
UserInviteSchema.index({ guildId: 1, 'invitedUsers.userId': 1 });
const UserInvite = mongoose.model('UserInvite', UserInviteSchema);

// ── REWARD / CLAIM TICKETS (covers chat_weekly, chat_monthly, invite) ────
const RewardTicketSchema = new mongoose.Schema({
  guildId: String,
  ticketId: { type: String, unique: true },
  channelId: String,
  userId: String,
  type: { type: String, enum: ['chat_weekly', 'chat_monthly', 'invite'] },
  rewardLabel: String,
  tierCredits: Number,           // invite tickets only — credits reserved for this claim
  choice: { type: String, enum: ['nitro', 'usdt', null], default: null },
  status: { type: String, enum: ['pending', 'paid', 'cancelled'], default: 'pending' },
  paidBy: String,
  paidAt: Date,
  createdAt: { type: Date, default: Date.now },
});
const RewardTicket = mongoose.model('RewardTicket', RewardTicketSchema);

// ── ANNOUNCEMENTS ─────────────────────────────────────────────
const AnnouncementSchema = new mongoose.Schema({
  guildId: String,
  title: String,
  description: String,
  color: { type: String, default: '#5865F2' },
  imageUrl: String,
  buttonText: String,
  buttonUrl: String,
  channelId: String,
  scheduledFor: Date,
  sent: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});
const Announcement = mongoose.model('Announcement', AnnouncementSchema);

// ── SCHEDULED POSTS ───────────────────────────────────────────
const ScheduledPostSchema = new mongoose.Schema({
  guildId: String,
  content: String,
  imageUrl: String,
  channelId: String,
  scheduledFor: Date,
  sent: { type: Boolean, default: false },
  cancelled: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});
const ScheduledPost = mongoose.model('ScheduledPost', ScheduledPostSchema);

// ── LEADERBOARD CONFIG (live top-10 inviters) ─────────────────
const LeaderboardConfigSchema = new mongoose.Schema({
  guildId: { type: String, unique: true },
  channelId: String,
  messageId: String,
  updatedAt: { type: Date, default: Date.now },
});
const LeaderboardConfig = mongoose.model('LeaderboardConfig', LeaderboardConfigSchema);

module.exports = {
  ServerConfig, ChatStats, CountedMessage, ChatRewardHistory, InviteTierConfig,
  UserInvite, RewardTicket, Announcement, ScheduledPost, LeaderboardConfig,
};

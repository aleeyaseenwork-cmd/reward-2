const { ChatStats, CountedMessage, UserInvite, ServerConfig } = require('../models');
const {
  isValidChatMessage, todayUTC, isFakeAccount, isFakeInvite, detectSpam, isStaff, SPAM_HISTORY_SIZE,
} = require('../utils/helpers');
const { recordSpamStrike } = require('./moderation');

const inviteCache = new Map();

async function initInviteCache(guild) {
  try {
    const invites = await guild.invites.fetch();
    inviteCache.set(guild.id, new Map(invites.map(i => [i.code, i.uses])));
  } catch (_) {}
}

// Is this Discord user already tracked as someone's invited user in this guild?
// Enforces "have not already been credited to another inviter" and identifies rejoins.
async function isAlreadyTracked(guildId, invitedUserId) {
  const existing = await UserInvite.findOne({ guildId, 'invitedUsers.userId': invitedUserId });
  return !!existing;
}

async function handleMemberJoin(member, client) {
  const guild = member.guild;
  const guildId = guild.id;
  if (member.user.bot) return; // bots are never valid invites

  try {
    const oldInvites = inviteCache.get(guildId) || new Map();
    const newInvites = await guild.invites.fetch();
    inviteCache.set(guildId, new Map(newInvites.map(i => [i.code, i.uses])));

    let inviterCode = null, inviterId = null;
    for (const inv of newInvites.values()) {
      if ((oldInvites.get(inv.code) || 0) < inv.uses) { inviterCode = inv.code; inviterId = inv.inviter?.id; break; }
    }
    if (!inviterId || inviterId === member.id) return;

    // Anyone already tracked in this guild is a rejoin. It's still recorded so
    // /invite can show it, but it can never earn a credit for anyone.
    const rejoin = await isAlreadyTracked(guildId, member.id);
    const joinedAt = new Date();
    const accountCreatedAt = member.user.createdAt;

    await UserInvite.findOneAndUpdate(
      { guildId, userId: inviterId },
      {
        $push: {
          invitedUsers: {
            userId: member.id,
            joinedAt,
            verified: false,
            messageCount: 0,
            accountCreatedAt,
            creditGranted: false,
            valid: true,
            fake: isFakeAccount(accountCreatedAt, joinedAt),
            rejoin,
          },
        },
        $set: { guildId, userId: inviterId, inviteCode: inviterCode, updatedAt: new Date() },
      },
      { upsert: true }
    );
  } catch (e) { console.error('[Invite Track]', e.message); }
}

// If the invited user leaves before their credit was consumed by a paid claim,
// remove the credit. Never touch credits that are already reserved/consumed —
// that would break payment history and could push the balance negative.
async function handleMemberLeave(member) {
  const guildId = member.guild.id;
  try {
    // A rejoiner can appear under more than one inviter, so every matching
    // entry has to be closed out, not just the first one found.
    const docs = await UserInvite.find({ guildId, 'invitedUsers.userId': member.id });
    for (const doc of docs) {
      let changed = false;
      for (const entry of doc.invitedUsers) {
        if (entry.userId !== member.id || entry.leftAt) continue;

        entry.leftAt = new Date();
        entry.valid = false;
        changed = true;

        if (entry.creditGranted) {
          const available = doc.grantedCredits - doc.reservedCredits - doc.consumedCredits;
          if (available > 0) {
            doc.grantedCredits = Math.max(0, doc.grantedCredits - 1);
            entry.creditGranted = false;
          }
          // else: credit already reserved/consumed — protected, left untouched
        }
      }
      if (changed) {
        doc.markModified('invitedUsers');
        await doc.save();
      }
    }
  } catch (e) { console.error('[Leave Track]', e.message); }
}

async function handleVerifiedRole(member, guildId) {
  try {
    const docs = await UserInvite.find({ guildId, 'invitedUsers.userId': member.id });
    for (const doc of docs) {
      let changed = false;
      for (const entry of doc.invitedUsers) {
        if (entry.userId !== member.id || entry.verified) continue;
        entry.verified = true;
        entry.verifiedAt = new Date();
        changed = true;
      }
      if (changed) {
        doc.markModified('invitedUsers');
        await doc.save();
      }
    }
  } catch (_) {}
}

async function handleRoleAdd(oldMember, newMember) {
  const guildId = newMember.guild.id;
  try {
    const config = await ServerConfig.findOne({ guildId });
    if (!config?.verifiedRoleId) return;
    const hadRole = oldMember.roles.cache.has(config.verifiedRoleId);
    const hasRole = newMember.roles.cache.has(config.verifiedRoleId);
    if (!hadRole && hasRole) await handleVerifiedRole(newMember, guildId);
  } catch (_) {}
}

async function handleMessage(message) {
  if (!message.guild || message.author.bot) return;
  const guildId = message.guild.id;
  const userId = message.author.id;
  const content = message.content;
  const today = todayUTC();

  try {
    const config = await ServerConfig.findOne({ guildId });
    if (config?.approvedChannelIds?.length && !config.approvedChannelIds.includes(message.channel.id)) {
      return; // not an approved channel
    }
    if (config?.chatTrackingStartAt && new Date() < new Date(config.chatTrackingStartAt)) {
      return; // engagement tracking hasn't officially started yet
    }

    // Attachment-only posts have no text to judge, and feeding empty strings to
    // the repeat detectors would flag anyone sharing a few images.
    if (!content || !content.trim()) return;

    let stats = await ChatStats.findOne({ guildId, userId });
    if (!stats) stats = new ChatStats({ guildId, userId });

    const history = stats.recentMessages || [];
    const timestamps = stats.recentMessageAt || [];
    const check = isValidChatMessage(content, history, stats.lastValidMessageAt);

    // Every message goes into the rolling window, counted or not — spam
    // detection is only meaningful if it can see the messages that were dropped.
    stats.recentMessages = [...history, content.trim()].slice(-SPAM_HISTORY_SIZE);
    stats.recentMessageAt = [...timestamps, new Date()].slice(-SPAM_HISTORY_SIZE);

    if (config?.spamDetectionEnabled !== false) {
      const spam = detectSpam(content, history, timestamps);
      if (spam.spam) {
        await stats.save();
        // Staff are exempt so a moderator posting canned replies can't be muted
        // by their own bot.
        if (message.member && !await isStaff(message.member, guildId)) {
          await recordSpamStrike(message.member, spam.reason);
        }
        return; // spam never scores
      }
    }

    if (!check.valid) {
      await stats.save();
      return;
    }

    stats.weeklyMessages = (stats.weeklyMessages || 0) + 1;
    stats.monthlyMessages = (stats.monthlyMessages || 0) + 1;
    stats.weeklyLastMessageAt = new Date();
    stats.monthlyLastMessageAt = new Date();
    stats.lastValidMessageAt = new Date();

    if (stats.lastActiveDate !== today) {
      stats.weeklyActiveDays = (stats.weeklyActiveDays || 0) + 1;
      stats.monthlyActiveDays = (stats.monthlyActiveDays || 0) + 1;
      stats.lastActiveDate = today;
    }

    await stats.save();
    await CountedMessage.create({ guildId, userId, messageId: message.id, channelId: message.channel.id });

    // Kept for staff visibility only — message activity is not a credit requirement.
    await UserInvite.updateMany(
      { guildId, 'invitedUsers.userId': userId },
      { $inc: { 'invitedUsers.$.messageCount': 1 } }
    );
  } catch (e) { console.error('[Chat Track]', e.message); }
}

// Deleted messages should not keep contributing to the leaderboard.
async function handleMessageDelete(message) {
  if (!message.guild) return;
  try {
    const counted = await CountedMessage.findOneAndDelete({ messageId: message.id, guildId: message.guild.id });
    if (!counted) return;
    const stats = await ChatStats.findOne({ guildId: counted.guildId, userId: counted.userId });
    if (!stats) return;
    stats.weeklyMessages = Math.max(0, (stats.weeklyMessages || 0) - 1);
    stats.monthlyMessages = Math.max(0, (stats.monthlyMessages || 0) - 1);
    await stats.save();
  } catch (e) { console.error('[Delete Track]', e.message); }
}

// Pulls members into cache in batches of 100 so the role check below costs one
// request per hundred members rather than one per member.
async function ensureMembersCached(client, guildId, userIds) {
  const guild = client?.guilds?.cache.get(guildId);
  if (!guild) return null;
  const missing = userIds.filter(id => !guild.members.cache.has(id));
  for (let i = 0; i < missing.length; i += 100) {
    await guild.members.fetch({ user: missing.slice(i, i + 100) }).catch(() => {});
  }
  return guild;
}

function isCreditCandidate(entry) {
  if (entry.creditGranted || entry.leftAt || !entry.valid) return false;
  if (entry.rejoin) return false;        // a returning member is never a new invite
  if (isFakeInvite(entry)) return false; // account was under 30 days old at join
  return true;
}

// Periodically grants invite credits once every validity requirement is met:
// a real member who holds the verified role, whose account was 30+ days old when
// they joined, and who isn't a rejoin. Runs on a timer rather than purely on
// events so roles granted while the bot was offline are still picked up.
async function evaluateInviteCredits(client) {
  try {
    const docs = await UserInvite.find({ 'invitedUsers.creditGranted': false });

    const byGuild = new Map();
    for (const doc of docs) {
      if (!byGuild.has(doc.guildId)) byGuild.set(doc.guildId, []);
      byGuild.get(doc.guildId).push(doc);
    }

    for (const [guildId, guildDocs] of byGuild) {
      const config = await ServerConfig.findOne({ guildId });
      const verifiedRoleId = config?.verifiedRoleId;
      // Without a configured verified role there is no way to validate anyone.
      if (!verifiedRoleId) continue;

      const awaitingVerification = new Set();
      for (const doc of guildDocs) {
        for (const entry of doc.invitedUsers) {
          if (isCreditCandidate(entry) && !entry.verified) awaitingVerification.add(entry.userId);
        }
      }
      const guild = await ensureMembersCached(client, guildId, [...awaitingVerification]);

      for (const doc of guildDocs) {
        let changed = false;
        for (const entry of doc.invitedUsers) {
          if (!isCreditCandidate(entry)) continue;

          if (!entry.verified) {
            if (!guild?.members.cache.get(entry.userId)?.roles.cache.has(verifiedRoleId)) continue;
            entry.verified = true;
            entry.verifiedAt = new Date();
          }

          entry.creditGranted = true;
          doc.grantedCredits = (doc.grantedCredits || 0) + 1;
          changed = true;
        }
        if (changed) {
          doc.markModified('invitedUsers');
          doc.updatedAt = new Date();
          await doc.save();
        }
      }
    }
  } catch (e) { console.error('[Credit Eval]', e.message); }
}

module.exports = {
  initInviteCache, handleMemberJoin, handleMemberLeave, handleVerifiedRole, handleRoleAdd,
  handleMessage, handleMessageDelete, evaluateInviteCredits,
};

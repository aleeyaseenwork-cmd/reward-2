const { ChatStats, CountedMessage, UserInvite, ServerConfig } = require('../models');
const { isValidChatMessage, todayUTC, daysBetween } = require('../utils/helpers');

const inviteCache = new Map();

async function initInviteCache(guild) {
  try {
    const invites = await guild.invites.fetch();
    inviteCache.set(guild.id, new Map(invites.map(i => [i.code, i.uses])));
  } catch (_) {}
}

// Is this Discord user already tracked as someone's invited user in this guild?
// Enforces "have not already been credited to another inviter".
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

    if (await isAlreadyTracked(guildId, member.id)) return; // dedupe across inviters

    await UserInvite.findOneAndUpdate(
      { guildId, userId: inviterId },
      {
        guildId, userId: inviterId,
        $push: {
          invitedUsers: {
            userId: member.id,
            joinedAt: new Date(),
            verified: false,
            messageCount: 0,
            accountCreatedAt: member.user.createdAt,
            creditGranted: false,
            valid: true,
          },
        },
        $set: { inviteCode: inviterCode, updatedAt: new Date() },
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
    const doc = await UserInvite.findOne({ guildId, 'invitedUsers.userId': member.id });
    if (!doc) return;
    const idx = doc.invitedUsers.findIndex(u => u.userId === member.id);
    if (idx === -1) return;
    const entry = doc.invitedUsers[idx];

    entry.leftAt = new Date();
    entry.valid = false;

    if (entry.creditGranted) {
      const available = doc.grantedCredits - doc.reservedCredits - doc.consumedCredits;
      if (available > 0) {
        doc.grantedCredits = Math.max(0, doc.grantedCredits - 1);
        entry.creditGranted = false;
      }
      // else: credit already reserved/consumed — protected, left untouched
    }

    doc.markModified('invitedUsers');
    await doc.save();
  } catch (e) { console.error('[Leave Track]', e.message); }
}

async function handleVerifiedRole(member, guildId) {
  try {
    const doc = await UserInvite.findOne({ guildId, 'invitedUsers.userId': member.id });
    if (!doc) return;
    const idx = doc.invitedUsers.findIndex(u => u.userId === member.id);
    if (idx === -1) return;
    doc.invitedUsers[idx].verified = true;
    doc.invitedUsers[idx].verifiedAt = new Date();
    doc.markModified('invitedUsers');
    await doc.save();
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

    let stats = await ChatStats.findOne({ guildId, userId });
    if (!stats) stats = new ChatStats({ guildId, userId });

    const check = isValidChatMessage(content, stats.recentMessages || [], stats.lastValidMessageAt);
    if (!check.valid) return;

    const recent = (stats.recentMessages || []).slice(-9);
    recent.push(content.trim());
    stats.recentMessages = recent;

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

    // Counts toward the invite's "10 valid messages" requirement, if this user was invited.
    await UserInvite.updateOne(
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

// Periodically grants invite credits once ALL validity requirements are met:
// real member, verified role, 7+ days in server, account 30+ days old.
// Runs on a timer because "stayed X days" can only be discovered by time passing,
// not by any single Discord event.
async function evaluateInviteCredits() {
  try {
    const docs = await UserInvite.find({ 'invitedUsers.creditGranted': false });
    for (const doc of docs) {
      let changed = false;
      for (const entry of doc.invitedUsers) {
        if (entry.creditGranted || entry.leftAt || !entry.valid) continue;
        if (!entry.verified) continue;
        if (!entry.joinedAt || daysBetween(entry.joinedAt, new Date()) < 7) continue;
        if (!entry.accountCreatedAt || daysBetween(entry.accountCreatedAt, new Date()) < 30) continue;

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
  } catch (e) { console.error('[Credit Eval]', e.message); }
}

module.exports = {
  initInviteCache, handleMemberJoin, handleMemberLeave, handleVerifiedRole, handleRoleAdd,
  handleMessage, handleMessageDelete, evaluateInviteCredits,
};

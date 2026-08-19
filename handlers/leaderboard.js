const { EmbedBuilder } = require('discord.js');
const { UserInvite, LeaderboardConfig } = require('../models');

const MEDALS = ['🥇', '🥈', '🥉'];

async function buildLeaderboardEmbed(guild) {
  const top = await UserInvite.find({ guildId: guild.id }).sort({ grantedCredits: -1 }).limit(10);

  if (top.length === 0) {
    return new EmbedBuilder()
      .setTitle('🏆 Invite Leaderboard')
      .setColor('#F5A623')
      .setDescription('No invites tracked yet. Be the first to invite someone!')
      .setTimestamp();
  }

  const lines = [];
  for (let i = 0; i < top.length; i++) {
    const entry = top[i];
    const leftCount = (entry.invitedUsers || []).filter(u => u.leftAt).length;
    let name;
    try {
      const member = await guild.members.fetch(entry.userId);
      name = member.user.username;
    } catch (_) {
      name = `Unknown User (${entry.userId})`;
    }
    const rank = MEDALS[i] || `**#${i + 1}**`;
    lines.push(`${rank} **${name}** — ✅ ${entry.grantedCredits || 0} credits  |  🚪 ${leftCount} left`);
  }

  return new EmbedBuilder()
    .setTitle('🏆 Invite Leaderboard — Top 10')
    .setColor('#F5A623')
    .setDescription(lines.join('\n'))
    .setFooter({ text: 'Updates automatically every 24 hours' })
    .setTimestamp();
}

async function publishLeaderboard(client, guildId, channelId) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return { ok: false, reason: 'Guild not found in cache.' };
  const channel = guild.channels.cache.get(channelId);
  if (!channel) return { ok: false, reason: 'Channel not found.' };

  const embed = await buildLeaderboardEmbed(guild);
  const msg = await channel.send({ embeds: [embed] });
  await LeaderboardConfig.findOneAndUpdate(
    { guildId },
    { guildId, channelId, messageId: msg.id, updatedAt: new Date() },
    { upsert: true }
  );
  return { ok: true, channel };
}

async function refreshLeaderboard(client, config) {
  try {
    const guild = client.guilds.cache.get(config.guildId);
    if (!guild) return;
    const channel = guild.channels.cache.get(config.channelId);
    if (!channel) return;
    const embed = await buildLeaderboardEmbed(guild);

    if (config.messageId) {
      try {
        const msg = await channel.messages.fetch(config.messageId);
        await msg.edit({ embeds: [embed] });
        return;
      } catch (_) {
        // Message was deleted or inaccessible — fall through to re-send.
      }
    }
    const msg = await channel.send({ embeds: [embed] });
    config.messageId = msg.id;
    config.updatedAt = new Date();
    await config.save();
  } catch (e) {
    console.error('[Leaderboard] refresh error:', e.message);
  }
}

async function refreshAllLeaderboards(client) {
  try {
    const configs = await LeaderboardConfig.find({});
    for (const config of configs) {
      await refreshLeaderboard(client, config);
    }
  } catch (e) {
    console.error('[Leaderboard] refreshAll error:', e.message);
  }
}

module.exports = { buildLeaderboardEmbed, publishLeaderboard, refreshLeaderboard, refreshAllLeaderboards };

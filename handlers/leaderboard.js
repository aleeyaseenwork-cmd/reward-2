const { EmbedBuilder } = require('discord.js');
const { UserInvite, LeaderboardConfig, ChatStats } = require('../models');
const { computeInviteStats, placeLabel, rewardsFor } = require('../utils/helpers');

const MEDALS = ['🥇', '🥈', '🥉'];

async function resolveName(guild, userId) {
  try {
    const member = await guild.members.fetch(userId);
    return member.user.username;
  } catch (_) {
    return 'Unknown User';
  }
}

// Shared by /progress and /leaderboard-msgs so both render the standings identically.
async function buildChatRankedLines(guild, entries, field) {
  const lines = [];
  for (let i = 0; i < entries.length; i++) {
    const name = await resolveName(guild, entries[i].userId);
    const rank = MEDALS[i] || `**#${i + 1}**`;
    lines.push(`${rank} ${name} — **${entries[i][field]}** msgs`);
  }
  return lines.join('\n') || '_No activity yet this period._';
}

async function buildChatLeaderboardEmbed(guild, config = {}) {
  const [weeklyTop, monthlyTop] = await Promise.all([
    ChatStats.find({ guildId: guild.id }).sort({ weeklyMessages: -1 }).limit(10),
    ChatStats.find({ guildId: guild.id }).sort({ monthlyMessages: -1 }).limit(10),
  ]);
  const [weeklyLines, monthlyLines] = await Promise.all([
    buildChatRankedLines(guild, weeklyTop, 'weeklyMessages'),
    buildChatRankedLines(guild, monthlyTop, 'monthlyMessages'),
  ]);

  const payoutSummary = period => rewardsFor(config, period)
    .map((amount, i) => `${placeLabel(i + 1)} ${amount}`).join(' · ');

  return new EmbedBuilder()
    .setTitle('💬 Message Leaderboard — Top 10')
    .setColor('#5865F2')
    .setDescription('The top 3 of each period get paid.')
    .addFields(
      { name: `🗓️ Weekly (min. ${config.weeklyMinMessages ?? 100} msgs) — ${payoutSummary('weekly')}`, value: weeklyLines, inline: false },
      { name: `📅 Monthly (min. ${config.monthlyMinMessages ?? 400} msgs) — ${payoutSummary('monthly')}`, value: monthlyLines, inline: false },
    )
    .setFooter({ text: 'Use /progress to see your own rank and the countdown to reset.' })
    .setTimestamp();
}

async function buildLeaderboardEmbed(guild, { autoRefresh = false } = {}) {
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
    const s = computeInviteStats(entry);
    const name = await resolveName(guild, entry.userId);
    const rank = MEDALS[i] || `**#${i + 1}**`;
    lines.push(`${rank} **${name}** — ✅ ${entry.grantedCredits || 0} credits | 👥 ${s.real} real | 🚫 ${s.fake} fake | 🔁 ${s.rejoins} rejoin`);
  }

  return new EmbedBuilder()
    .setTitle('🏆 Invite Leaderboard — Top 10')
    .setColor('#F5A623')
    .setDescription(lines.join('\n'))
    .setFooter({ text: `Fake accounts and rejoins never earn credits${autoRefresh ? ' · Updates every 24 hours' : ''}` })
    .setTimestamp();
}

async function publishLeaderboard(client, guildId, channelId) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return { ok: false, reason: 'Guild not found in cache.' };
  const channel = guild.channels.cache.get(channelId);
  if (!channel) return { ok: false, reason: 'Channel not found.' };

  const embed = await buildLeaderboardEmbed(guild, { autoRefresh: true });
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
    const embed = await buildLeaderboardEmbed(guild, { autoRefresh: true });

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

module.exports = {
  buildLeaderboardEmbed, publishLeaderboard, refreshLeaderboard, refreshAllLeaderboards,
  buildChatLeaderboardEmbed, buildChatRankedLines,
};

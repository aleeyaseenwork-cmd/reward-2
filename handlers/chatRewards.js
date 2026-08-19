const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionsBitField } = require('discord.js');
const { ChatStats, ChatRewardHistory, ServerConfig, RewardTicket } = require('../models');
const { generateId, currentWeekStart, currentMonthStart } = require('../utils/helpers');

// Ranks users for a period: highest message count wins; ties broken by
// (1) more active days, (2) whoever reached the tied count first (earlier
// last-qualifying-message timestamp), (3) left for staff to decide manually.
function rankEntries(entries, msgField, daysField, lastMsgField) {
  return [...entries].sort((a, b) => {
    if (b[msgField] !== a[msgField]) return b[msgField] - a[msgField];
    if (b[daysField] !== a[daysField]) return b[daysField] - a[daysField];
    const aTime = a[lastMsgField] ? new Date(a[lastMsgField]).getTime() : Infinity;
    const bTime = b[lastMsgField] ? new Date(b[lastMsgField]).getTime() : Infinity;
    return aTime - bTime; // earlier = reached the score first = wins
  });
}

async function findAnnounceChannel(guild, config) {
  if (config?.chatAnnounceChannelId) {
    const ch = guild.channels.cache.get(config.chatAnnounceChannelId);
    if (ch) return ch;
  }
  return guild.systemChannel || guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.viewable);
}

async function createWinnerTicket(client, guild, config, winnerId, type, rewardLabel) {
  const ticketId = generateId('TKT-');
  const categoryId = config?.ticketCategoryId;
  const mentionRoleId = config?.staffRoleId;
  let channel;
  try {
    const user = await client.users.fetch(winnerId);
    channel = await guild.channels.create({
      name: `reward-${user.username}-${ticketId.slice(-4).toLowerCase()}`,
      type: ChannelType.GuildText,
      parent: categoryId || null,
      permissionOverwrites: [
        { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
        { id: winnerId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
        ...(mentionRoleId ? [{ id: mentionRoleId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }] : []),
        { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels] },
      ],
    });
  } catch (e) {
    console.error('[Chat Reward] Could not create ticket channel:', e.message);
    return null;
  }

  await RewardTicket.create({
    guildId: guild.id, ticketId, channelId: channel.id, userId: winnerId,
    type, rewardLabel, status: 'pending',
  });

  const embed = new EmbedBuilder()
    .setTitle(`🏆 ${type === 'chat_weekly' ? 'Weekly' : 'Monthly'} Chat Reward — ${ticketId}`)
    .setColor('#F5A623')
    .setDescription(`Congratulations <@${winnerId}>! Please select how you'd like to receive your reward:\n\n**Reward:** ${rewardLabel}`)
    .setTimestamp();

  const choiceRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`chat_choice_nitro_${ticketId}`).setLabel('🎮 Discord Nitro').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`chat_choice_usdt_${ticketId}`).setLabel('💵 USDT').setStyle(ButtonStyle.Primary),
  );

  const mention = mentionRoleId ? `<@&${mentionRoleId}> ` : '';
  await channel.send({ content: `${mention}<@${winnerId}> — your reward ticket is ready!`, embeds: [embed], components: [choiceRow] });
  return { ticketId, channel };
}

async function announceWinner(channel, title, winnerId, score, rewardLabel) {
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor('#F5A623')
    .setDescription(`Congratulations to <@${winnerId}> for finishing #1 with **${score.toLocaleString()}** valid messages!\nReward: **${rewardLabel}**`)
    .setTimestamp();
  await channel.send({ embeds: [embed] });
}

async function runWeeklyChatRewards(client) {
  for (const guild of client.guilds.cache.values()) {
    try {
      const config = await ServerConfig.findOne({ guildId: guild.id }) || {};
      const minMessages = config.weeklyMinMessages ?? 100;
      const rewardLabel = config.weeklyReward || '$5 USDT or $5 Discord Nitro';

      const eligible = await ChatStats.find({ guildId: guild.id, weeklyMessages: { $gte: minMessages } });
      if (!eligible.length) {
        // Still reset even if nobody hit the threshold, so the new week starts clean.
        await ChatStats.updateMany({ guildId: guild.id }, { weeklyMessages: 0, weeklyActiveDays: 0, weeklyLastMessageAt: null });
        continue;
      }

      const ranked = rankEntries(eligible, 'weeklyMessages', 'weeklyActiveDays', 'weeklyLastMessageAt');
      const winner = ranked[0];
      const channel = await findAnnounceChannel(guild, config);

      let ticketId = null;
      if (channel) {
        await announceWinner(channel, '🏆 Weekly Chat Winner', winner.userId, winner.weeklyMessages, rewardLabel);
        const ticket = await createWinnerTicket(client, guild, config, winner.userId, 'chat_weekly', rewardLabel);
        ticketId = ticket?.ticketId || null;
      }

      await ChatRewardHistory.create({
        guildId: guild.id, period: 'weekly',
        periodStart: currentWeekStart(new Date(Date.now() - 24 * 60 * 60 * 1000)),
        periodEnd: new Date(), winnerId: winner.userId, score: winner.weeklyMessages,
        rewardLabel, ticketId,
      });

      await ChatStats.updateMany({ guildId: guild.id }, { weeklyMessages: 0, weeklyActiveDays: 0, weeklyLastMessageAt: null });
    } catch (e) { console.error('[Weekly Chat Reward]', guild.id, e.message); }
  }
}

async function runMonthlyChatRewards(client) {
  for (const guild of client.guilds.cache.values()) {
    try {
      const config = await ServerConfig.findOne({ guildId: guild.id }) || {};
      const minMessages = config.monthlyMinMessages ?? 400;
      const rewardLabel = config.monthlyReward || '$20 USDT or $20 Discord Nitro';

      const eligible = await ChatStats.find({ guildId: guild.id, monthlyMessages: { $gte: minMessages } });
      if (!eligible.length) {
        await ChatStats.updateMany({ guildId: guild.id }, { monthlyMessages: 0, monthlyActiveDays: 0, monthlyLastMessageAt: null });
        continue;
      }

      const ranked = rankEntries(eligible, 'monthlyMessages', 'monthlyActiveDays', 'monthlyLastMessageAt');
      const winner = ranked[0];
      const channel = await findAnnounceChannel(guild, config);

      let ticketId = null;
      if (channel) {
        await announceWinner(channel, '👑 Monthly Chat Champion', winner.userId, winner.monthlyMessages, rewardLabel);
        const ticket = await createWinnerTicket(client, guild, config, winner.userId, 'chat_monthly', rewardLabel);
        ticketId = ticket?.ticketId || null;
      }

      await ChatRewardHistory.create({
        guildId: guild.id, period: 'monthly',
        periodStart: currentMonthStart(new Date(Date.now() - 24 * 60 * 60 * 1000)),
        periodEnd: new Date(), winnerId: winner.userId, score: winner.monthlyMessages,
        rewardLabel, ticketId,
      });

      await ChatStats.updateMany({ guildId: guild.id }, { monthlyMessages: 0, monthlyActiveDays: 0, monthlyLastMessageAt: null });
    } catch (e) { console.error('[Monthly Chat Reward]', guild.id, e.message); }
  }
}

module.exports = { runWeeklyChatRewards, runMonthlyChatRewards, createWinnerTicket };

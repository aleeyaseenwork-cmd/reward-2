const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionsBitField } = require('discord.js');
const { ChatStats, ChatRewardHistory, ServerConfig, RewardTicket } = require('../models');
const { generateId, currentWeekStart, currentMonthStart, placeLabel, rewardLabel, rewardsFor, ordinal } = require('../utils/helpers');

const PERIODS = {
  weekly: {
    msgField: 'weeklyMessages',
    daysField: 'weeklyActiveDays',
    lastMsgField: 'weeklyLastMessageAt',
    minMessages: config => config.weeklyMinMessages ?? 100,
    periodStart: currentWeekStart,
    ticketType: 'chat_weekly',
    heading: '🏆 Weekly Chat Winners',
    noun: 'Weekly',
  },
  monthly: {
    msgField: 'monthlyMessages',
    daysField: 'monthlyActiveDays',
    lastMsgField: 'monthlyLastMessageAt',
    minMessages: config => config.monthlyMinMessages ?? 400,
    periodStart: currentMonthStart,
    ticketType: 'chat_monthly',
    heading: '👑 Monthly Chat Champions',
    noun: 'Monthly',
  },
};

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

async function createWinnerTicket(client, guild, config, winnerId, type, reward, place, noun) {
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

  const label = rewardLabel(reward);
  await RewardTicket.create({
    guildId: guild.id, ticketId, channelId: channel.id, userId: winnerId,
    type, rewardLabel: label, place, status: 'pending',
  });

  const embed = new EmbedBuilder()
    .setTitle(`${placeLabel(place)} ${noun} Chat Reward — ${ticketId}`)
    .setColor('#F5A623')
    .setDescription(`Congratulations <@${winnerId}>! You finished **${ordinal(place)}**.\n\n**Reward:** ${label}\n\nPlease select how you'd like to receive it:`)
    .setTimestamp();

  const choiceRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`chat_choice_nitro_${ticketId}`).setLabel('🎮 Discord Nitro').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`chat_choice_usdt_${ticketId}`).setLabel('💵 USDT').setStyle(ButtonStyle.Primary),
  );

  const mention = mentionRoleId ? `<@&${mentionRoleId}> ` : '';
  await channel.send({ content: `${mention}<@${winnerId}> — your reward ticket is ready!`, embeds: [embed], components: [choiceRow] });
  return { ticketId, channel };
}

async function announceWinners(channel, heading, winners, msgField) {
  const lines = winners.map(({ entry, place, reward }) =>
    `${placeLabel(place)} — <@${entry.userId}> with **${entry[msgField].toLocaleString()}** valid messages → **${rewardLabel(reward)}**`
  );
  const embed = new EmbedBuilder()
    .setTitle(heading)
    .setColor('#F5A623')
    .setDescription(`Congratulations to our top chatters!\n\n${lines.join('\n')}`)
    .setFooter({ text: 'A private ticket has been opened for each winner to pick their payout.' })
    .setTimestamp();
  await channel.send({ content: winners.map(w => `<@${w.entry.userId}>`).join(' '), embeds: [embed] });
}

async function runChatRewards(client, period) {
  const spec = PERIODS[period];

  for (const guild of client.guilds.cache.values()) {
    try {
      const config = await ServerConfig.findOne({ guildId: guild.id }) || {};
      if (config.chatTrackingStartAt && new Date() < new Date(config.chatTrackingStartAt)) {
        continue; // engagement hasn't officially started for this guild yet
      }

      const rewards = rewardsFor(config, period);
      const minMessages = spec.minMessages(config);
      const reset = {
        [spec.msgField]: 0,
        [spec.daysField]: 0,
        [spec.lastMsgField]: null,
      };

      const eligible = await ChatStats.find({ guildId: guild.id, [spec.msgField]: { $gte: minMessages } });
      if (!eligible.length) {
        // Still reset even if nobody hit the threshold, so the new period starts clean.
        await ChatStats.updateMany({ guildId: guild.id }, reset);
        continue;
      }

      const ranked = rankEntries(eligible, spec.msgField, spec.daysField, spec.lastMsgField);
      const winners = ranked.slice(0, rewards.length).map((entry, i) => ({ entry, place: i + 1, reward: rewards[i] }));
      const channel = await findAnnounceChannel(guild, config);
      if (channel) await announceWinners(channel, spec.heading, winners, spec.msgField);

      const periodStart = spec.periodStart(new Date(Date.now() - 24 * 60 * 60 * 1000));
      for (const { entry, place, reward } of winners) {
        // Tickets are created even when there's no announce channel — a missing
        // announcement shouldn't cost someone their payout.
        const ticket = await createWinnerTicket(client, guild, config, entry.userId, spec.ticketType, reward, place, spec.noun);
        const ticketId = ticket?.ticketId || null;
        await ChatRewardHistory.create({
          guildId: guild.id, period,
          periodStart, periodEnd: new Date(),
          winnerId: entry.userId, place, score: entry[spec.msgField],
          rewardLabel: rewardLabel(reward), ticketId,
        });
      }

      await ChatStats.updateMany({ guildId: guild.id }, reset);
    } catch (e) { console.error(`[${period} Chat Reward]`, guild.id, e.message); }
  }
}

const runWeeklyChatRewards = client => runChatRewards(client, 'weekly');
const runMonthlyChatRewards = client => runChatRewards(client, 'monthly');

module.exports = { runWeeklyChatRewards, runMonthlyChatRewards, runChatRewards, createWinnerTicket };

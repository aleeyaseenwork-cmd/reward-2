const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionsBitField } = require('discord.js');
const { ServerConfig, InviteTierConfig, UserInvite, RewardTicket } = require('../models');
const { generateId } = require('../utils/helpers');

const DEFAULT_TIERS = [
  { credits: 20, reward: '$3' },
  { credits: 50, reward: '$8' },
  { credits: 100, reward: '$18' },
  { credits: 200, reward: '$40' },
];

// Always reads the live config, so admin changes apply on the very next check.
async function getTiers(guildId) {
  const config = await InviteTierConfig.findOne({ guildId });
  if (config?.tiers?.length) return config.tiers;
  return DEFAULT_TIERS;
}

// Opens the private reward ticket channel in the configured ticket category.
// Payout choice starts empty, the winner picks Nitro or USDT inside the ticket.
async function openInviteTicket(client, guild, userId, credits, reward, choice = null) {
  const config = await ServerConfig.findOne({ guildId: guild.id }) || {};
  const ticketId = generateId('TKT-');
  const mentionRoleId = config.staffRoleId;
  const user = await client.users.fetch(userId);

  const channel = await guild.channels.create({
    name: `invite-${user.username}-${ticketId.slice(-4).toLowerCase()}`,
    type: ChannelType.GuildText,
    parent: config.ticketCategoryId || null,
    permissionOverwrites: [
      { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
      { id: userId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
      ...(mentionRoleId ? [{ id: mentionRoleId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }] : []),
      { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels] },
    ],
  });

  await RewardTicket.create({
    guildId: guild.id, ticketId, channelId: channel.id, userId, type: 'invite',
    rewardLabel: reward, tierCredits: credits, choice, status: 'pending',
  });

  const mention = mentionRoleId ? `<@&${mentionRoleId}> ` : '';

  if (choice) {
    const embed = new EmbedBuilder()
      .setTitle(`🎁 Invite Reward Ticket — ${ticketId}`)
      .setColor('#5865F2')
      .setDescription(`<@${userId}> claimed **${reward}** for **${credits}** invite credits.\n\nPayout method: **${choice === 'nitro' ? 'Discord Nitro' : 'USDT'}**`)
      .setTimestamp();
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`ticket_claimed_${ticketId}`).setLabel('✅ Mark as Paid').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`ticket_reject_${ticketId}`).setLabel('❌ Reject / Cancel').setStyle(ButtonStyle.Danger),
    );
    await channel.send({ content: `${mention}<@${userId}> — your invite reward ticket is ready!`, embeds: [embed], components: [row] });
  } else {
    const embed = new EmbedBuilder()
      .setTitle(`🎁 Invite Reward Ticket — ${ticketId}`)
      .setColor('#5865F2')
      .setDescription(`<@${userId}> reached **${credits}** invite credits and earned **${reward}**! 🎉\n\nPick how you want to receive it:`)
      .setTimestamp();
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`chat_choice_nitro_${ticketId}`).setLabel('🎮 Discord Nitro').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`chat_choice_usdt_${ticketId}`).setLabel('💵 USDT').setStyle(ButtonStyle.Primary),
    );
    await channel.send({ content: `${mention}<@${userId}> — your invite reward ticket is ready!`, embeds: [embed], components: [row] });
  }
  return { ticketId, channel };
}

// Checks ONE user against the CURRENT tiers. While their available credits reach
// a tier, it reserves those credits and opens a ticket. Highest reachable tier first.
// The reservation is a single atomic DB update, so two checks running at the same
// time can never reserve the same credits twice.
async function autoOpenForUser(client, guild, userId, tiers) {
  let opened = 0;
  const sorted = [...(tiers || await getTiers(guild.id))].sort((a, b) => b.credits - a.credits);

  for (let guard = 0; guard < 10; guard++) {
    const doc = await UserInvite.findOne({ guildId: guild.id, userId });
    if (!doc) break;
    const available = (doc.grantedCredits || 0) - (doc.reservedCredits || 0) - (doc.consumedCredits || 0);
    const tier = sorted.find(t => t.credits > 0 && available >= t.credits);
    if (!tier) break;

    const reserved = await UserInvite.findOneAndUpdate(
      {
        guildId: guild.id, userId,
        $expr: { $gte: [{ $subtract: ['$grantedCredits', { $add: ['$reservedCredits', '$consumedCredits'] }] }, tier.credits] },
      },
      { $inc: { reservedCredits: tier.credits }, $set: { updatedAt: new Date() } },
      { new: true }
    );
    if (!reserved) break; // someone else got there first, or credits changed

    try {
      await openInviteTicket(client, guild, userId, tier.credits, tier.reward, null);
      opened++;
    } catch (e) {
      // Ticket failed (permissions, deleted category...). Give the credits back so
      // nothing is lost, the next check will retry.
      await UserInvite.updateOne({ guildId: guild.id, userId }, { $inc: { reservedCredits: -tier.credits } });
      console.error('[Auto Ticket] could not open ticket:', e.message);
      break;
    }
  }
  return opened;
}

// Checks everyone in a guild who has spare credits. Used after config changes
// and on the regular timer.
async function sweepGuild(client, guildId) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return 0;
  const config = await ServerConfig.findOne({ guildId });
  if (config?.inviteRewardsEnabled === false) return 0;

  const tiers = await getTiers(guildId);
  const lowest = Math.min(...tiers.map(t => t.credits).filter(c => c > 0));
  if (!Number.isFinite(lowest)) return 0;

  const docs = await UserInvite.find({
    guildId,
    $expr: { $gte: [{ $subtract: ['$grantedCredits', { $add: ['$reservedCredits', '$consumedCredits'] }] }, lowest] },
  }).select('userId');

  let total = 0;
  for (const d of docs) total += await autoOpenForUser(client, guild, d.userId, tiers);
  return total;
}

async function sweepAllGuilds(client) {
  for (const guild of client.guilds.cache.values()) {
    try { await sweepGuild(client, guild.id); } catch (e) { console.error('[Auto Ticket Sweep]', e.message); }
  }
}

module.exports = { getTiers, openInviteTicket, autoOpenForUser, sweepGuild, sweepAllGuilds };

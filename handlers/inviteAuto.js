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

// User clicked "Open Ticket" for one tier. Re-checks against the CURRENT tiers and
// their CURRENT credits, then reserves exactly that tier's credits (atomic, so a
// double click or two devices can never spend the same credits twice) and opens
// the ticket. Leftover credits stay with the user.
async function claimInviteTier(client, guild, userId, credits) {
  const tiers = await getTiers(guild.id);
  const tier = tiers.find(t => t.credits === credits);
  if (!tier) return { ok: false, reason: 'That tier no longer exists. Run /invite again to see the current tiers.' };

  const reserved = await UserInvite.findOneAndUpdate(
    {
      guildId: guild.id, userId,
      $expr: { $gte: [{ $subtract: ['$grantedCredits', { $add: ['$reservedCredits', '$consumedCredits'] }] }, credits] },
    },
    { $inc: { reservedCredits: credits }, $set: { updatedAt: new Date() } },
    { new: true }
  );
  if (!reserved) return { ok: false, reason: `You no longer have **${credits}** available invites for this reward.` };

  try {
    const { channel } = await openInviteTicket(client, guild, userId, credits, tier.reward, null);
    return { ok: true, channel, tier };
  } catch (e) {
    await UserInvite.updateOne({ guildId: guild.id, userId }, { $inc: { reservedCredits: -credits } });
    console.error('[Invite Ticket]', e.message);
    return { ok: false, reason: 'Could not open the ticket. Please tell staff (check the ticket category and bot permissions).' };
  }
}

module.exports = { getTiers, openInviteTicket, claimInviteTier };

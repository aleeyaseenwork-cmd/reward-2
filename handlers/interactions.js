const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  ChannelSelectMenuBuilder, ChannelType, PermissionsBitField
} = require('discord.js');
const { isAdmin, isStaff, generateId } = require('../utils/helpers');
const {
  ServerConfig, InviteTierConfig, UserInvite, RewardTicket, Announcement, ScheduledPost,
} = require('../models');
const { publishLeaderboard } = require('./leaderboard');

const state = new Map();
function getState(userId) { return state.get(userId) || {}; }
function setState(userId, data) { state.set(userId, { ...getState(userId), ...data }); }
function clearState(userId) { state.delete(userId); }

async function safeReply(interaction, options) {
  try {
    if (interaction.replied) return await interaction.followUp({ ...options, ephemeral: true });
    if (interaction.deferred) return await interaction.editReply(options);
    return await interaction.reply({ ...options, ephemeral: true });
  } catch (e) { console.error('[Reply]', e.message); }
}

// Fallback fetch — some cache states leave interaction.member unpopulated for
// component interactions, which used to crash permission checks.
async function resolveMember(interaction) {
  if (interaction.member && interaction.member.roles) return interaction.member;
  try { return await interaction.guild.members.fetch(interaction.user.id); } catch (_) { return null; }
}

async function getTiers(guildId) {
  const config = await InviteTierConfig.findOne({ guildId });
  if (config?.tiers?.length) return config.tiers;
  return [
    { credits: 20, reward: '$3' },
    { credits: 50, reward: '$8' },
    { credits: 100, reward: '$18' },
    { credits: 200, reward: '$40' },
  ];
}

async function createInviteTicket(interaction, client, credits, reward, choice, userId) {
  const guildId = interaction.guild.id;
  const config = await ServerConfig.findOne({ guildId }) || {};
  const ticketId = generateId('TKT-');
  const categoryId = config.ticketCategoryId;
  const mentionRoleId = config.staffRoleId;
  let channel;
  try {
    const user = await client.users.fetch(userId);
    channel = await interaction.guild.channels.create({
      name: `invite-${user.username}-${ticketId.slice(-4).toLowerCase()}`,
      type: ChannelType.GuildText,
      parent: categoryId || null,
      permissionOverwrites: [
        { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
        { id: userId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
        ...(mentionRoleId ? [{ id: mentionRoleId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }] : []),
        { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels] },
      ],
    });
  } catch (e) {
    return safeReply(interaction, { content: '❌ Could not create ticket channel. Make sure the bot has Manage Channels permission.' });
  }

  await RewardTicket.create({
    guildId, ticketId, channelId: channel.id, userId, type: 'invite',
    rewardLabel: reward, tierCredits: credits, choice, status: 'pending',
  });

  const embed = new EmbedBuilder()
    .setTitle(`🎁 Invite Reward Ticket — ${ticketId}`)
    .setColor('#5865F2')
    .setDescription(`<@${userId}> claimed **${reward}** for **${credits}** invite credits.\n\nPayout method: **${choice === 'nitro' ? 'Discord Nitro' : 'USDT'}**`)
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket_claimed_${ticketId}`).setLabel('✅ Mark as Paid').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`ticket_reject_${ticketId}`).setLabel('❌ Reject / Cancel').setStyle(ButtonStyle.Danger),
  );

  const mention = mentionRoleId ? `<@&${mentionRoleId}> ` : '';
  await channel.send({ content: `${mention}<@${userId}> — your invite reward ticket is ready!`, embeds: [embed], components: [row] });
  return channel;
}

async function handleInteraction(interaction, client) {
  if (!interaction.guild) return;
  const id = interaction.customId;
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;

  // ── PUBLISHED PANEL: buttons anyone can click ────────────────────────────────
  // Lazy-required to avoid a circular require with commands/*.js at module load time.
  if (id === 'panel_progress') {
    const progressCommand = require('../commands/progress');
    return progressCommand.execute(interaction);
  }
  if (id === 'panel_claim_invite') {
    const claimCommand = require('../commands/claim');
    return claimCommand.execute(interaction);
  }

  // Direct tier button on the invite panel (e.g. "$3 - 20 Invites") — skips the
  // select-menu step and jumps straight to the Nitro/USDT choice.
  if (id.startsWith('panel_claim_tier_')) {
    const credits = parseInt(id.replace('panel_claim_tier_', ''), 10);
    const tiers = await getTiers(guildId);
    const tier = tiers.find(t => t.credits === credits);
    if (!tier) return safeReply(interaction, { content: '❌ That tier no longer exists.' });

    const doc = await UserInvite.findOne({ guildId, userId });
    const available = doc ? (doc.grantedCredits - doc.reservedCredits - doc.consumedCredits) : 0;
    if (available < credits) {
      return safeReply(interaction, { content: `❌ You need **${credits}** invite credits for **${tier.reward}**. You currently have **${available}** available.` });
    }

    const embed = new EmbedBuilder().setTitle('Choose Your Payout').setColor('#5865F2')
      .setDescription(`You selected **${tier.reward}** for **${credits}** invite credits.\n\nHow would you like to receive it?`);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`invite_claim_choice_nitro_${credits}`).setLabel('🎮 Discord Nitro').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`invite_claim_choice_usdt_${credits}`).setLabel('💵 USDT').setStyle(ButtonStyle.Primary),
    );
    return safeReply(interaction, { embeds: [embed], components: [row] });
  }

  // "Apply for Reward" on the chat panel — chat rewards are automatic, so this
  // just explains that and points the member at their live progress instead.
  if (id === 'panel_chat_apply') {
    return safeReply(interaction, {
      content: '🏆 Chat rewards are awarded **automatically** — the top performer each week/month is announced and given a private ticket, no application needed.\n\nUse **📊 My Progress** to see exactly how close you are to winning.',
    });
  }

  // ── INVITE CLAIM: tier selected → ask Nitro or USDT ──────────────────────────
  if (id === 'invite_claim_tier_select') {
    const credits = parseInt(interaction.values[0], 10);
    const tiers = await getTiers(guildId);
    const tier = tiers.find(t => t.credits === credits);
    if (!tier) return interaction.update({ content: '❌ That tier no longer exists.', embeds: [], components: [] });

    const embed = new EmbedBuilder().setTitle('Choose Your Payout').setColor('#5865F2')
      .setDescription(`You selected **${tier.reward}** for **${credits}** invite credits.\n\nHow would you like to receive it?`);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`invite_claim_choice_nitro_${credits}`).setLabel('🎮 Discord Nitro').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`invite_claim_choice_usdt_${credits}`).setLabel('💵 USDT').setStyle(ButtonStyle.Primary),
    );
    return interaction.update({ embeds: [embed], components: [row] });
  }

  // ── INVITE CLAIM: payout choice → recheck eligibility, reserve, open ticket ──
  if (id.startsWith('invite_claim_choice_')) {
    const rest = id.replace('invite_claim_choice_', '');
    const [choice, creditsStr] = rest.split('_');
    const credits = parseInt(creditsStr, 10);
    const tiers = await getTiers(guildId);
    const tier = tiers.find(t => t.credits === credits);
    if (!tier) return interaction.update({ content: '❌ That tier no longer exists.', embeds: [], components: [] });

    const doc = await UserInvite.findOne({ guildId, userId });
    const available = doc ? (doc.grantedCredits - doc.reservedCredits - doc.consumedCredits) : 0;
    if (available < credits) {
      return interaction.update({ content: `❌ You no longer have enough available credits for this tier (need **${credits}**, have **${available}**).`, embeds: [], components: [] });
    }

    doc.reservedCredits += credits;
    await doc.save();

    await interaction.update({ content: '✅ Eligibility confirmed! Creating your reward ticket...', embeds: [], components: [] });
    await createInviteTicket(interaction, client, credits, tier.reward, choice, userId);
    return;
  }

  // ── CHAT REWARD: winner picks payout method ──────────────────────────────────
  if (id.startsWith('chat_choice_')) {
    const rest = id.replace('chat_choice_', '');
    const sep = rest.indexOf('_');
    const choice = rest.slice(0, sep);
    const ticketId = rest.slice(sep + 1);
    const ticket = await RewardTicket.findOne({ guildId, ticketId });
    if (!ticket) return safeReply(interaction, { content: '❌ Ticket not found.' });
    if (ticket.userId !== userId) return safeReply(interaction, { content: '❌ Only the winner can choose the payout method.' });
    if (ticket.status !== 'pending') return safeReply(interaction, { content: '❌ This ticket is no longer pending.' });

    ticket.choice = choice;
    await ticket.save();

    const embed = new EmbedBuilder()
      .setTitle(`🏆 ${ticket.type === 'chat_weekly' ? 'Weekly' : 'Monthly'} Chat Reward — ${ticketId}`)
      .setColor('#F5A623')
      .setDescription(`<@${userId}> chose **${choice === 'nitro' ? 'Discord Nitro' : 'USDT'}**.\n\n**Reward:** ${ticket.rewardLabel}\n\nStaff: please send the reward, then mark this ticket as paid.`)
      .setTimestamp();
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`ticket_claimed_${ticketId}`).setLabel('✅ Mark as Paid').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`ticket_reject_${ticketId}`).setLabel('❌ Reject / Cancel').setStyle(ButtonStyle.Danger),
    );
    await interaction.update({ embeds: [embed], components: [row] });
    return;
  }

  // ── TICKET: MARK AS PAID (staff only) ─────────────────────────────────────────
  if (id.startsWith('ticket_claimed_')) {
    const ticketId = id.replace('ticket_claimed_', '');
    const member = await resolveMember(interaction);
    if (!member || !await isStaff(member, guildId)) {
      return safeReply(interaction, { content: '❌ Only staff can mark tickets as paid.' });
    }
    const ticket = await RewardTicket.findOne({ guildId, ticketId });
    if (!ticket) return safeReply(interaction, { content: '❌ Ticket not found.' });
    if (ticket.status !== 'pending') return safeReply(interaction, { content: '❌ This ticket has already been resolved.' });

    if (ticket.type === 'invite') {
      const inv = await UserInvite.findOne({ guildId, userId: ticket.userId });
      if (inv) {
        inv.reservedCredits = Math.max(0, inv.reservedCredits - ticket.tierCredits);
        inv.consumedCredits += ticket.tierCredits;
        await inv.save();
      }
    }

    ticket.status = 'paid';
    ticket.paidBy = userId;
    ticket.paidAt = new Date();
    await ticket.save();

    const confirmEmbed = new EmbedBuilder()
      .setTitle('✅ Reward Paid')
      .setColor('#00FF88')
      .setDescription(`Paid by <@${userId}> for <@${ticket.userId}>.\n\n**Reward:** ${ticket.rewardLabel}\nRecorded at ${ticket.paidAt.toUTCString()}.`)
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`ticket_delete_yes_${ticketId}`).setLabel('Delete Ticket').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`ticket_delete_no_${ticketId}`).setLabel('Keep Open').setStyle(ButtonStyle.Secondary),
    );

    await interaction.message.edit({ components: [] });
    await safeReply(interaction, { content: 'Ticket marked as paid.' });
    await interaction.channel.send({ embeds: [confirmEmbed], components: [row] });

    // Public announcement for invite claims only if staff has enabled it.
    if (ticket.type === 'invite') {
      const config = await ServerConfig.findOne({ guildId });
      if (config?.publicInviteAnnounce && config?.chatAnnounceChannelId) {
        const ch = interaction.guild.channels.cache.get(config.chatAnnounceChannelId);
        if (ch) {
          const publicEmbed = new EmbedBuilder()
            .setTitle('🎉 Invite Reward Paid')
            .setColor('#00FF88')
            .setDescription(`<@${ticket.userId}> just claimed **${ticket.rewardLabel}** for **${ticket.tierCredits}** invite credits!`)
            .setTimestamp();
          await ch.send({ embeds: [publicEmbed] }).catch(() => {});
        }
      }
    }
    return;
  }

  // ── TICKET: REJECT / CANCEL (staff only, returns reserved credits) ──────────
  if (id.startsWith('ticket_reject_')) {
    const ticketId = id.replace('ticket_reject_', '');
    const member = await resolveMember(interaction);
    if (!member || !await isStaff(member, guildId)) {
      return safeReply(interaction, { content: '❌ Only staff can reject tickets.' });
    }
    const ticket = await RewardTicket.findOne({ guildId, ticketId });
    if (!ticket) return safeReply(interaction, { content: '❌ Ticket not found.' });
    if (ticket.status !== 'pending') return safeReply(interaction, { content: '❌ This ticket has already been resolved.' });

    if (ticket.type === 'invite') {
      const inv = await UserInvite.findOne({ guildId, userId: ticket.userId });
      if (inv) {
        inv.reservedCredits = Math.max(0, inv.reservedCredits - ticket.tierCredits);
        await inv.save();
      }
    }
    ticket.status = 'cancelled';
    await ticket.save();

    await interaction.message.edit({ components: [] });
    await safeReply(interaction, { content: `❌ Ticket rejected/cancelled by <@${userId}>.${ticket.type === 'invite' ? ' Reserved credits have been returned.' : ''}` });
    await interaction.channel.send({ content: '🗑️ Deleting ticket in 5 seconds...' });
    setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
    return;
  }

  if (id.startsWith('ticket_delete_yes_')) {
    const member = await resolveMember(interaction);
    if (!member || !await isStaff(member, guildId)) return safeReply(interaction, { content: '❌ Staff only.' });
    await interaction.message.edit({ components: [] });
    await interaction.channel.send({ content: '🗑️ Deleting ticket in 5 seconds...' });
    setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
    return safeReply(interaction, { content: '✅ Ticket will be deleted.' });
  }

  if (id.startsWith('ticket_delete_no_')) {
    await interaction.message.edit({ components: [] });
    return safeReply(interaction, { content: '✅ Ticket kept open.' });
  }

  // ── ADMIN GATE ────────────────────────────────────────────────────────────────
  const ADMIN_PREFIXES = ['admin_', 'modal_admin_config', 'modal_chat_config', 'modal_invite_tiers', 'announce_channel_config_select', 'approved_channels_select', 'publish_invite_panel_', 'publish_chat_panel_', 'announce_', 'sched_post_', 'leaderboard_', 'modal_announce', 'modal_schedule_post'];
  if (ADMIN_PREFIXES.some(p => id.startsWith(p))) {
    const member = await resolveMember(interaction);
    if (!member || !await isAdmin(member, guildId)) {
      return safeReply(interaction, { content: '❌ Admin only.' });
    }
  }

  // ── SERVER CONFIG (roles / ticket category) ──────────────────────────────────
  if (id === 'admin_config') {
    const modal = new ModalBuilder().setCustomId('modal_admin_config').setTitle('Server Configuration');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('admin_role').setLabel('Admin Role ID').setStyle(TextInputStyle.Short).setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('staff_role').setLabel('Staff Role ID').setStyle(TextInputStyle.Short).setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('verified_role').setLabel('Verified Role ID').setStyle(TextInputStyle.Short).setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ticket_category').setLabel('Ticket Category ID').setStyle(TextInputStyle.Short).setRequired(false)),
    );
    return interaction.showModal(modal);
  }

  if (id === 'modal_admin_config') {
    const adminRole = interaction.fields.getTextInputValue('admin_role');
    const staffRole = interaction.fields.getTextInputValue('staff_role');
    const verifiedRole = interaction.fields.getTextInputValue('verified_role');
    const ticketCategory = interaction.fields.getTextInputValue('ticket_category');
    const update = {};
    if (adminRole) update.adminRoleId = adminRole;
    if (staffRole) update.staffRoleId = staffRole;
    if (verifiedRole) update.verifiedRoleId = verifiedRole;
    if (ticketCategory) update.ticketCategoryId = ticketCategory;
    await ServerConfig.findOneAndUpdate({ guildId }, { guildId, ...update }, { upsert: true });
    return safeReply(interaction, { content: '✅ Server configuration saved.' });
  }

  // ── CHAT REWARD THRESHOLDS ────────────────────────────────────────────────────
  if (id === 'admin_chat_config') {
    const config = await ServerConfig.findOne({ guildId }) || {};
    const modal = new ModalBuilder().setCustomId('modal_chat_config').setTitle('Chat Leaderboard Rewards');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('weekly_min').setLabel('Weekly Minimum Valid Messages').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(config.weeklyMinMessages ?? 100))),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('weekly_reward').setLabel('Weekly Reward').setStyle(TextInputStyle.Short).setRequired(true).setValue(config.weeklyReward || '$5 USDT or $5 Discord Nitro')),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('monthly_min').setLabel('Monthly Minimum Valid Messages').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(config.monthlyMinMessages ?? 400))),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('monthly_reward').setLabel('Monthly Reward').setStyle(TextInputStyle.Short).setRequired(true).setValue(config.monthlyReward || '$20 USDT or $20 Discord Nitro')),
    );
    return interaction.showModal(modal);
  }

  if (id === 'modal_chat_config') {
    const weeklyMin = parseInt(interaction.fields.getTextInputValue('weekly_min')) || 100;
    const monthlyMin = parseInt(interaction.fields.getTextInputValue('monthly_min')) || 400;
    const weeklyReward = interaction.fields.getTextInputValue('weekly_reward');
    const monthlyReward = interaction.fields.getTextInputValue('monthly_reward');
    await ServerConfig.findOneAndUpdate(
      { guildId },
      { guildId, weeklyMinMessages: weeklyMin, monthlyMinMessages: monthlyMin, weeklyReward, monthlyReward },
      { upsert: true }
    );
    return safeReply(interaction, { content: '✅ Chat leaderboard reward settings saved.' });
  }

  // ── ANNOUNCE CHANNEL (used for weekly/monthly winners + optional invite claims) ─
  if (id === 'admin_set_announce_channel') {
    const embed = new EmbedBuilder().setTitle('Set Announcement Channel').setColor('#5865F2')
      .setDescription('Select the channel where weekly/monthly chat winners (and, if enabled, invite reward payouts) will be announced.');
    const row = new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('announce_channel_config_select').setPlaceholder('Select channel').addChannelTypes(ChannelType.GuildText));
    return safeReply(interaction, { embeds: [embed], components: [row] });
  }

  if (id === 'announce_channel_config_select') {
    const channelId = interaction.values[0];
    await ServerConfig.findOneAndUpdate({ guildId }, { guildId, chatAnnounceChannelId: channelId }, { upsert: true });
    return interaction.update({ content: `✅ Announcement channel set to <#${channelId}>.`, embeds: [], components: [] });
  }

  // ── APPROVED CHANNELS FOR VALID MESSAGES ─────────────────────────────────────
  if (id === 'admin_set_approved_channels') {
    const embed = new EmbedBuilder().setTitle('Set Approved Channels').setColor('#5865F2')
      .setDescription('Select the channels where messages count toward the chat leaderboard. Select none to allow every channel.');
    const row = new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder().setCustomId('approved_channels_select').setPlaceholder('Select up to 10 channels').setMinValues(0).setMaxValues(10).addChannelTypes(ChannelType.GuildText)
    );
    return safeReply(interaction, { embeds: [embed], components: [row] });
  }

  if (id === 'approved_channels_select') {
    const channelIds = interaction.values;
    await ServerConfig.findOneAndUpdate({ guildId }, { guildId, approvedChannelIds: channelIds }, { upsert: true });
    return interaction.update({ content: channelIds.length ? `✅ Approved channels set: ${channelIds.map(c => `<#${c}>`).join(', ')}` : '✅ All channels now count toward the chat leaderboard.', embeds: [], components: [] });
  }

  // ── INVITE CREDIT TIERS ───────────────────────────────────────────────────────
  if (id === 'admin_invite_tiers') {
    const tiers = await getTiers(guildId);
    const modal = new ModalBuilder().setCustomId('modal_invite_tiers').setTitle('Invite Credit Tiers');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('tiers').setLabel('One tier per line: credits:reward').setStyle(TextInputStyle.Paragraph).setRequired(true)
          .setValue(tiers.map(t => `${t.credits}:${t.reward}`).join('\n'))
          .setPlaceholder('20:$3\n50:$8\n100:$18\n200:$40')
      ),
    );
    return interaction.showModal(modal);
  }

  if (id === 'modal_invite_tiers') {
    const raw = interaction.fields.getTextInputValue('tiers');
    const tiers = raw.split('\n').map(l => l.trim()).filter(Boolean).map(line => {
      const [creditsStr, ...rewardParts] = line.split(':');
      return { credits: parseInt(creditsStr, 10), reward: rewardParts.join(':').trim() };
    }).filter(t => t.credits > 0 && t.reward).sort((a, b) => a.credits - b.credits);

    if (!tiers.length) return safeReply(interaction, { content: '❌ Could not parse any valid tiers. Use the format `credits:reward`, one per line.' });

    await InviteTierConfig.findOneAndUpdate({ guildId }, { guildId, tiers }, { upsert: true });
    return safeReply(interaction, { content: `✅ Saved ${tiers.length} invite credit tier(s):\n${tiers.map(t => `• **${t.credits}** credits → **${t.reward}**`).join('\n')}` });
  }

  // ── TOGGLE PUBLIC INVITE ANNOUNCEMENTS ───────────────────────────────────────
  if (id === 'admin_toggle_public_invite') {
    const config = await ServerConfig.findOne({ guildId }) || {};
    const newValue = !config.publicInviteAnnounce;
    await ServerConfig.findOneAndUpdate({ guildId }, { guildId, publicInviteAnnounce: newValue }, { upsert: true });
    return safeReply(interaction, { content: `✅ Public invite-claim announcements are now **${newValue ? 'ENABLED' : 'DISABLED'}**.` });
  }

  // ── ANNOUNCEMENT (send now / schedule) ────────────────────────────────────────
  if (id === 'admin_announce') {
    const modal = new ModalBuilder().setCustomId('modal_announce').setTitle('Create Announcement');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('Title').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('Description').setStyle(TextInputStyle.Paragraph).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('color').setLabel('Color (hex)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('#5865F2')),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('image_url').setLabel('Image URL (optional)').setStyle(TextInputStyle.Short).setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('button').setLabel('Button (text|url) or leave blank').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('Click Here|https://...')),
    );
    return interaction.showModal(modal);
  }

  if (id === 'modal_announce') {
    const title = interaction.fields.getTextInputValue('title');
    const description = interaction.fields.getTextInputValue('description');
    const color = interaction.fields.getTextInputValue('color') || '#5865F2';
    const imageUrl = interaction.fields.getTextInputValue('image_url');
    const buttonRaw = interaction.fields.getTextInputValue('button');
    let buttonText = '', buttonUrl = '';
    if (buttonRaw && buttonRaw.includes('|')) { [buttonText, buttonUrl] = buttonRaw.split('|').map(s => s.trim()); }
    setState(userId, { ann_title: title, ann_desc: description, ann_color: color, ann_image: imageUrl, ann_btn_text: buttonText, ann_btn_url: buttonUrl });
    const embed = new EmbedBuilder().setTitle('Select Channel').setColor('#5865F2').setDescription('Where should this announcement be sent?');
    const row = new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('announce_channel_select').setPlaceholder('Select channel'));
    return safeReply(interaction, { embeds: [embed], components: [row] });
  }

  if (id === 'announce_channel_select') {
    const channelId = interaction.values[0];
    setState(userId, { ann_channel: channelId });
    const embed = new EmbedBuilder().setTitle('Send or Schedule?').setColor('#5865F2').setDescription('Send now or schedule for later?');
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('announce_send_now').setLabel('Send Now').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('announce_schedule').setLabel('Schedule').setStyle(ButtonStyle.Secondary),
    );
    return interaction.update({ embeds: [embed], components: [row] });
  }

  if (id === 'announce_send_now') {
    const s = getState(userId);
    const ch = interaction.guild.channels.cache.get(s.ann_channel);
    if (!ch) return safeReply(interaction, { content: '❌ Channel not found.' });
    const embed = new EmbedBuilder().setTitle(s.ann_title).setDescription(s.ann_desc).setColor(s.ann_color).setTimestamp();
    if (s.ann_image) embed.setImage(s.ann_image);
    const components = [];
    if (s.ann_btn_text && s.ann_btn_url) {
      components.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel(s.ann_btn_text).setStyle(ButtonStyle.Link).setURL(s.ann_btn_url)));
    }
    await ch.send({ embeds: [embed], components });
    clearState(userId);
    return interaction.update({ content: `✅ Announcement sent to <#${s.ann_channel}>!`, embeds: [], components: [] });
  }

  if (id === 'announce_schedule') {
    const modal = new ModalBuilder().setCustomId('modal_announce_schedule').setTitle('Schedule Announcement');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('date').setLabel('Date (YYYY-MM-DD)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('2025-12-31')),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('time').setLabel('Time (HH:MM in UTC)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('14:00')),
    );
    return interaction.showModal(modal);
  }

  if (id === 'modal_announce_schedule') {
    const s = getState(userId);
    const date = interaction.fields.getTextInputValue('date');
    const time = interaction.fields.getTextInputValue('time');
    const scheduledFor = new Date(`${date}T${time}:00.000Z`);
    if (isNaN(scheduledFor.getTime()) || scheduledFor <= new Date()) {
      return safeReply(interaction, { content: '❌ Invalid date/time. Use YYYY-MM-DD and HH:MM (UTC). Make sure it\'s in the future.' });
    }
    await Announcement.create({ guildId, title: s.ann_title, description: s.ann_desc, color: s.ann_color, imageUrl: s.ann_image, buttonText: s.ann_btn_text, buttonUrl: s.ann_btn_url, channelId: s.ann_channel, scheduledFor });
    clearState(userId);
    return safeReply(interaction, { content: `✅ Announcement scheduled for **${scheduledFor.toUTCString()}**` });
  }

  // ── SCHEDULE POST ────────────────────────────────────────────────────────────
  if (id === 'admin_schedule') {
    const modal = new ModalBuilder().setCustomId('modal_schedule_post').setTitle('Schedule a Post');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('content').setLabel('Post Content').setStyle(TextInputStyle.Paragraph).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('image_url').setLabel('Image URL (optional)').setStyle(TextInputStyle.Short).setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('date').setLabel('Date (YYYY-MM-DD)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('2025-12-31')),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('time').setLabel('Time (HH:MM UTC)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('14:00')),
    );
    return interaction.showModal(modal);
  }

  if (id === 'modal_schedule_post') {
    const content = interaction.fields.getTextInputValue('content');
    const imageUrl = interaction.fields.getTextInputValue('image_url');
    const date = interaction.fields.getTextInputValue('date');
    const time = interaction.fields.getTextInputValue('time');
    setState(userId, { sp_content: content, sp_image: imageUrl, sp_date: date, sp_time: time });
    const embed = new EmbedBuilder().setTitle('Select Channel').setColor('#5865F2').setDescription('Select channel for this scheduled post:');
    const row = new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('sched_post_channel').setPlaceholder('Select channel'));
    return safeReply(interaction, { embeds: [embed], components: [row] });
  }

  if (id === 'sched_post_channel') {
    const channelId = interaction.values[0];
    const s = getState(userId);
    const scheduledFor = new Date(`${s.sp_date}T${s.sp_time}:00.000Z`);
    if (isNaN(scheduledFor.getTime()) || scheduledFor <= new Date()) {
      return interaction.update({ content: '❌ Invalid date/time or it\'s in the past.', embeds: [], components: [] });
    }
    await ScheduledPost.create({ guildId, content: s.sp_content, imageUrl: s.sp_image, channelId, scheduledFor });
    clearState(userId);
    return interaction.update({ content: `✅ Post scheduled for **${scheduledFor.toUTCString()}** in <#${channelId}>`, embeds: [], components: [] });
  }

  // ── LEADERBOARD ──────────────────────────────────────────────────────────────
  if (id === 'admin_leaderboard') {
    const embed = new EmbedBuilder().setTitle('📊 Publish Invite Leaderboard').setColor('#F5A623')
      .setDescription('Select the channel where the live Top 10 invite leaderboard should be posted. It refreshes automatically once every 24 hours (edits the same message — no spam).');
    const row = new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('leaderboard_channel_select').setPlaceholder('Select channel'));
    return safeReply(interaction, { embeds: [embed], components: [row] });
  }

  if (id === 'leaderboard_channel_select') {
    const channelId = interaction.values[0];
    const result = await publishLeaderboard(client, guildId, channelId);
    if (!result.ok) return interaction.update({ content: `❌ ${result.reason}`, embeds: [], components: [] });
    return interaction.update({ content: `✅ Leaderboard published in <#${channelId}>. It will auto-refresh every 24 hours.`, embeds: [], components: [] });
  }

  // ── PUBLISH INVITE PANEL (one button per reward tier, pulls live config) ────
  if (id === 'admin_publish_invite_panel') {
    const embed = new EmbedBuilder().setTitle('🎟️ Publish Invite Panel').setColor('#5865F2')
      .setDescription('Select the channel to post the invite rewards panel in. A button is generated automatically for every configured tier — nothing to type.');
    const row = new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('publish_invite_panel_channel_select').setPlaceholder('Select channel').addChannelTypes(ChannelType.GuildText));
    return safeReply(interaction, { embeds: [embed], components: [row] });
  }

  if (id === 'publish_invite_panel_channel_select') {
    const channelId = interaction.values[0];
    const ch = interaction.guild.channels.cache.get(channelId);
    if (!ch) return interaction.update({ content: '❌ Channel not found.', embeds: [], components: [] });

    const tiers = await getTiers(guildId);
    const panelEmbed = new EmbedBuilder()
      .setTitle('🎟️ Invite Rewards')
      .setColor('#5865F2')
      .setDescription(
        'Invite real, active members and earn credits for real rewards! Pick a tier below to claim once you\'re eligible, ' +
        'or use the buttons at the bottom to check your progress.\n\n' +
        tiers.map(t => `**${t.reward}** — ${t.credits} credits`).join('\n')
      )
      .setFooter({ text: 'An invite becomes valid once the member verifies, stays 7+ days, sends 10+ valid messages, and their account is 30+ days old.' });

    // One button per tier (chunked into rows of 5), plus a final row for progress/apply.
    const tierButtons = tiers.slice(0, 20).map(t =>
      new ButtonBuilder().setCustomId(`panel_claim_tier_${t.credits}`).setLabel(`${t.reward} - ${t.credits} Invites`).setStyle(ButtonStyle.Success)
    );
    const rows = [];
    for (let i = 0; i < tierButtons.length && rows.length < 4; i += 5) {
      rows.push(new ActionRowBuilder().addComponents(tierButtons.slice(i, i + 5)));
    }
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('panel_progress').setLabel('📊 Check Your Progress').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('panel_claim_invite').setLabel('🎟️ Apply for Reward').setStyle(ButtonStyle.Primary),
    ));

    await ch.send({ embeds: [panelEmbed], components: rows });
    return interaction.update({ content: `✅ Invite panel published in <#${channelId}> with ${tiers.length} tier button(s)!`, embeds: [], components: [] });
  }

  // ── PUBLISH CHAT REWARD PANEL (Check Progress + Apply for Reward only) ──────
  if (id === 'admin_publish_chat_panel') {
    const embed = new EmbedBuilder().setTitle('💬 Publish Chat Reward Panel').setColor('#5865F2')
      .setDescription('Select the channel to post the chat leaderboard panel in. It generates automatically from your current weekly/monthly settings.');
    const row = new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('publish_chat_panel_channel_select').setPlaceholder('Select channel').addChannelTypes(ChannelType.GuildText));
    return safeReply(interaction, { embeds: [embed], components: [row] });
  }

  if (id === 'publish_chat_panel_channel_select') {
    const channelId = interaction.values[0];
    const ch = interaction.guild.channels.cache.get(channelId);
    if (!ch) return interaction.update({ content: '❌ Channel not found.', embeds: [], components: [] });

    const config = await ServerConfig.findOne({ guildId }) || {};
    const weeklyMin = config.weeklyMinMessages ?? 100;
    const monthlyMin = config.monthlyMinMessages ?? 400;
    const weeklyReward = config.weeklyReward || '$5 USDT or $5 Discord Nitro';
    const monthlyReward = config.monthlyReward || '$20 USDT or $20 Discord Nitro';

    const panelEmbed = new EmbedBuilder()
      .setTitle('💬 Chat Rewards')
      .setColor('#F5A623')
      .setDescription(
        `Stay active and climb the leaderboard for a chance to win!\n\n` +
        `**Weekly:** ${weeklyMin}+ valid messages → **${weeklyReward}** (resets every Monday)\n` +
        `**Monthly:** ${monthlyMin}+ valid messages → **${monthlyReward}** (resets on the 1st)\n\n` +
        `Winners are picked and announced **automatically** — check your progress below to see where you stand.`
      );
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('panel_progress').setLabel('📊 Check Your Progress').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('panel_chat_apply').setLabel('✋ Apply for Reward').setStyle(ButtonStyle.Primary),
    );

    await ch.send({ embeds: [panelEmbed], components: [row] });
    return interaction.update({ content: `✅ Chat reward panel published in <#${channelId}>!`, embeds: [], components: [] });
  }

  // ── VIEW CURRENT SETTINGS ──────────────────────────────────────────────────────
  if (id === 'admin_view_settings') {
    const config = await ServerConfig.findOne({ guildId }) || {};
    const tiers = await getTiers(guildId);
    const embed = new EmbedBuilder().setTitle('⚙️ Current Settings').setColor('#5865F2').addFields(
      { name: 'Roles', value: `Admin: ${config.adminRoleId ? `<@&${config.adminRoleId}>` : 'Not set'}\nStaff: ${config.staffRoleId ? `<@&${config.staffRoleId}>` : 'Not set'}\nVerified: ${config.verifiedRoleId ? `<@&${config.verifiedRoleId}>` : 'Not set'}`, inline: true },
      { name: 'Channels', value: `Ticket Category: ${config.ticketCategoryId || 'Not set'}\nAnnounce: ${config.chatAnnounceChannelId ? `<#${config.chatAnnounceChannelId}>` : 'Not set'}\nApproved: ${config.approvedChannelIds?.length ? config.approvedChannelIds.map(c => `<#${c}>`).join(', ') : 'All channels'}`, inline: true },
      { name: 'Chat Rewards', value: `Weekly: ${config.weeklyMinMessages ?? 100}+ msgs → ${config.weeklyReward || '$5 USDT or $5 Discord Nitro'}\nMonthly: ${config.monthlyMinMessages ?? 400}+ msgs → ${config.monthlyReward || '$20 USDT or $20 Discord Nitro'}`, inline: false },
      { name: 'Invite Credit Tiers', value: tiers.map(t => `${t.credits} credits → ${t.reward}`).join('\n'), inline: false },
      { name: 'Public Invite Announcements', value: config.publicInviteAnnounce ? 'Enabled' : 'Disabled', inline: false },
    );
    return safeReply(interaction, { embeds: [embed] });
  }
}

module.exports = { handleInteraction, getTiers };

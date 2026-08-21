const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  ChannelSelectMenuBuilder, ChannelType, PermissionsBitField
} = require('discord.js');
const {
  isAdmin, isStaff, generateId, nextMonday, placeLabel, rewardLabel, rewardsFor,
} = require('../utils/helpers');
const {
  ServerConfig, InviteTierConfig, UserInvite, RewardTicket, Announcement, ScheduledPost,
} = require('../models');
const { publishLeaderboard } = require('./leaderboard');
const { unmuteMember } = require('./moderation');

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
      content: '🏆 Chat rewards are awarded **automatically** — the top 3 chatters each week and month are announced and given a private ticket, no application needed.\n\nUse **📊 Check Your Progress** to see exactly where you rank.',
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

    const periodNoun = ticket.type === 'chat_weekly' ? 'Weekly' : 'Monthly';
    const heading = ticket.place ? `${placeLabel(ticket.place)} ${periodNoun}` : periodNoun;
    const embed = new EmbedBuilder()
      .setTitle(`${heading} Chat Reward — ${ticketId}`)
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
            .setDescription(`<@${ticket.userId}> just got **${ticket.rewardLabel}** for **${ticket.tierCredits}** invites! 🚀 Keep growing!`)
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

  // ── UNMUTE FROM THE MOD LOG (staff only) ─────────────────────────────────────
  if (id.startsWith('mod_unmute_')) {
    const targetId = id.replace('mod_unmute_', '');
    const member = await resolveMember(interaction);
    if (!member || !await isStaff(member, guildId)) {
      return safeReply(interaction, { content: '❌ Only staff can unmute members.' });
    }
    const result = await unmuteMember(interaction.guild, targetId);
    if (!result.ok) return safeReply(interaction, { content: `❌ ${result.reason}` });

    await interaction.message.edit({ components: [] }).catch(() => {});
    return safeReply(interaction, {
      content: `🔊 <@${targetId}> has been unmuted and their warnings cleared by <@${userId}>.` +
        (result.wasInServer ? '' : ' (They are no longer in the server — warnings cleared anyway.)'),
    });
  }

  // ── ADMIN GATE ────────────────────────────────────────────────────────────────
  const ADMIN_PREFIXES = ['admin_', 'modal_admin_config', 'modal_chat_config', 'modal_invite_tiers', 'modal_chat_start_custom', 'modal_add_credits', 'announce_channel_config_select', 'approved_channels_select', 'modlog_channel_select', 'publish_invite_panel_', 'publish_chat_panel_', 'announce_', 'sched_post_', 'leaderboard_', 'modal_announce', 'modal_schedule_post'];
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

  // ── CHAT REWARD THRESHOLDS + PLACE PAYOUTS ───────────────────────────────────
  if (id === 'admin_chat_config') {
    const config = await ServerConfig.findOne({ guildId }) || {};
    const modal = new ModalBuilder().setCustomId('modal_chat_config').setTitle('Chat Leaderboard Rewards');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('weekly_min').setLabel('Weekly Minimum Valid Messages').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(config.weeklyMinMessages ?? 100))),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('weekly_rewards').setLabel('Weekly payouts, 1st to last').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('$5, $3, $2').setValue(rewardsFor(config, 'weekly').join(', '))),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('monthly_min').setLabel('Monthly Minimum Valid Messages').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(config.monthlyMinMessages ?? 400))),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('monthly_rewards').setLabel('Monthly payouts, 1st to last').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('$25, $10, $5').setValue(rewardsFor(config, 'monthly').join(', '))),
    );
    return interaction.showModal(modal);
  }

  if (id === 'modal_chat_config') {
    const parsePayouts = raw => raw.split(',').map(s => s.trim()).filter(Boolean);
    const weeklyRewards = parsePayouts(interaction.fields.getTextInputValue('weekly_rewards'));
    const monthlyRewards = parsePayouts(interaction.fields.getTextInputValue('monthly_rewards'));
    if (!weeklyRewards.length || !monthlyRewards.length) {
      return safeReply(interaction, { content: '❌ Payouts can\'t be empty. Enter them comma-separated, best place first — for example `$5, $3, $2`.' });
    }

    const weeklyMin = parseInt(interaction.fields.getTextInputValue('weekly_min')) || 100;
    const monthlyMin = parseInt(interaction.fields.getTextInputValue('monthly_min')) || 400;
    await ServerConfig.findOneAndUpdate(
      { guildId },
      { guildId, weeklyMinMessages: weeklyMin, monthlyMinMessages: monthlyMin, weeklyRewards, monthlyRewards },
      { upsert: true }
    );
    const summarise = list => list.map((r, i) => `${placeLabel(i + 1)} → **${r}**`).join(', ');
    return safeReply(interaction, {
      content: `✅ Chat reward settings saved.\n\n**Weekly** (min. ${weeklyMin} msgs): ${summarise(weeklyRewards)}\n**Monthly** (min. ${monthlyMin} msgs): ${summarise(monthlyRewards)}`,
    });
  }

  // ── SPAM DETECTION + MOD LOG ─────────────────────────────────────────────────
  if (id === 'admin_toggle_spam') {
    const config = await ServerConfig.findOne({ guildId }) || {};
    const newValue = !(config.spamDetectionEnabled !== false);
    await ServerConfig.findOneAndUpdate({ guildId }, { guildId, spamDetectionEnabled: newValue }, { upsert: true });
    return safeReply(interaction, {
      content: `✅ Spam detection is now **${newValue ? 'ENABLED' : 'DISABLED'}**.` +
        (newValue ? ' Members who farm messages get a DM warning, and a 24-hour mute on the third strike.' : ''),
    });
  }

  if (id === 'admin_set_modlog') {
    const embed = new EmbedBuilder().setTitle('🛡️ Set Mod Log Channel').setColor('#5865F2')
      .setDescription('Spam warnings and mutes will be logged here, each with an **Unmute** button for staff.');
    const row = new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('modlog_channel_select').setPlaceholder('Select channel').addChannelTypes(ChannelType.GuildText));
    return safeReply(interaction, { embeds: [embed], components: [row] });
  }

  if (id === 'modlog_channel_select') {
    const channelId = interaction.values[0];
    await ServerConfig.findOneAndUpdate({ guildId }, { guildId, modLogChannelId: channelId }, { upsert: true });
    return interaction.update({ content: `✅ Spam warnings and mutes will be logged in <#${channelId}>.`, embeds: [], components: [] });
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

  // ── SET ENGAGEMENT (CHAT) TRACKING START TIME ────────────────────────────────
  if (id === 'admin_chat_start') {
    const config = await ServerConfig.findOne({ guildId }) || {};
    const embed = new EmbedBuilder().setTitle('⏱️ Set Engagement Start Time').setColor('#5865F2')
      .setDescription(
        `Messages sent before this time won't count toward the chat leaderboard — this stops this week from being an unfair partial week.\n\n` +
        `Current setting: ${config.chatTrackingStartAt ? `**${new Date(config.chatTrackingStartAt).toUTCString()}**` : '**Starts immediately (no restriction)**'}`
      );
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('admin_chat_start_monday').setLabel('Start Next Monday 00:00 UTC').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('admin_chat_start_custom').setLabel('Custom Date/Time').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('admin_chat_start_now').setLabel('Start Immediately').setStyle(ButtonStyle.Success),
    );
    return safeReply(interaction, { embeds: [embed], components: [row] });
  }

  if (id === 'admin_chat_start_monday') {
    const monday = nextMonday();
    await ServerConfig.findOneAndUpdate({ guildId }, { guildId, chatTrackingStartAt: monday }, { upsert: true });
    return safeReply(interaction, { content: `✅ Engagement tracking will start **${monday.toUTCString()}**. Messages before that won't count.` });
  }

  if (id === 'admin_chat_start_now') {
    await ServerConfig.findOneAndUpdate({ guildId }, { guildId, chatTrackingStartAt: null }, { upsert: true });
    return safeReply(interaction, { content: '✅ Engagement tracking is active immediately — no start-time restriction.' });
  }

  if (id === 'admin_chat_start_custom') {
    const modal = new ModalBuilder().setCustomId('modal_chat_start_custom').setTitle('Custom Engagement Start Time');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('date').setLabel('Date (YYYY-MM-DD)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('2026-08-24')),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('time').setLabel('Time (HH:MM in UTC)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('00:00')),
    );
    return interaction.showModal(modal);
  }

  if (id === 'modal_chat_start_custom') {
    const date = interaction.fields.getTextInputValue('date');
    const time = interaction.fields.getTextInputValue('time');
    const startAt = new Date(`${date}T${time}:00.000Z`);
    if (isNaN(startAt.getTime())) {
      return safeReply(interaction, { content: '❌ Invalid date/time. Use YYYY-MM-DD and HH:MM (UTC).' });
    }
    await ServerConfig.findOneAndUpdate({ guildId }, { guildId, chatTrackingStartAt: startAt }, { upsert: true });
    return safeReply(interaction, { content: `✅ Engagement tracking will start **${startAt.toUTCString()}**. Messages before that won't count.` });
  }

  // ── BULK ADD INVITE CREDITS (manual override for staff) ─────────────────────
  if (id === 'admin_add_credits') {
    const modal = new ModalBuilder().setCustomId('modal_add_credits').setTitle('Add Invite Credits');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('lines').setLabel('One per line: UserID Credits').setStyle(TextInputStyle.Paragraph).setRequired(true)
          .setPlaceholder('123456789012345678 20\n987654321098765432 50')
      ),
    );
    return interaction.showModal(modal);
  }

  if (id === 'modal_add_credits') {
    const raw = interaction.fields.getTextInputValue('lines');
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    const results = [];
    for (const line of lines) {
      const [targetId, creditsStr] = line.split(/\s+/);
      const credits = parseInt(creditsStr, 10);
      if (!targetId || !/^\d{15,25}$/.test(targetId) || !credits || credits <= 0) {
        results.push(`❌ Skipped invalid line: \`${line}\``);
        continue;
      }
      await UserInvite.findOneAndUpdate(
        { guildId, userId: targetId },
        { guildId, userId: targetId, $inc: { grantedCredits: credits }, $set: { updatedAt: new Date() } },
        { upsert: true }
      );
      results.push(`✅ <@${targetId}> +${credits} credits`);
    }
    return safeReply(interaction, { content: `**Bulk credit update:**\n${results.join('\n')}` });
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

    const config = await ServerConfig.findOne({ guildId }) || {};
    const verifiedRole = config.verifiedRoleId ? `<@&${config.verifiedRoleId}>` : 'the **member** role';
    const tiers = await getTiers(guildId);
    const panelEmbed = new EmbedBuilder()
      .setTitle('🎟️ Invite Rewards')
      .setColor('#5865F2')
      .setDescription(
        'Invite real, active members and earn credits for real rewards! Pick a tier below to claim once you\'re eligible, ' +
        'or use the buttons at the bottom to check your progress.\n\n' +
        tiers.map(t => `**${t.reward}** — ${t.credits} credits`).join('\n')
      )
      .addFields({
        name: '✅ What counts as a valid invite',
        value:
          `• The member must be **verified** — they need ${verifiedRole}\n` +
          '• Their Discord account must have been **30+ days old** when they joined\n' +
          '• They must still be in the server\n\n' +
          '**Never counted:** accounts under 30 days old (logged as **fake invites**) and anyone **rejoining** the server.',
        inline: false,
      })
      .setFooter({ text: 'Check your real, fake, and rejoined invites any time with /invite' });

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
    const payoutLines = period => rewardsFor(config, period)
      .map((amount, i) => `${placeLabel(i + 1)} — **${rewardLabel(amount)}**`).join('\n');

    const panelEmbed = new EmbedBuilder()
      .setTitle('💬 Chat Rewards')
      .setColor('#F5A623')
      .setDescription(
        'Chat normally, climb the leaderboard, get paid. The **top 3 most active members** are rewarded ' +
        'every week and every month — winners are picked and announced automatically, so there\'s nothing to apply for.'
      )
      .addFields(
        {
          name: `🗓️ Weekly — resets every Monday 00:00 UTC`,
          value: `${payoutLines('weekly')}\n\n*Qualify with ${weeklyMin}+ valid messages.*`,
          inline: true,
        },
        {
          name: `📅 Monthly — resets on the 1st`,
          value: `${payoutLines('monthly')}\n\n*Qualify with ${monthlyMin}+ valid messages.*`,
          inline: true,
        },
        {
          name: '✅ What counts as a valid message',
          value:
            '• At least 5 real characters — not just emojis, symbols or mentions\n' +
            '• Not a repeat of something you just said\n' +
            '• Maximum one counted message every 15 seconds\n' +
            '• Deleted messages lose their point',
          inline: false,
        },
        {
          name: '🚫 Spam is not tolerated',
          value:
            'Flooding the chat, repeating yourself, or recycling the same few phrases to farm the leaderboard is **detected automatically**.\n' +
            'Those messages **never count**, and you\'ll get a DM warning. **Three warnings = a 24-hour mute.**',
          inline: false,
        },
      )
      .setFooter({ text: 'The minimum only makes you eligible — your rank decides your reward.' });
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
      {
        name: 'Chat Rewards',
        value:
          `**Weekly** (min. ${config.weeklyMinMessages ?? 100} msgs): ${rewardsFor(config, 'weekly').map((r, i) => `${placeLabel(i + 1)} ${r}`).join(' · ')}\n` +
          `**Monthly** (min. ${config.monthlyMinMessages ?? 400} msgs): ${rewardsFor(config, 'monthly').map((r, i) => `${placeLabel(i + 1)} ${r}`).join(' · ')}`,
        inline: false,
      },
      { name: 'Engagement Start Time', value: config.chatTrackingStartAt ? new Date(config.chatTrackingStartAt).toUTCString() : 'Immediate (no restriction)', inline: false },
      { name: 'Invite Credit Tiers', value: tiers.map(t => `${t.credits} credits → ${t.reward}`).join('\n'), inline: false },
      { name: 'Public Invite Announcements', value: config.publicInviteAnnounce ? 'Enabled' : 'Disabled', inline: false },
      {
        name: 'Spam Detection',
        value: `${config.spamDetectionEnabled === false ? 'Disabled' : 'Enabled'} — 3 warnings = 24h mute\nMod log: ${config.modLogChannelId ? `<#${config.modLogChannelId}>` : 'Not set'}`,
        inline: false,
      },
    );
    return safeReply(interaction, { embeds: [embed] });
  }
}

module.exports = { handleInteraction, getTiers };

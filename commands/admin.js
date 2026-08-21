const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { isAdmin } = require('../utils/helpers');
const { ServerConfig } = require('../models');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('admin')
    .setDescription('Admin panel for reward bot configuration')
    .setDefaultMemberPermissions(8),
  async execute(interaction) {
    if (!await isAdmin(interaction.member, interaction.guild.id)) {
      return interaction.reply({ content: '❌ You do not have permission to use this.', ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });
    const config = await ServerConfig.findOne({ guildId: interaction.guild.id }) || {};

    const embed = new EmbedBuilder()
      .setTitle('⚙️ Admin Panel')
      .setColor('#5865F2')
      .setDescription('Configure the chat leaderboard, invite credit tiers, announcements, and server roles.')
      .addFields(
        { name: 'Roles', value: `Admin: ${config.adminRoleId ? `<@&${config.adminRoleId}>` : 'Not set'}\nStaff: ${config.staffRoleId ? `<@&${config.staffRoleId}>` : 'Not set'}\nVerified: ${config.verifiedRoleId ? `<@&${config.verifiedRoleId}>` : 'Not set'}`, inline: true },
        { name: 'Announce Channel', value: config.chatAnnounceChannelId ? `<#${config.chatAnnounceChannelId}>` : 'Not set', inline: true },
        { name: 'Public Invite Announce', value: config.publicInviteAnnounce ? 'Enabled ✅' : 'Disabled ❌', inline: true },
        { name: 'Engagement Start', value: config.chatTrackingStartAt ? `${new Date(config.chatTrackingStartAt).toUTCString()}` : 'Immediate (no restriction)', inline: true },
        { name: 'Spam Detection', value: config.spamDetectionEnabled === false ? 'Disabled ❌' : 'Enabled ✅', inline: true },
        { name: 'Mod Log', value: config.modLogChannelId ? `<#${config.modLogChannelId}>` : 'Not set', inline: true },
      );

    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('admin_chat_config').setLabel('💬 Chat Reward Settings').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('admin_invite_tiers').setLabel('🎟️ Invite Credit Tiers').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('admin_set_approved_channels').setLabel('📋 Approved Channels').setStyle(ButtonStyle.Secondary),
    );
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('admin_set_announce_channel').setLabel('📢 Announce Channel').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('admin_toggle_public_invite').setLabel('🔁 Toggle Public Invite Announce').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('admin_config').setLabel('🔧 Server Roles').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('admin_chat_start').setLabel('⏱️ Set Engagement Start').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('admin_add_credits').setLabel('➕ Add Invite Credits').setStyle(ButtonStyle.Secondary),
    );
    const row3 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('admin_leaderboard').setLabel('📊 Publish Invite Leaderboard').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('admin_announce').setLabel('📣 Announcement').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('admin_schedule').setLabel('🗓️ Schedule Post').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('admin_view_settings').setLabel('👁️ View Settings').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('admin_set_modlog').setLabel('🛡️ Mod Log Channel').setStyle(ButtonStyle.Secondary),
    );
    const row4 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('admin_publish_invite_panel').setLabel('🎟️ Publish Invite Panel').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('admin_publish_chat_panel').setLabel('💬 Publish Chat Reward Panel').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('admin_toggle_spam').setLabel('🚫 Toggle Spam Detection').setStyle(ButtonStyle.Secondary),
    );

    return interaction.editReply({ embeds: [embed], components: [row1, row2, row3, row4] });
  }
};

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { UserWarning } = require('../models');
const { isStaff } = require('../utils/helpers');
const { unmuteMember, clearWarnings, WARNING_LIMIT } = require('../handlers/moderation');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('warnings')
    // Deliberately not permission-gated at the Discord level: the staff role is
    // configured in /admin and may not carry any moderation permission bits.
    .setDescription('Staff — review spam warnings, clear them, or unmute a member')
    .addSubcommand(sub => sub
      .setName('view')
      .setDescription('Show a member\'s spam warnings and mute status')
      .addUserOption(opt => opt.setName('user').setDescription('The member to check').setRequired(true)))
    .addSubcommand(sub => sub
      .setName('clear')
      .setDescription('Reset a member\'s warning count to zero')
      .addUserOption(opt => opt.setName('user').setDescription('The member to clear').setRequired(true)))
    .addSubcommand(sub => sub
      .setName('unmute')
      .setDescription('Lift a member\'s mute and clear their warnings')
      .addUserOption(opt => opt.setName('user').setDescription('The member to unmute').setRequired(true))),
  async execute(interaction) {
    if (!await isStaff(interaction.member, interaction.guild.id)) {
      return interaction.reply({ content: '❌ Staff only.', ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });

    const guildId = interaction.guild.id;
    const target = interaction.options.getUser('user');
    const sub = interaction.options.getSubcommand();

    if (sub === 'clear') {
      await clearWarnings(guildId, target.id);
      return interaction.editReply({ content: `✅ Cleared <@${target.id}>'s warning count. Their mute, if any, is untouched — use \`/warnings unmute\` for that.` });
    }

    if (sub === 'unmute') {
      const result = await unmuteMember(interaction.guild, target.id);
      if (!result.ok) return interaction.editReply({ content: `❌ ${result.reason}` });
      return interaction.editReply({
        content: `🔊 <@${target.id}> has been unmuted and their warnings cleared.` +
          (result.wasInServer ? '' : ' (They are no longer in the server — warnings cleared anyway.)'),
      });
    }

    const doc = await UserWarning.findOne({ guildId, userId: target.id });
    if (!doc || !doc.totalWarnings) {
      return interaction.editReply({ content: `✅ <@${target.id}> has no spam warnings on record.` });
    }

    const member = await interaction.guild.members.fetch(target.id).catch(() => null);
    const timeoutUntil = member?.communicationDisabledUntil;
    const muted = timeoutUntil && timeoutUntil > new Date();

    const recent = doc.history.slice(-5).reverse()
      .map(h => `• <t:${Math.floor(new Date(h.at).getTime() / 1000)}:R> — ${h.reason}`)
      .join('\n') || '_None recorded._';

    const embed = new EmbedBuilder()
      .setTitle(`⚠️ Spam Warnings — ${target.username}`)
      .setColor(muted ? '#ED4245' : '#F5A623')
      .setThumbnail(target.displayAvatarURL())
      .addFields(
        { name: 'Current strikes', value: `**${doc.count}/${WARNING_LIMIT}**`, inline: true },
        { name: 'Warnings all-time', value: `**${doc.totalWarnings}**`, inline: true },
        { name: 'Times muted', value: `**${doc.muteCount || 0}**`, inline: true },
        {
          name: 'Status',
          value: muted ? `🔇 Muted until <t:${Math.floor(timeoutUntil.getTime() / 1000)}:F>` : '🔊 Not muted',
          inline: false,
        },
        { name: 'Recent flags', value: recent, inline: false },
      )
      .setFooter({ text: 'Strikes reset after 7 clean days, and after every mute.' })
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  }
};

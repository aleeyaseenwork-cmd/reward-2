const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { UserInvite, ServerConfig } = require('../models');
const { computeInviteStats, creditBalance, isStaff, progressBar } = require('../utils/helpers');
const { getTiers } = require('../handlers/interactions');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('invite')
    .setDescription('Check your invites — real, fake, and rejoins')
    .addUserOption(opt => opt.setName('user').setDescription('Staff only — look up another member').setRequired(false)),
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const guildId = interaction.guild.id;

    const requested = interaction.options.getUser('user');
    let target = interaction.user;
    if (requested && requested.id !== interaction.user.id) {
      if (!await isStaff(interaction.member, guildId)) {
        return interaction.editReply({ content: '❌ Only staff can look up another member\'s invites.' });
      }
      target = requested;
    }

    const doc = await UserInvite.findOne({ guildId, userId: target.id });
    const stats = computeInviteStats(doc);
    const { available, reserved, consumed } = creditBalance(doc);
    const [config, tiers] = await Promise.all([
      ServerConfig.findOne({ guildId }),
      getTiers(guildId),
    ]);
    const nextTier = tiers.find(t => t.credits > available) || null;

    const embed = new EmbedBuilder()
      .setTitle(`👥 Invites — ${target.username}`)
      .setColor('#F5A623')
      .setThumbnail(target.displayAvatarURL())
      .setDescription(
        `**${stats.real}** real invite${stats.real === 1 ? '' : 's'} — these are the ones that count.`
      )
      .addFields(
        {
          name: '📊 Breakdown',
          value:
            `✅ **Real:** ${stats.real} — verified members who count\n` +
            `⏳ **Pending:** ${stats.pending} — joined but not verified yet\n` +
            `🚫 **Fake:** ${stats.fake} — account under 30 days old at join\n` +
            `🔁 **Rejoins:** ${stats.rejoins} — already been in the server, never counted\n` +
            `🚪 **Left:** ${stats.left} — left the server\n\n` +
            `**Total joins tracked:** ${stats.total}`,
          inline: false,
        },
        {
          name: '🎟️ Credits',
          value:
            `✅ Available: **${available}**\n` +
            `⏳ Reserved (pending claim): **${reserved}**\n` +
            `💰 Consumed (already paid): **${consumed}**`,
          inline: false,
        },
      );

    if (nextTier) {
      embed.addFields({
        name: '🎯 Next Reward',
        value: `${progressBar(available, nextTier.credits)} **${available}/${nextTier.credits}** — ${nextTier.credits - available} more for **${nextTier.reward}**`,
        inline: false,
      });
    } else if (tiers.length) {
      embed.addFields({ name: '🎯 Next Reward', value: '🎉 You qualify for every tier — use `/claim invite` to redeem.', inline: false });
    }

    if (stats.pending > 0) {
      const verifiedRole = config?.verifiedRoleId ? `<@&${config.verifiedRoleId}>` : 'the member role';
      embed.addFields({
        name: '💡 Tip',
        value: `${stats.pending} of these invites are waiting on ${verifiedRole} — nudge them to verify.`,
        inline: false,
      });
    }
    embed.setFooter({ text: 'An invite counts once the member is verified and their account was 30+ days old at join.' });

    return interaction.editReply({ embeds: [embed] });
  }
};

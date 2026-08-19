const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const { UserInvite } = require('../models');
const { getTiers } = require('../handlers/interactions');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('claim')
    .setDescription('Claim your rewards')
    .addSubcommand(sub => sub.setName('invite').setDescription('Claim an invite credit reward tier')),
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const guildId = interaction.guild.id;
    const userId = interaction.user.id;

    const doc = await UserInvite.findOne({ guildId, userId });
    const granted = doc?.grantedCredits || 0;
    const reserved = doc?.reservedCredits || 0;
    const consumed = doc?.consumedCredits || 0;
    const available = Math.max(0, granted - reserved - consumed);

    const tiers = await getTiers(guildId);
    const eligible = tiers.filter(t => available >= t.credits);

    if (!eligible.length) {
      const nextTier = tiers.find(t => t.credits > available);
      return interaction.editReply({
        content: `❌ You don't have enough invite credits yet.\n\nYou have **${available}** available credits.` +
          (nextTier ? ` You need **${nextTier.credits - available}** more for the **${nextTier.reward}** tier.` : ''),
      });
    }

    const embed = new EmbedBuilder()
      .setTitle('🎟️ Claim an Invite Reward')
      .setColor('#F5A623')
      .setDescription(`You have **${available}** available invite credits. Select a reward tier to claim:`);
    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('invite_claim_tier_select').setPlaceholder('Select a reward tier').addOptions(
        eligible.map(t => ({ label: `${t.reward} — ${t.credits} credits`, value: String(t.credits) }))
      )
    );
    return interaction.editReply({ embeds: [embed], components: [row] });
  }
};

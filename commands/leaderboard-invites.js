const { SlashCommandBuilder } = require('discord.js');
const { buildLeaderboardEmbed } = require('../handlers/leaderboard');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('leaderboard-invites')
    .setDescription('Show the Top 10 inviters by credits'),
  async execute(interaction) {
    await interaction.deferReply();
    const embed = await buildLeaderboardEmbed(interaction.guild);
    return interaction.editReply({ embeds: [embed] });
  }
};

const { SlashCommandBuilder } = require('discord.js');
const { ServerConfig } = require('../models');
const { buildChatLeaderboardEmbed } = require('../handlers/leaderboard');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('leaderboard-msgs')
    .setDescription('Show the weekly and monthly message leaderboards'),
  async execute(interaction) {
    await interaction.deferReply();
    const config = await ServerConfig.findOne({ guildId: interaction.guild.id }) || {};
    const embed = await buildChatLeaderboardEmbed(interaction.guild, config);
    return interaction.editReply({ embeds: [embed] });
  }
};

const { SlashCommandBuilder } = require('discord.js');
const { buildInviteView } = require('./invite');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('invites')
    .setDescription('Check the invites of any member')
    .addUserOption(opt => opt.setName('user').setDescription('Member to check').setRequired(true)),
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const target = interaction.options.getUser('user');
    if (target.bot) return interaction.editReply({ content: '❌ Bots do not have invites.' });
    const view = await buildInviteView(interaction.guild.id, target, false);
    return interaction.editReply(view);
  }
};

const { SlashCommandBuilder } = require('discord.js');
const { UserInvite, RewardTicket } = require('../models');
const { isAdmin, creditBalance } = require('../utils/helpers');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('reset')
    .setDescription('Admin reset tools')
    .setDefaultMemberPermissions(8)
    .addSubcommand(sub => sub
      .setName('reserved')
      .setDescription("Give a user's reserved invites back to available and close their open invite tickets")
      .addUserOption(opt => opt.setName('user').setDescription('Member to reset').setRequired(true))),
  async execute(interaction) {
    if (!await isAdmin(interaction.member, interaction.guild.id)) {
      return interaction.reply({ content: '❌ You do not have permission to use this.', ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });
    const guildId = interaction.guild.id;
    const target = interaction.options.getUser('user');

    const doc = await UserInvite.findOne({ guildId, userId: target.id });
    const released = doc?.reservedCredits || 0;
    const tickets = await RewardTicket.find({ guildId, userId: target.id, type: 'invite', status: 'pending' });

    if (!released && !tickets.length) {
      return interaction.editReply({ content: `ℹ️ ${target} has no reserved invites and no open invite tickets.` });
    }

    // Close every open invite ticket for this user
    for (const t of tickets) {
      try {
        const ch = await interaction.guild.channels.fetch(t.channelId).catch(() => null);
        if (ch) await ch.delete('Reserved invites reset by admin');
      } catch (_) {}
      t.status = 'cancelled';
      await t.save();
    }

    // Reserved credits go back to available. Paid (consumed) credits are never touched.
    if (doc) {
      doc.reservedCredits = 0;
      doc.updatedAt = new Date();
      await doc.save();
    }

    const { available, consumed } = creditBalance(doc);
    return interaction.editReply({
      content: `✅ Reset done for ${target}.\n` +
        `Closed tickets: **${tickets.length}**\n` +
        `Released reserved invites: **${released}**\n` +
        `Now available: **${available}** (already paid: ${consumed})`,
    });
  },
};

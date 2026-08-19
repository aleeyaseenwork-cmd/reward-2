const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { isAdmin } = require('../utils/helpers');
const { ScheduledPost, Announcement } = require('../models');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('scheduled')
    .setDescription('View or cancel scheduled posts and announcements')
    .setDefaultMemberPermissions(8)
    .addSubcommand(sub => sub.setName('list').setDescription('List upcoming scheduled posts and announcements'))
    .addSubcommand(sub => sub
      .setName('cancel')
      .setDescription('Cancel a scheduled post by ID')
      .addStringOption(opt => opt.setName('id').setDescription('The scheduled post Mongo _id').setRequired(true))),
  async execute(interaction) {
    if (!await isAdmin(interaction.member, interaction.guild.id)) {
      return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });
    const guildId = interaction.guild.id;
    const sub = interaction.options.getSubcommand();

    if (sub === 'list') {
      const posts = await ScheduledPost.find({ guildId, sent: false, cancelled: false }).sort({ scheduledFor: 1 }).limit(10);
      const anns = await Announcement.find({ guildId, sent: false }).sort({ scheduledFor: 1 }).limit(10);
      const lines = [
        '**Scheduled Posts:**',
        ...posts.map(p => `• \`${p._id}\` — ${p.scheduledFor.toUTCString()} in <#${p.channelId}>`),
        posts.length === 0 ? '  None' : '',
        '',
        '**Scheduled Announcements:**',
        ...anns.map(a => `• \`${a._id}\` — ${a.title} — ${a.scheduledFor.toUTCString()} in <#${a.channelId}>`),
        anns.length === 0 ? '  None' : '',
      ].filter(l => l !== undefined);
      const embed = new EmbedBuilder().setTitle('🗓️ Scheduled Items').setColor('#5865F2').setDescription(lines.join('\n'));
      return interaction.editReply({ embeds: [embed] });
    }

    if (sub === 'cancel') {
      const id = interaction.options.getString('id');
      const post = await ScheduledPost.findOneAndUpdate({ _id: id, guildId }, { cancelled: true });
      if (!post) {
        const ann = await Announcement.findOneAndDelete({ _id: id, guildId, sent: false });
        if (!ann) return interaction.editReply({ content: '❌ No scheduled item found with that ID.' });
        return interaction.editReply({ content: '✅ Scheduled announcement cancelled.' });
      }
      return interaction.editReply({ content: '✅ Scheduled post cancelled.' });
    }
  }
};

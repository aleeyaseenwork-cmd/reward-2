const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { ChatStats, UserInvite, ServerConfig } = require('../models');
const { progressBar } = require('../utils/helpers');
const { getTiers } = require('../handlers/interactions');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('progress')
    .setDescription('Check your chat leaderboard and invite credit progress'),
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const guildId = interaction.guild.id;
    const userId = interaction.user.id;

    const config = await ServerConfig.findOne({ guildId }) || {};
    const stats = await ChatStats.findOne({ guildId, userId });
    const inviteDoc = await UserInvite.findOne({ guildId, userId });
    const tiers = await getTiers(guildId);

    const weeklyMin = config.weeklyMinMessages ?? 100;
    const monthlyMin = config.monthlyMinMessages ?? 400;
    const weeklyMsgs = stats?.weeklyMessages || 0;
    const monthlyMsgs = stats?.monthlyMessages || 0;

    const chatEmbed = new EmbedBuilder()
      .setTitle('💬 Chat Leaderboard Progress')
      .setColor('#5865F2')
      .setDescription(
        `**Weekly** (${config.weeklyReward || '$5 USDT or $5 Discord Nitro'})\n` +
        `${progressBar(weeklyMsgs, weeklyMin)} **${Math.min(Math.round((weeklyMsgs / weeklyMin) * 100), 100)}%**\n` +
        `${weeklyMsgs >= weeklyMin ? '✅' : '❌'} **${weeklyMsgs} / ${weeklyMin}** valid messages\n` +
        `📅 Active days this week: **${stats?.weeklyActiveDays || 0}**\n\n` +
        `**Monthly** (${config.monthlyReward || '$20 USDT or $20 Discord Nitro'})\n` +
        `${progressBar(monthlyMsgs, monthlyMin)} **${Math.min(Math.round((monthlyMsgs / monthlyMin) * 100), 100)}%**\n` +
        `${monthlyMsgs >= monthlyMin ? '✅' : '❌'} **${monthlyMsgs} / ${monthlyMin}** valid messages\n` +
        `📅 Active days this month: **${stats?.monthlyActiveDays || 0}**\n\n` +
        `_Winners are announced and rewarded automatically — no need to claim._`
      );

    const granted = inviteDoc?.grantedCredits || 0;
    const reserved = inviteDoc?.reservedCredits || 0;
    const consumed = inviteDoc?.consumedCredits || 0;
    const available = Math.max(0, granted - reserved - consumed);
    const nextTier = tiers.find(t => t.credits > available) || null;

    const inviteEmbed = new EmbedBuilder()
      .setTitle('🎟️ Invite Credit Progress')
      .setColor('#F5A623')
      .setDescription(
        `✅ Available credits: **${available}**\n` +
        `⏳ Reserved (pending claims): **${reserved}**\n` +
        `💰 Consumed (already paid): **${consumed}**\n\n` +
        `**Reward Tiers:**\n${tiers.map(t => `${available >= t.credits ? '✅' : '❌'} **${t.credits}** credits → **${t.reward}**`).join('\n')}\n\n` +
        (nextTier
          ? `${progressBar(available, nextTier.credits)} Need **${nextTier.credits - available}** more credits for **${nextTier.reward}**.`
          : '🎉 You qualify for every configured tier! Use `/claim invite` to redeem one.')
      );

    return interaction.editReply({ embeds: [chatEmbed, inviteEmbed] });
  }
};

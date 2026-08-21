const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { ChatStats, UserInvite, ServerConfig } = require('../models');
const {
  progressBar, nextMonday, nextMonthStart, formatUSTime, formatCountdown, creditBalance,
  placeLabel, rewardsFor,
} = require('../utils/helpers');
const { getTiers } = require('../handlers/interactions');
const { buildChatRankedLines } = require('../handlers/leaderboard');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('progress')
    .setDescription('Check the chat leaderboard standings and your invite credit progress'),
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const guild = interaction.guild;
    const guildId = guild.id;
    const userId = interaction.user.id;

    const config = await ServerConfig.findOne({ guildId }) || {};
    const stats = await ChatStats.findOne({ guildId, userId });
    const inviteDoc = await UserInvite.findOne({ guildId, userId });
    const tiers = await getTiers(guildId);

    const weeklyMin = config.weeklyMinMessages ?? 100;
    const monthlyMin = config.monthlyMinMessages ?? 400;
    const weeklyRewards = rewardsFor(config, 'weekly');
    const monthlyRewards = rewardsFor(config, 'monthly');
    const payoutSummary = rewards => rewards.map((r, i) => `${placeLabel(i + 1)} ${r}`).join(' · ');
    const myWeekly = stats?.weeklyMessages || 0;
    const myMonthly = stats?.monthlyMessages || 0;

    // Top 10 + my rank, for both periods — this is a race, so show everyone's standing.
    const [weeklyTop, monthlyTop, weeklyAhead, monthlyAhead] = await Promise.all([
      ChatStats.find({ guildId }).sort({ weeklyMessages: -1 }).limit(10),
      ChatStats.find({ guildId }).sort({ monthlyMessages: -1 }).limit(10),
      ChatStats.countDocuments({ guildId, weeklyMessages: { $gt: myWeekly } }),
      ChatStats.countDocuments({ guildId, monthlyMessages: { $gt: myMonthly } }),
    ]);

    const myWeeklyRank = weeklyAhead + 1;
    const myMonthlyRank = monthlyAhead + 1;
    const inWeeklyTop10 = weeklyTop.some(e => e.userId === userId);
    const inMonthlyTop10 = monthlyTop.some(e => e.userId === userId);

    const weeklyReset = nextMonday();
    const monthlyReset = nextMonthStart();

    const [weeklyLines, monthlyLines] = await Promise.all([
      buildChatRankedLines(guild, weeklyTop, 'weeklyMessages'),
      buildChatRankedLines(guild, monthlyTop, 'monthlyMessages'),
    ]);

    const chatEmbed = new EmbedBuilder()
      .setTitle('💬 Chat Leaderboard — This Is a Race!')
      .setColor('#5865F2')
      .setDescription(`The **top ${weeklyRewards.length}** at reset time get paid — see where you stand below and chat more to climb.`)
      .addFields(
        {
          name: `🗓️ Weekly Top 10 (min. ${weeklyMin} msgs to qualify)`,
          value:
            `**Payouts:** ${payoutSummary(weeklyRewards)}\n\n` +
            `${weeklyLines}\n\n` +
            `${inWeeklyTop10 ? `✅ You're **#${myWeeklyRank}**` : `❌ You're **#${myWeeklyRank}** (not in Top 10) — send more messages to climb!`} with **${myWeekly}** messages.\n` +
            `⏳ Resets in **${formatCountdown(weeklyReset)}** (${formatUSTime(weeklyReset)})`,
          inline: false,
        },
        {
          name: `📅 Monthly Top 10 (min. ${monthlyMin} msgs to qualify)`,
          value:
            `**Payouts:** ${payoutSummary(monthlyRewards)}\n\n` +
            `${monthlyLines}\n\n` +
            `${inMonthlyTop10 ? `✅ You're **#${myMonthlyRank}**` : `❌ You're **#${myMonthlyRank}** (not in Top 10) — send more messages to climb!`} with **${myMonthly}** messages.\n` +
            `⏳ Resets in **${formatCountdown(monthlyReset)}** (${formatUSTime(monthlyReset)})`,
          inline: false,
        },
      )
      .setFooter({ text: 'Winners are picked and announced automatically — no need to claim. Spam never counts.' });

    // Invite progress stays personal — it's not a competition against other members.
    const { available, reserved, consumed } = creditBalance(inviteDoc);
    const nextTier = tiers.find(t => t.credits > available) || null;

    const inviteEmbed = new EmbedBuilder()
      .setTitle('🎟️ Your Invite Credit Progress')
      .setColor('#F5A623')
      .setDescription(
        `✅ Available credits: **${available}**\n` +
        `⏳ Reserved (pending claims): **${reserved}**\n` +
        `💰 Consumed (already paid): **${consumed}**\n\n` +
        `**Reward Tiers:**\n${tiers.map(t => `${available >= t.credits ? '✅' : '❌'} **${t.credits}** credits → **${t.reward}**`).join('\n')}\n\n` +
        (nextTier
          ? `${progressBar(available, nextTier.credits)} Need **${nextTier.credits - available}** more credits for **${nextTier.reward}**.`
          : '🎉 You qualify for every configured tier! Use `/claim invite` to redeem one.')
      )
      .setFooter({ text: 'Use /invite for a full breakdown of your real, fake, and rejoined invites.' });

    return interaction.editReply({ embeds: [chatEmbed, inviteEmbed] });
  }
};

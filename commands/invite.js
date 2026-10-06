const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { UserInvite, ServerConfig } = require('../models');
const { computeInviteStats, creditBalance, progressBar } = require('../utils/helpers');
const { getTiers } = require('../handlers/interactions');

// Shared by /invite (yourself, with Open Ticket buttons) and /invites (any member, no buttons).
async function buildInviteView(guildId, target, isSelf) {
  const doc = await UserInvite.findOne({ guildId, userId: target.id });
  const stats = computeInviteStats(doc);
  const { available, reserved, consumed } = creditBalance(doc);
  const [config, tiers] = await Promise.all([
    ServerConfig.findOne({ guildId }),
    getTiers(guildId),
  ]);
  const nextTier = tiers.find(t => t.credits > available) || null;
  const eligible = [...tiers].sort((a, b) => a.credits - b.credits).filter(t => t.credits > 0 && available >= t.credits);
  const enabled = config?.inviteRewardsEnabled !== false;

  let intro = `**${stats.real}** real invite${stats.real === 1 ? '' : 's'} — these are the ones that count.\n` +
    `Some of this amount may already be claimed, so check the credits below.`;
  if (isSelf) {
    if (!enabled) {
      intro = '🔌 Invite rewards are currently turned **off** by an admin.\n\n' + intro;
    } else if (eligible.length) {
      const list = eligible.map(t => `**${t.credits}** invites → **${t.reward}**`).join('\n');
      intro = `🎉 You have **${available}** available invites and you are eligible for:\n${list}\n\n` +
        `**Click a button below to open your reward ticket.** Nothing opens automatically. Only the invites for the reward you choose are used and the rest stay with you, so you can also keep collecting for a bigger reward.\n\n` + intro;
    } else if (nextTier) {
      intro = `You have **${available}** available invites. Reach **${nextTier.credits}** to unlock **${nextTier.reward}**. A button to open your ticket will show up here once you get there.\n\n` + intro;
    }
  }

  const embed = new EmbedBuilder()
    .setTitle(`👥 Invites — ${target.username}`)
    .setColor('#F5A623')
    .setThumbnail(target.displayAvatarURL())
    .setDescription(intro)
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
    embed.addFields({ name: '🎯 Next Reward', value: isSelf ? '🎉 Every tier reached. Use the buttons above to open your ticket.' : '🎉 Every tier reached.', inline: false });
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

  const components = [];
  if (isSelf && enabled && eligible.length) {
    const buttons = eligible.slice(0, 25).map(t =>
      new ButtonBuilder().setCustomId(`invite_open_${t.credits}`).setLabel(`Open Ticket: ${t.reward} (${t.credits} invites)`.slice(0, 80)).setStyle(ButtonStyle.Success)
    );
    for (let i = 0; i < buttons.length; i += 5) components.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
  }
  return { embeds: [embed], components };
}

module.exports = {
  buildInviteView,
  data: new SlashCommandBuilder()
    .setName('invite')
    .setDescription('Check your own invites — real, fake, and rejoins'),
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const view = await buildInviteView(interaction.guild.id, interaction.user, true);
    return interaction.editReply(view);
  }
};

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { ServerConfig, UserWarning } = require('../models');

const WARNING_LIMIT = 3;                             // strikes before a mute
const MUTE_DURATION_MS = 24 * 60 * 60 * 1000;        // 1 day
const WARNING_COOLDOWN_MS = 5 * 60 * 1000;           // one strike per spam episode
const WARNING_DECAY_MS = 7 * 24 * 60 * 60 * 1000;    // clean for a week = clean slate

function warningEmbed(guildName, strike, reason) {
  // Can hit zero if the mute itself failed (missing permission, role too high),
  // in which case the member stays warned and staff pick it up from the mod log.
  const remaining = Math.max(0, WARNING_LIMIT - strike);
  return new EmbedBuilder()
    .setTitle(`⚠️ Spam Warning (${strike}/${WARNING_LIMIT})`)
    .setColor('#F5A623')
    .setDescription(
      `You've been flagged for spamming in **${guildName}**.\n\n` +
      `**What we saw:** you ${reason}.\n\n` +
      'Messages sent this way **do not count** toward the chat leaderboard, so this gains you nothing. ' +
      'Please chat normally.\n\n' +
      (remaining > 0
        ? `**${remaining} more warning${remaining === 1 ? '' : 's'} and you'll be muted for 24 hours.**`
        : '**You have reached the warning limit — the staff team has been notified.**')
    )
    .setTimestamp();
}

function muteEmbed(guildName, reason) {
  return new EmbedBuilder()
    .setTitle('🔇 You have been muted for 24 hours')
    .setColor('#ED4245')
    .setDescription(
      `You reached ${WARNING_LIMIT} spam warnings in **${guildName}**.\n\n` +
      `**Final strike:** you ${reason}.\n\n` +
      'The mute lifts automatically after 24 hours. If you think this was a mistake, contact the staff team.'
    )
    .setTimestamp();
}

async function sendModLog(guild, config, embed, userId) {
  const channelId = config?.modLogChannelId;
  if (!channelId) return;
  const channel = guild.channels.cache.get(channelId);
  if (!channel) return;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`mod_unmute_${userId}`).setLabel('🔊 Unmute & Clear Warnings').setStyle(ButtonStyle.Secondary),
  );
  await channel.send({ embeds: [embed], components: [row] }).catch(() => {});
}

/**
 * Registers one spam strike against a member. Returns null when the strike was
 * swallowed by the per-episode cooldown, so a single burst can't burn through
 * all three warnings at once.
 */
async function recordSpamStrike(member, reason) {
  const guild = member.guild;
  const guildId = guild.id;

  try {
    const config = await ServerConfig.findOne({ guildId });
    let doc = await UserWarning.findOne({ guildId, userId: member.id });
    if (!doc) doc = new UserWarning({ guildId, userId: member.id });

    const now = Date.now();
    const lastWarned = doc.lastWarnedAt ? doc.lastWarnedAt.getTime() : 0;
    if (lastWarned && now - lastWarned < WARNING_COOLDOWN_MS) return null;
    if (lastWarned && now - lastWarned > WARNING_DECAY_MS) doc.count = 0;

    doc.count += 1;
    doc.totalWarnings += 1;
    doc.lastWarnedAt = new Date();
    doc.history.push({ reason, at: new Date() });
    if (doc.history.length > 25) doc.history = doc.history.slice(-25);

    const strike = doc.count;
    const shouldMute = strike >= WARNING_LIMIT;
    let muteFailed = null;

    if (shouldMute) {
      try {
        await member.timeout(MUTE_DURATION_MS, `Spam: ${reason} (${WARNING_LIMIT} warnings)`);
        doc.mutedUntil = new Date(now + MUTE_DURATION_MS);
        doc.muteCount += 1;
        doc.count = 0; // ladder resets — the next offence starts from warning 1 again
      } catch (e) {
        muteFailed = e.message;
      }
    }

    await doc.save();

    const dm = shouldMute && !muteFailed ? muteEmbed(guild.name, reason) : warningEmbed(guild.name, strike, reason);
    let dmDelivered = true;
    try {
      await member.send({ embeds: [dm] });
    } catch (_) {
      dmDelivered = false; // DMs closed — the mod log still records it
    }

    const logEmbed = new EmbedBuilder()
      .setTitle(shouldMute && !muteFailed ? '🔇 Member Muted for Spam' : '⚠️ Spam Warning Issued')
      .setColor(shouldMute && !muteFailed ? '#ED4245' : '#F5A623')
      .setDescription(
        `**Member:** <@${member.id}> (\`${member.id}\`)\n` +
        `**Reason:** ${reason}\n` +
        `**Warning:** ${strike}/${WARNING_LIMIT}${shouldMute && !muteFailed ? ' — muted for 24 hours' : ''}\n` +
        `**DM delivered:** ${dmDelivered ? 'yes' : 'no (DMs closed)'}` +
        (muteFailed ? `\n\n❌ **Mute failed:** ${muteFailed}. Check the bot's Moderate Members permission and role position.` : '')
      )
      .setTimestamp();
    await sendModLog(guild, config, logEmbed, member.id);

    return { strike, muted: shouldMute && !muteFailed };
  } catch (e) {
    console.error('[Spam Warning]', e.message);
    return null;
  }
}

async function unmuteMember(guild, userId) {
  const member = await guild.members.fetch(userId).catch(() => null);
  if (member) {
    try {
      await member.timeout(null, 'Unmuted by staff');
    } catch (e) {
      return { ok: false, reason: `Could not lift the timeout: ${e.message}` };
    }
  }
  await UserWarning.findOneAndUpdate(
    { guildId: guild.id, userId },
    { guildId: guild.id, userId, count: 0, mutedUntil: null },
    { upsert: true }
  ).catch(() => {});
  return { ok: true, wasInServer: !!member };
}

async function clearWarnings(guildId, userId) {
  await UserWarning.findOneAndUpdate(
    { guildId, userId },
    { guildId, userId, count: 0 },
    { upsert: true }
  );
}

module.exports = {
  recordSpamStrike, unmuteMember, clearWarnings,
  WARNING_LIMIT, MUTE_DURATION_MS,
};

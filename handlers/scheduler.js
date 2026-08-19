const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { Announcement, ScheduledPost } = require('../models');
const { parseColor } = require('../utils/helpers');

async function runScheduler(client) {
  const now = new Date();

  // Send due announcements
  try {
    const announcements = await Announcement.find({ sent: false, scheduledFor: { $lte: now } });
    for (const ann of announcements) {
      try {
        const guild = client.guilds.cache.get(ann.guildId);
        if (!guild) continue;
        const ch = guild.channels.cache.get(ann.channelId);
        if (!ch) continue;
        const embed = new EmbedBuilder().setTitle(ann.title).setDescription(ann.description).setColor(parseColor(ann.color)).setTimestamp();
        if (ann.imageUrl) embed.setImage(ann.imageUrl);
        const components = [];
        if (ann.buttonText && ann.buttonUrl) {
          components.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel(ann.buttonText).setStyle(ButtonStyle.Link).setURL(ann.buttonUrl)));
        }
        await ch.send({ embeds: [embed], components });
        ann.sent = true;
        await ann.save();
      } catch (e) { console.error('[Scheduler] Announcement error:', e.message); }
    }
  } catch (_) {}

  // Send due scheduled posts
  try {
    const posts = await ScheduledPost.find({ sent: false, cancelled: false, scheduledFor: { $lte: now } });
    for (const post of posts) {
      try {
        const guild = client.guilds.cache.get(post.guildId);
        if (!guild) continue;
        const ch = guild.channels.cache.get(post.channelId);
        if (!ch) continue;
        const options = { content: post.content };
        if (post.imageUrl) options.files = [post.imageUrl];
        await ch.send(options);
        post.sent = true;
        await post.save();
      } catch (e) { console.error('[Scheduler] Post error:', e.message); }
    }
  } catch (_) {}
}

module.exports = { runScheduler };

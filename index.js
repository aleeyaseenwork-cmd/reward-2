require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const cron = require('node-cron');
const { Client, GatewayIntentBits, Partials, Collection } = require('discord.js');

const {
  initInviteCache, handleMemberJoin, handleMemberLeave, handleRoleAdd,
  handleMessage, handleMessageDelete, evaluateInviteCredits,
} = require('./handlers/tracker');
const { handleInteraction } = require('./handlers/interactions');
const { runScheduler } = require('./handlers/scheduler');
const { refreshAllLeaderboards } = require('./handlers/leaderboard');
const { runWeeklyChatRewards, runMonthlyChatRewards } = require('./handlers/chatRewards');

if (!process.env.BOT_TOKEN || !process.env.CLIENT_ID || !process.env.MONGODB_URI) {
  console.error('❌ Missing BOT_TOKEN, CLIENT_ID, or MONGODB_URI in .env — please configure it before starting.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildInvites,
  ],
  partials: [Partials.Channel, Partials.GuildMember, Partials.Message],
});

// ── Load slash commands ─────────────────────────────────────────
client.commands = new Collection();
const commandsPath = path.join(__dirname, 'commands');
for (const file of fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'))) {
  const command = require(path.join(commandsPath, file));
  if (command?.data?.name) client.commands.set(command.data.name, command);
}

// ── Database connection ─────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => {
    console.error('❌ MongoDB connection error:', err.message);
    process.exit(1);
  });

// ── Ready ────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  for (const guild of client.guilds.cache.values()) {
    await initInviteCache(guild);
  }

  // Announcements / scheduled posts due — checked every minute.
  cron.schedule('* * * * *', () => runScheduler(client));
  console.log('🕐 Announcement/post scheduler started (every minute).');

  // Grants invite credits once a member meets every validity requirement
  // (verified role, account 30+ days old at join, not a rejoin).
  // Runs every 15 minutes so roles granted while the bot was offline are still
  // picked up, without hammering the database.
  cron.schedule('*/15 * * * *', () => evaluateInviteCredits(client));
  console.log('🎟️ Invite credit evaluation scheduled (every 15 minutes).');

  // Weekly chat leaderboard winner — Monday 00:00 UTC.
  cron.schedule('0 0 * * 1', () => runWeeklyChatRewards(client));
  console.log('🏆 Weekly chat reward scheduled (Monday 00:00 UTC).');

  // Monthly chat leaderboard winner — 1st of the month, 00:00 UTC.
  cron.schedule('0 0 1 * *', () => runMonthlyChatRewards(client));
  console.log('👑 Monthly chat reward scheduled (1st of month, 00:00 UTC).');

  // Invite leaderboard refresh — once every 24 hours, edits the same message.
  cron.schedule('0 0 * * *', () => refreshAllLeaderboards(client));
  console.log('📊 Leaderboard auto-refresh scheduled (every 24 hours).');
});

// ── Guild join (refresh invite cache for new guilds) ─────────────
client.on('guildCreate', async (guild) => {
  await initInviteCache(guild);
});

// ── Member events ─────────────────────────────────────────────────
client.on('guildMemberAdd', async (member) => {
  await handleMemberJoin(member, client);
});

client.on('guildMemberRemove', async (member) => {
  await handleMemberLeave(member);
});

client.on('guildMemberUpdate', async (oldMember, newMember) => {
  await handleRoleAdd(oldMember, newMember);
});

// ── Message tracking ────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  await handleMessage(message);
});

client.on('messageDelete', async (message) => {
  await handleMessageDelete(message);
});

// ── Invite create/delete (keep cache fresh) ─────────────────────
client.on('inviteCreate', async (invite) => {
  if (invite.guild) await initInviteCache(invite.guild);
});

client.on('inviteDelete', async (invite) => {
  if (invite.guild) await initInviteCache(invite.guild);
});

// ── Interaction handling ─────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const command = client.commands.get(interaction.commandName);
      if (!command) return;
      await command.execute(interaction);
      return;
    }
    if (interaction.isButton() || interaction.isModalSubmit() || interaction.isStringSelectMenu() || interaction.isChannelSelectMenu() || interaction.isRoleSelectMenu()) {
      await handleInteraction(interaction, client);
      return;
    }
  } catch (err) {
    console.error('[Interaction Error]', err);
    try {
      const payload = { content: '❌ Something went wrong processing that interaction.', ephemeral: true };
      if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
      else await interaction.reply(payload);
    } catch (_) {}
  }
});

client.login(process.env.BOT_TOKEN);

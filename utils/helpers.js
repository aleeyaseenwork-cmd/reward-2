const { PermissionsBitField } = require('discord.js');
const { ServerConfig } = require('../models');

function generateId(prefix = 'ID-') {
  return prefix + Math.random().toString(36).substr(2, 9).toUpperCase();
}

async function isAdmin(member, guildId) {
  if (!member) return false;
  if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
  try {
    const config = await ServerConfig.findOne({ guildId });
    if (config?.adminRoleId && member.roles.cache.has(config.adminRoleId)) return true;
  } catch (_) {}
  return false;
}

async function isStaff(member, guildId) {
  if (await isAdmin(member, guildId)) return true;
  try {
    const config = await ServerConfig.findOne({ guildId });
    if (config?.staffRoleId && member.roles.cache.has(config.staffRoleId)) return true;
  } catch (_) {}
  return false;
}

function progressBar(current, required, length = 10) {
  if (!required || required <= 0) return '█'.repeat(length);
  const pct = Math.min(current / required, 1);
  const filled = Math.round(pct * length);
  return '█'.repeat(filled) + '░'.repeat(length - filled);
}

function parseColor(color) {
  if (!color) return '#5865F2';
  if (/^#[0-9A-Fa-f]{6}$/.test(color)) return color;
  if (/^[0-9A-Fa-f]{6}$/.test(color)) return '#' + color;
  return '#5865F2';
}

const RATE_LIMIT_MS = 15 * 1000; // one qualifying message per 15 seconds

/**
 * Implements the "Valid-message rules":
 *  - at least five meaningful (alphanumeric) characters
 *  - not from a bot (checked by the caller before this runs)
 *  - not copied and repeatedly posted (exact repeat of a recent message)
 *  - not composed only of emojis, symbols, or mentions
 *  - not sent more frequently than one qualifying message every 15 seconds
 *  - sent in an approved server channel (checked by the caller)
 */
function isValidChatMessage(content, recentMessages = [], lastValidMessageAt = null) {
  if (!content) return { valid: false, reason: 'empty' };

  const trimmed = content.trim();
  const meaningfulChars = (trimmed.match(/[a-zA-Z0-9]/g) || []).length;
  if (meaningfulChars < 5) return { valid: false, reason: 'too_short_or_symbols_only' };

  if (recentMessages.some(m => m.toLowerCase() === trimmed.toLowerCase())) {
    return { valid: false, reason: 'repeated' };
  }

  if (lastValidMessageAt && (Date.now() - new Date(lastValidMessageAt).getTime()) < RATE_LIMIT_MS) {
    return { valid: false, reason: 'rate_limited' };
  }

  return { valid: true };
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

// Monday 00:00:00 UTC of the current week
function currentWeekStart(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = d.getUTCDay(); // 0 = Sunday
  const diff = (day === 0 ? -6 : 1) - day; // shift to Monday
  d.setUTCDate(d.getUTCDate() + diff);
  return d;
}

// 1st of the current month, 00:00:00 UTC
function currentMonthStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function daysBetween(a, b) {
  return (new Date(b).getTime() - new Date(a).getTime()) / (1000 * 60 * 60 * 24);
}

module.exports = {
  generateId, isAdmin, isStaff, progressBar, parseColor,
  isValidChatMessage, todayUTC, currentWeekStart, currentMonthStart, daysBetween,
  RATE_LIMIT_MS,
};

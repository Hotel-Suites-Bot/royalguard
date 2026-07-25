import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_CONFIG = Object.freeze({
  brandName: 'Royal Guard',
  embedColor: 0x2b6cb0,
  logoUrl: '',
  footerText: 'Royal Guard',
  mainGroupId: '',
  verifiedRoleId: '',
  backgroundCheckRoleId: '',
  rankingRoleId: '',
  ticketManagerRoleId: '',
  logsChannelId: '',
  ticketParentId: '',
  ticketLogsChannelId: '',
  ticketSupportRoleId: '',
  ticketPanelTitle: 'Support Tickets',
  ticketPanelDescription: 'Select a category below to open a private ticket.',
  ticketCategories: [
    {
      label: 'General Support',
      description: 'General questions and assistance',
      emoji: '📩',
      supportRoleId: ''
    }
  ],
  baGroups: [],
  detectedGroups: [],
  rankRoleIds: [],
  roleBindings: [],
  nicknameFormat: '[{rank}] {username}'
});

function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

function mergeConfig(value) {
  const parsed = value && typeof value === 'object' ? value : {};
  return {
    ...cloneDefaults(),
    ...parsed,
    ticketCategories: Array.isArray(parsed.ticketCategories)
      ? parsed.ticketCategories
      : cloneDefaults().ticketCategories,
    baGroups: Array.isArray(parsed.baGroups) ? parsed.baGroups : [],
    detectedGroups: Array.isArray(parsed.detectedGroups) ? parsed.detectedGroups : [],
    rankRoleIds: Array.isArray(parsed.rankRoleIds) ? parsed.rankRoleIds : [],
    roleBindings: Array.isArray(parsed.roleBindings) ? parsed.roleBindings : []
  };
}

export function createDatabase(filename) {
  const resolved = path.resolve(filename || './data/royal-guard.sqlite');
  fs.mkdirSync(path.dirname(resolved), { recursive: true });

  const db = new DatabaseSync(resolved);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS guild_config (
      guild_id TEXT PRIMARY KEY,
      config_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS verifications (
      guild_id TEXT NOT NULL,
      discord_id TEXT NOT NULL,
      roblox_id TEXT NOT NULL,
      roblox_username TEXT NOT NULL,
      verified_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, discord_id),
      UNIQUE (guild_id, roblox_id)
    );

    CREATE TABLE IF NOT EXISTS oauth_states (
      token TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      discord_id TEXT NOT NULL,
      code_verifier TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS game_codes (
      code TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      discord_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      channel_id TEXT UNIQUE,
      user_id TEXT NOT NULL,
      category_key TEXT NOT NULL,
      support_role_id TEXT,
      claimed_by TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      close_reason TEXT,
      created_at INTEGER NOT NULL,
      closed_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS ticket_blacklist (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      reason TEXT,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      target_discord_id TEXT,
      target_roblox_id TEXT,
      data_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  const statements = {
    getConfig: db.prepare('SELECT config_json FROM guild_config WHERE guild_id = ?'),
    setConfig: db.prepare(`
      INSERT INTO guild_config (guild_id, config_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET
        config_json = excluded.config_json,
        updated_at = excluded.updated_at
    `),
    getVerification: db.prepare('SELECT * FROM verifications WHERE guild_id = ? AND discord_id = ?'),
    getVerificationByRoblox: db.prepare('SELECT * FROM verifications WHERE guild_id = ? AND roblox_id = ?'),
    setVerification: db.prepare(`
      INSERT INTO verifications (guild_id, discord_id, roblox_id, roblox_username, verified_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, discord_id) DO UPDATE SET
        roblox_id = excluded.roblox_id,
        roblox_username = excluded.roblox_username,
        verified_at = excluded.verified_at
    `),
    deleteVerification: db.prepare('DELETE FROM verifications WHERE guild_id = ? AND discord_id = ?'),
    createOauthState: db.prepare(`
      INSERT INTO oauth_states (token, guild_id, discord_id, code_verifier, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    getOauthState: db.prepare('SELECT * FROM oauth_states WHERE token = ?'),
    deleteOauthState: db.prepare('DELETE FROM oauth_states WHERE token = ?'),
    cleanupOauthStates: db.prepare('DELETE FROM oauth_states WHERE expires_at < ?'),
    createGameCode: db.prepare(`
      INSERT INTO game_codes (code, guild_id, discord_id, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `),
    getGameCode: db.prepare('SELECT * FROM game_codes WHERE code = ?'),
    deleteGameCode: db.prepare('DELETE FROM game_codes WHERE code = ?'),
    cleanupGameCodes: db.prepare('DELETE FROM game_codes WHERE expires_at < ?'),
    createTicket: db.prepare(`
      INSERT INTO tickets (guild_id, channel_id, user_id, category_key, support_role_id, created_at)
      VALUES (?, NULL, ?, ?, ?, ?)
    `),
    setTicketChannel: db.prepare('UPDATE tickets SET channel_id = ? WHERE id = ?'),
    getTicketByChannel: db.prepare('SELECT * FROM tickets WHERE channel_id = ?'),
    getOpenTicketByUser: db.prepare(`
      SELECT * FROM tickets
      WHERE guild_id = ? AND user_id = ? AND status IN ('open', 'closed')
      ORDER BY id DESC LIMIT 1
    `),
    updateTicketClaim: db.prepare('UPDATE tickets SET claimed_by = ? WHERE id = ?'),
    updateTicketSupportRole: db.prepare('UPDATE tickets SET support_role_id = ? WHERE id = ?'),
    closeTicket: db.prepare(`
      UPDATE tickets SET status = 'closed', close_reason = ?, closed_at = ? WHERE id = ?
    `),
    reopenTicket: db.prepare(`
      UPDATE tickets SET status = 'open', close_reason = NULL, closed_at = NULL WHERE id = ?
    `),
    deleteTicket: db.prepare(`UPDATE tickets SET status = 'deleted' WHERE id = ?`),
    getBlacklist: db.prepare('SELECT * FROM ticket_blacklist WHERE guild_id = ? AND user_id = ?'),
    addBlacklist: db.prepare(`
      INSERT INTO ticket_blacklist (guild_id, user_id, reason, created_by, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, user_id) DO UPDATE SET
        reason = excluded.reason,
        created_by = excluded.created_by,
        created_at = excluded.created_at
    `),
    removeBlacklist: db.prepare('DELETE FROM ticket_blacklist WHERE guild_id = ? AND user_id = ?'),
    addCase: db.prepare(`
      INSERT INTO cases (guild_id, type, actor_id, target_discord_id, target_roblox_id, data_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    ticketStatusStats: db.prepare(`
      SELECT status, COUNT(*) AS total FROM tickets WHERE guild_id = ? GROUP BY status
    `),
    ticketCategoryStats: db.prepare(`
      SELECT category_key, COUNT(*) AS total FROM tickets WHERE guild_id = ? GROUP BY category_key ORDER BY total DESC
    `),
    ticketTotal: db.prepare('SELECT COUNT(*) AS total FROM tickets WHERE guild_id = ?')
  };

  return {
    filename: resolved,
    raw: db,
    getConfig(guildId) {
      const row = statements.getConfig.get(guildId);
      if (!row) return cloneDefaults();
      try {
        return mergeConfig(JSON.parse(row.config_json));
      } catch {
        return cloneDefaults();
      }
    },
    setConfig(guildId, config) {
      const merged = mergeConfig(config);
      statements.setConfig.run(guildId, JSON.stringify(merged), Date.now());
      return merged;
    },
    patchConfig(guildId, patch) {
      return this.setConfig(guildId, { ...this.getConfig(guildId), ...patch });
    },
    getVerification(guildId, discordId) {
      return statements.getVerification.get(guildId, discordId) || null;
    },
    getVerificationByRoblox(guildId, robloxId) {
      return statements.getVerificationByRoblox.get(guildId, String(robloxId)) || null;
    },
    saveVerification(guildId, discordId, robloxId, username) {
      statements.setVerification.run(guildId, discordId, String(robloxId), username, Date.now());
      return this.getVerification(guildId, discordId);
    },
    deleteVerification(guildId, discordId) {
      statements.deleteVerification.run(guildId, discordId);
    },
    createOauthState({ token, guildId, discordId, codeVerifier, ttlMs = 10 * 60 * 1000 }) {
      const now = Date.now();
      statements.cleanupOauthStates.run(now);
      statements.createOauthState.run(token, guildId, discordId, codeVerifier, now, now + ttlMs);
    },
    getOauthState(token) {
      const row = statements.getOauthState.get(token);
      if (!row || row.expires_at < Date.now()) return null;
      return row;
    },
    deleteOauthState(token) {
      statements.deleteOauthState.run(token);
    },
    createGameCode({ code, guildId, discordId, ttlMs = 10 * 60 * 1000 }) {
      const now = Date.now();
      statements.cleanupGameCodes.run(now);
      statements.createGameCode.run(code, guildId, discordId, now, now + ttlMs);
    },
    getGameCode(code) {
      const row = statements.getGameCode.get(code);
      if (!row || row.expires_at < Date.now()) return null;
      return row;
    },
    deleteGameCode(code) {
      statements.deleteGameCode.run(code);
    },
    createTicket({ guildId, userId, categoryKey, supportRoleId }) {
      const result = statements.createTicket.run(guildId, userId, categoryKey, supportRoleId || '', Date.now());
      return Number(result.lastInsertRowid);
    },
    setTicketChannel(ticketId, channelId) {
      statements.setTicketChannel.run(channelId, ticketId);
    },
    getTicketByChannel(channelId) {
      return statements.getTicketByChannel.get(channelId) || null;
    },
    getOpenTicketByUser(guildId, userId) {
      return statements.getOpenTicketByUser.get(guildId, userId) || null;
    },
    setTicketClaim(ticketId, userId) {
      statements.updateTicketClaim.run(userId || null, ticketId);
    },
    setTicketSupportRole(ticketId, roleId) {
      statements.updateTicketSupportRole.run(roleId || '', ticketId);
    },
    closeTicket(ticketId, reason) {
      statements.closeTicket.run(reason || 'No reason provided', Date.now(), ticketId);
    },
    reopenTicket(ticketId) {
      statements.reopenTicket.run(ticketId);
    },
    markTicketDeleted(ticketId) {
      statements.deleteTicket.run(ticketId);
    },
    getTicketBlacklist(guildId, userId) {
      return statements.getBlacklist.get(guildId, userId) || null;
    },
    addTicketBlacklist(guildId, userId, reason, actorId) {
      statements.addBlacklist.run(guildId, userId, reason || 'No reason provided', actorId, Date.now());
    },
    removeTicketBlacklist(guildId, userId) {
      statements.removeBlacklist.run(guildId, userId);
    },
    getTicketStats(guildId) {
      const statuses = Object.fromEntries(statements.ticketStatusStats.all(guildId).map((row) => [row.status, Number(row.total)]));
      return {
        total: Number(statements.ticketTotal.get(guildId)?.total || 0),
        open: statuses.open || 0,
        closed: statuses.closed || 0,
        deleted: statuses.deleted || 0,
        byCategory: statements.ticketCategoryStats.all(guildId).map((row) => ({ ...row, total: Number(row.total) }))
      };
    },
    addCase({ guildId, type, actorId, targetDiscordId = null, targetRobloxId = null, data = {} }) {
      const result = statements.addCase.run(
        guildId,
        type,
        actorId,
        targetDiscordId,
        targetRobloxId ? String(targetRobloxId) : null,
        JSON.stringify(data),
        Date.now()
      );
      return Number(result.lastInsertRowid);
    }
  };
}

import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  Partials,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle
} from 'discord.js';
import { createDatabase } from './src/db.js';
import { createRobloxClient, RobloxApiError } from './src/roblox.js';

const requiredEnv = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID'];
for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const db = createDatabase(process.env.DATABASE_PATH || './data/royal-guard.sqlite');
const roblox = createRobloxClient(process.env);
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

const backgroundSessions = new Map();
const transcriptDirectory = path.resolve('./transcripts');
fs.mkdirSync(transcriptDirectory, { recursive: true });

const commandBuilders = [
  new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Link your Discord account to Roblox.')
    .addStringOption((option) =>
      option
        .setName('method')
        .setDescription('Choose OAuth or the verification game.')
        .addChoices(
          { name: 'Roblox OAuth', value: 'oauth' },
          { name: 'Verification Game', value: 'game' }
        )
    ),
  new SlashCommandBuilder()
    .setName('reverify')
    .setDescription('Replace your currently linked Roblox account.')
    .addStringOption((option) =>
      option
        .setName('method')
        .setDescription('Choose OAuth or the verification game.')
        .addChoices(
          { name: 'Roblox OAuth', value: 'oauth' },
          { name: 'Verification Game', value: 'game' }
        )
    ),
  new SlashCommandBuilder().setName('unlink').setDescription('Unlink your Roblox account.'),
  new SlashCommandBuilder()
    .setName('whois')
    .setDescription('View a member’s linked Roblox account.')
    .addUserOption((option) => option.setName('user').setDescription('Discord member')),
  new SlashCommandBuilder()
    .setName('sync')
    .setDescription('Refresh a member’s nickname and verification roles.')
    .addUserOption((option) => option.setName('user').setDescription('Discord member')),
  new SlashCommandBuilder()
    .setName('bgcheck')
    .setDescription('Run a three-page Discord and Roblox background check.')
    .addUserOption((option) => option.setName('user').setDescription('Member to check').setRequired(true)),
  new SlashCommandBuilder()
    .setName('rank')
    .setDescription('Promote, demote, or set a Roblox group rank.')
    .addUserOption((option) => option.setName('user').setDescription('Verified member').setRequired(true))
    .addStringOption((option) =>
      option
        .setName('action')
        .setDescription('Ranking action')
        .setRequired(true)
        .addChoices(
          { name: 'Promote', value: 'promote' },
          { name: 'Demote', value: 'demote' },
          { name: 'Set Rank', value: 'setrank' }
        )
    )
    .addStringOption((option) =>
      option.setName('rank').setDescription('Rank name or Roblox role ID; required for Set Rank')
    ),
  new SlashCommandBuilder()
    .setName('exile')
    .setDescription('Remove a verified member from the main Roblox group.')
    .addUserOption((option) => option.setName('user').setDescription('Verified member').setRequired(true)),
  new SlashCommandBuilder()
    .setName('ticketpanel')
    .setDescription('Post the ticket-opening panel in this channel.'),
  new SlashCommandBuilder()
    .setName('ticketblacklist')
    .setDescription('Add or remove someone from the ticket blacklist.')
    .addUserOption((option) => option.setName('user').setDescription('Member').setRequired(true))
    .addStringOption((option) =>
      option
        .setName('action')
        .setDescription('Blacklist action')
        .setRequired(true)
        .addChoices(
          { name: 'Add', value: 'add' },
          { name: 'Remove', value: 'remove' }
        )
    )
    .addStringOption((option) => option.setName('reason').setDescription('Reason for the blacklist')),
  new SlashCommandBuilder().setName('ticketstats').setDescription('Show ticket totals and category statistics.'),
  new SlashCommandBuilder().setName('config').setDescription('Open the bot configuration panel.'),
  new SlashCommandBuilder().setName('info').setDescription('Show the current bot configuration.')
];

function truncate(value, max = 1024) {
  const string = String(value ?? '');
  return string.length > max ? `${string.slice(0, max - 1)}…` : string;
}

function cleanId(value) {
  return String(value || '').replace(/[^0-9]/g, '');
}

function parseColor(value, fallback = 0x2b6cb0) {
  const cleaned = String(value || '').trim().replace(/^#/, '');
  const parsed = Number.parseInt(cleaned, 16);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 0xffffff ? parsed : fallback;
}

function timestamp(date) {
  const value = date instanceof Date ? date.getTime() : new Date(date).getTime();
  if (!Number.isFinite(value)) return 'Unknown';
  return `<t:${Math.floor(value / 1000)}:F>`;
}

function baseEmbed(config) {
  const embed = new EmbedBuilder().setColor(config.embedColor || 0x2b6cb0);
  if (config.footerText || config.brandName) {
    embed.setFooter({
      text: config.footerText || config.brandName,
      iconURL: config.logoUrl || undefined
    });
  }
  return embed;
}

function isAdministrator(member) {
  return Boolean(member?.permissions?.has(PermissionFlagsBits.Administrator));
}

function hasConfiguredRole(member, roleId) {
  return Boolean(roleId && member?.roles?.cache?.has(roleId));
}

function canBackgroundCheck(member, config) {
  return (
    isAdministrator(member) ||
    hasConfiguredRole(member, config.backgroundCheckRoleId) ||
    member?.permissions?.has(PermissionFlagsBits.ManageGuild)
  );
}

function canRank(member, config) {
  return isAdministrator(member) || hasConfiguredRole(member, config.rankingRoleId);
}

function canManageTickets(member, config, ticket = null) {
  return (
    isAdministrator(member) ||
    hasConfiguredRole(member, config.ticketManagerRoleId) ||
    hasConfiguredRole(member, ticket?.support_role_id || config.ticketSupportRoleId)
  );
}

async function safeReply(interaction, payload) {
  const normalized = typeof payload === 'string' ? { content: payload } : payload;
  if (interaction.deferred) return interaction.editReply(normalized);
  if (interaction.replied) return interaction.followUp({ ...normalized, flags: 64 });
  return interaction.reply({ ...normalized, flags: normalized.flags ?? 64 });
}

function errorMessage(error) {
  if (error instanceof RobloxApiError) return error.message;
  return error?.message || 'An unexpected error occurred.';
}

function verificationUrl(token) {
  const base = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  if (!base) throw new Error('PUBLIC_BASE_URL is not configured.');
  return `${base}/verify/${token}`;
}

function randomCode(length = 7) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let output = '';
  for (let index = 0; index < length; index += 1) {
    output += alphabet[crypto.randomInt(0, alphabet.length)];
  }
  return output;
}

async function sendLog(guild, config, payload) {
  if (!config.logsChannelId) return;
  const channel = await guild.channels.fetch(config.logsChannelId).catch(() => null);
  if (channel?.isTextBased()) await channel.send(payload).catch(() => null);
}

async function syncMember(member, verification = null) {
  const config = db.getConfig(member.guild.id);
  const link = verification || db.getVerification(member.guild.id, member.id);
  if (!link) throw new Error('This Discord member is not verified.');

  const baGroupIds = [
    config.mainGroupId,
    ...config.baGroups.map((group) => group.groupId),
    ...config.roleBindings.map((binding) => binding.groupId)
  ].filter(Boolean);
  const memberships = await roblox.listUserMemberships(link.roblox_id);
  await roblox.enrichMembershipRoles(memberships, baGroupIds);
  const membershipMap = new Map(memberships.map((item) => [String(item.groupId), item]));

  if (config.verifiedRoleId) {
    await member.roles.add(config.verifiedRoleId, 'Roblox verification sync').catch(() => null);
  }

  for (const binding of config.roleBindings) {
    const membership = membershipMap.get(String(binding.groupId));
    const hasBinding = membership?.roleIds?.includes(String(binding.robloxRoleId));
    if (!binding.discordRoleId) continue;
    if (hasBinding) {
      await member.roles.add(binding.discordRoleId, 'Roblox group role sync').catch(() => null);
    } else {
      await member.roles.remove(binding.discordRoleId, 'Roblox group role sync').catch(() => null);
    }
  }

  const main = config.mainGroupId ? membershipMap.get(String(config.mainGroupId)) : null;
  const rank = main?.highestRoleName || main?.roleNames?.at(-1) || 'Guest';
  const nickname = String(config.nicknameFormat || '[{rank}] {username}')
    .replaceAll('{rank}', rank)
    .replaceAll('{username}', link.roblox_username)
    .replaceAll('{display}', member.user.globalName || member.user.username)
    .slice(0, 32);
  if (member.manageable && nickname) await member.setNickname(nickname, 'Roblox verification sync').catch(() => null);

  return { memberships, main, rank, nickname };
}

async function beginVerification(interaction, method, replaceExisting = false) {
  const config = db.getConfig(interaction.guildId);
  const existing = db.getVerification(interaction.guildId, interaction.user.id);
  if (existing && !replaceExisting) {
    return safeReply(interaction, {
      embeds: [
        baseEmbed(config)
          .setTitle('Already Verified')
          .setDescription(`You are linked to **${existing.roblox_username}**. Use </reverify:${interaction.commandId}> to replace it.`)
      ]
    });
  }

  if (method === 'game') {
    let code;
    do code = randomCode(); while (db.getGameCode(code));
    db.createGameCode({ code, guildId: interaction.guildId, discordId: interaction.user.id });
    return safeReply(interaction, {
      embeds: [
        baseEmbed(config)
          .setTitle('Verification Game')
          .setDescription(
            `Join your verification game and type:\n\n\`!verify ${code}\`\n\nThe code expires in **10 minutes**.`
          )
      ]
    });
  }

  if (!roblox.hasOAuth) {
    throw new Error('Roblox OAuth is not configured. Use the game method or configure the OAuth environment variables.');
  }
  const token = crypto.randomBytes(32).toString('base64url');
  const pkce = roblox.createPkcePair();
  db.createOauthState({
    token,
    guildId: interaction.guildId,
    discordId: interaction.user.id,
    codeVerifier: pkce.verifier
  });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('Verify with Roblox').setStyle(ButtonStyle.Link).setURL(verificationUrl(token))
  );
  return safeReply(interaction, {
    embeds: [
      baseEmbed(config)
        .setTitle('Roblox Verification')
        .setDescription('Press the button below and authorize the official Roblox OAuth page. The link expires in 10 minutes.')
    ],
    components: [row]
  });
}

function configPanel(config) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('config:section')
    .setPlaceholder('Choose what to configure')
    .addOptions(
      { label: 'General & Permissions', value: 'general', emoji: '⚙️' },
      { label: 'Verification & BA Groups', value: 'verification', emoji: '✅' },
      { label: 'Background Checks', value: 'background', emoji: '🔎' },
      { label: 'Tickets', value: 'tickets', emoji: '🎫' },
      { label: 'Branding', value: 'branding', emoji: '🎨' }
    );
  return {
    embeds: [
      baseEmbed(config)
        .setTitle(`${config.brandName} Configuration`)
        .setDescription('Choose a section below. IDs may be pasted as raw IDs or mentions.')
    ],
    components: [new ActionRowBuilder().addComponents(menu)],
    flags: 64
  };
}

function modalInput(customId, label, value = '', style = TextInputStyle.Short, required = false, placeholder = '') {
  return new ActionRowBuilder().addComponents(
    new TextInputBuilder()
      .setCustomId(customId)
      .setLabel(label.slice(0, 45))
      .setStyle(style)
      .setRequired(required)
      .setValue(String(value || '').slice(0, style === TextInputStyle.Paragraph ? 4000 : 4000))
      .setPlaceholder(placeholder.slice(0, 100))
  );
}

function buildConfigModal(section, config) {
  const modal = new ModalBuilder().setCustomId(`configmodal:${section}`);
  if (section === 'general') {
    modal
      .setTitle('General & Permissions')
      .addComponents(
        modalInput('mainGroupId', 'Main Roblox Group ID', config.mainGroupId, TextInputStyle.Short, true),
        modalInput('verifiedRoleId', 'Verified Discord Role ID', config.verifiedRoleId),
        modalInput('backgroundCheckRoleId', 'Background Check Role ID', config.backgroundCheckRoleId),
        modalInput('rankingRoleId', 'Ranking Role ID', config.rankingRoleId),
        modalInput('logsChannelId', 'Main Logs Channel ID', config.logsChannelId)
      );
  } else if (section === 'verification') {
    const groups = config.baGroups.map((group) => `${group.groupId}|${group.name}`).join('\n');
    const bindings = config.roleBindings
      .map((binding) => `${binding.groupId}|${binding.robloxRoleId}|${binding.discordRoleId}`)
      .join('\n');
    modal
      .setTitle('Verification & BA Groups')
      .addComponents(
        modalInput('nicknameFormat', 'Nickname Format', config.nicknameFormat, TextInputStyle.Short, false, '[{rank}] {username}'),
        modalInput('rankRoleIds', 'Rank Role IDs — lowest to highest', config.rankRoleIds.join('\n'), TextInputStyle.Paragraph),
        modalInput('baGroups', 'BA Groups: groupId|display name', groups, TextInputStyle.Paragraph),
        modalInput('roleBindings', 'Role Bindings: group|Roblox role|Discord role', bindings, TextInputStyle.Paragraph)
      );
  } else if (section === 'background') {
    const detected = config.detectedGroups
      .map((group) => `${group.groupId}|${group.type || 'D'}|${group.name || ''}`)
      .join('\n');
    modal
      .setTitle('Background Checks')
      .addComponents(
        modalInput(
          'detectedGroups',
          'Detected groups: groupId|D or B|name',
          detected,
          TextInputStyle.Paragraph,
          false,
          '123456|D|Detected British Army\n987654|B|Blacklisted Group'
        )
      );
  } else if (section === 'tickets') {
    const categories = config.ticketCategories
      .map((category) =>
        [category.label, category.description, category.emoji || '', category.supportRoleId || ''].join('|')
      )
      .join('\n');
    modal
      .setTitle('Tickets')
      .addComponents(
        modalInput('ticketParentId', 'Ticket Category Channel ID', config.ticketParentId),
        modalInput('ticketLogsChannelId', 'Ticket Logs Channel ID', config.ticketLogsChannelId),
        modalInput('ticketSupportRoleId', 'Default Support Role ID', config.ticketSupportRoleId),
        modalInput('ticketManagerRoleId', 'Ticket Manager Role ID', config.ticketManagerRoleId),
        modalInput('ticketCategories', 'label|description|emoji|support role ID', categories, TextInputStyle.Paragraph, true)
      );
  } else if (section === 'branding') {
    modal
      .setTitle('Branding')
      .addComponents(
        modalInput('brandName', 'Bot / Community Name', config.brandName, TextInputStyle.Short, true),
        modalInput('embedColor', 'Embed Color Hex', `#${Number(config.embedColor || 0x2b6cb0).toString(16).padStart(6, '0')}`),
        modalInput('logoUrl', 'Logo URL', config.logoUrl),
        modalInput('footerText', 'Footer Text', config.footerText),
        modalInput('ticketPanelDescription', 'Ticket Panel Description', config.ticketPanelDescription, TextInputStyle.Paragraph)
      );
  } else {
    throw new Error('Unknown configuration section.');
  }
  return modal;
}

function parseLines(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function applyConfigModal(interaction, section, config) {
  const get = (id) => interaction.fields.getTextInputValue(id).trim();
  const patch = {};
  if (section === 'general') {
    patch.mainGroupId = cleanId(get('mainGroupId'));
    patch.verifiedRoleId = cleanId(get('verifiedRoleId'));
    patch.backgroundCheckRoleId = cleanId(get('backgroundCheckRoleId'));
    patch.rankingRoleId = cleanId(get('rankingRoleId'));
    patch.logsChannelId = cleanId(get('logsChannelId'));
  } else if (section === 'verification') {
    patch.nicknameFormat = get('nicknameFormat') || '[{rank}] {username}';
    patch.rankRoleIds = parseLines(get('rankRoleIds')).map(cleanId).filter(Boolean);
    patch.baGroups = parseLines(get('baGroups'))
      .map((line) => {
        const [groupId, ...nameParts] = line.split('|');
        return { groupId: cleanId(groupId), name: nameParts.join('|').trim() || `Group ${cleanId(groupId)}` };
      })
      .filter((group) => group.groupId);
    patch.roleBindings = parseLines(get('roleBindings'))
      .map((line) => {
        const [groupId, robloxRoleId, discordRoleId] = line.split('|');
        return {
          groupId: cleanId(groupId),
          robloxRoleId: cleanId(robloxRoleId),
          discordRoleId: cleanId(discordRoleId)
        };
      })
      .filter((binding) => binding.groupId && binding.robloxRoleId && binding.discordRoleId);
  } else if (section === 'background') {
    patch.detectedGroups = parseLines(get('detectedGroups'))
      .map((line) => {
        const [groupId, type, ...nameParts] = line.split('|');
        return {
          groupId: cleanId(groupId),
          type: String(type || 'D').trim().toUpperCase() === 'B' ? 'B' : 'D',
          name: nameParts.join('|').trim()
        };
      })
      .filter((group) => group.groupId);
  } else if (section === 'tickets') {
    patch.ticketParentId = cleanId(get('ticketParentId'));
    patch.ticketLogsChannelId = cleanId(get('ticketLogsChannelId'));
    patch.ticketSupportRoleId = cleanId(get('ticketSupportRoleId'));
    patch.ticketManagerRoleId = cleanId(get('ticketManagerRoleId'));
    patch.ticketCategories = parseLines(get('ticketCategories'))
      .slice(0, 25)
      .map((line) => {
        const [label, description, emoji, supportRoleId] = line.split('|');
        return {
          label: truncate(label?.trim() || 'Support', 100),
          description: truncate(description?.trim() || 'Open a support ticket', 100),
          emoji: emoji?.trim() || '',
          supportRoleId: cleanId(supportRoleId)
        };
      });
  } else if (section === 'branding') {
    patch.brandName = get('brandName') || config.brandName;
    patch.embedColor = parseColor(get('embedColor'), config.embedColor);
    patch.logoUrl = get('logoUrl');
    patch.footerText = get('footerText');
    patch.ticketPanelDescription = get('ticketPanelDescription') || config.ticketPanelDescription;
  }
  return db.patchConfig(interaction.guildId, patch);
}

function backgroundButtons(sessionId, page, total) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`bg:${sessionId}:prev`)
      .setEmoji('⬅️')
      .setLabel(String(page + 1))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId(`bg:${sessionId}:next`)
      .setEmoji('➡️')
      .setLabel(String(page + 1))
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page >= total - 1),
    new ButtonBuilder()
      .setCustomId(`bg:${sessionId}:delete`)
      .setEmoji('🗑️')
      .setLabel('Delete')
      .setStyle(ButtonStyle.Danger)
  );
}

function codeBlock(value) {
  return `\`\`\`text\n${String(value || '').replaceAll('```', '~~~')}\n\`\`\``;
}

async function buildBackgroundPages(targetMember, config, verification, bundle) {
  const discordRoles = targetMember.roles.cache
    .filter((role) => role.id !== targetMember.guild.id)
    .sort((a, b) => b.position - a.position)
    .map((role) => role.toString());
  const roleText = discordRoles.length ? discordRoles.join('\n') : 'No roles';

  const page1 = baseEmbed(config)
    .setAuthor({
      name: `${targetMember.user.username} | ${verification.roblox_username}`,
      iconURL: targetMember.user.displayAvatarURL()
    })
    .setTitle('User Discord Account Details')
    .setThumbnail(targetMember.user.displayAvatarURL({ size: 512 }))
    .addFields(
      { name: 'Joined Date', value: timestamp(targetMember.joinedAt), inline: true },
      { name: 'Registered Date', value: timestamp(targetMember.user.createdAt), inline: true },
      { name: 'Discord User ID', value: targetMember.id, inline: true },
      { name: `User Roles [${discordRoles.length}]`, value: truncate(roleText, 1024), inline: false },
      { name: 'Linked ROBLOX Account', value: `**${verification.roblox_username}** (\`${verification.roblox_id}\`)`, inline: false }
    );

  const created = bundle.user.created ? new Date(bundle.user.created) : null;
  const accountAge = created && Number.isFinite(created.getTime())
    ? Math.max(0, Math.floor((Date.now() - created.getTime()) / 86_400_000))
    : null;
  const configuredDetected = new Map(config.detectedGroups.map((group) => [String(group.groupId), group]));
  const detectedMemberships = bundle.memberships.filter((membership) => configuredDetected.has(String(membership.groupId)));
  const alerts = detectedMemberships.length
    ? [
        '⚠ [This user is in some detected groups.] ⚠',
        '',
        ...detectedMemberships.map((membership) => {
          const detected = configuredDetected.get(String(membership.groupId));
          const name = detected.name || membership.groupName || `Group ${membership.groupId}`;
          return `> ${detected.type || 'D'} | [${name}] — Group ${membership.groupId}`;
        })
      ].join('\n')
    : '✅ No configured detected or blacklisted groups were found.';

  const page2 = baseEmbed(config)
    .setAuthor({ name: bundle.user.username, iconURL: bundle.avatar || undefined })
    .setTitle('User ROBLOX Account Details')
    .setThumbnail(bundle.avatar || null)
    .addFields(
      {
        name: 'ROBLOX Account Age',
        value: accountAge === null ? 'Unknown' : `${accountAge.toLocaleString('en-US')} days`,
        inline: false
      },
      {
        name: 'ROBLOX Account Description',
        value: truncate(bundle.user.description || 'No description.', 1024),
        inline: false
      },
      { name: 'ROBLOX Account Groups', value: bundle.counts.groups.toLocaleString('en-US'), inline: true },
      { name: 'ROBLOX Account Friends', value: bundle.counts.friends.toLocaleString('en-US'), inline: true },
      { name: 'ROBLOX Account Followers', value: bundle.counts.followers.toLocaleString('en-US'), inline: true },
      { name: 'ROBLOX Account Following', value: bundle.counts.following.toLocaleString('en-US'), inline: true },
      { name: 'Alerts', value: truncate(codeBlock(alerts), 1024), inline: false }
    );

  const activeGroups = [
    ...(config.mainGroupId ? [{ groupId: String(config.mainGroupId), name: 'Main British Army' }] : []),
    ...config.baGroups.map((group) => ({ groupId: String(group.groupId), name: group.name }))
  ];
  const membershipMap = new Map(bundle.memberships.map((membership) => [String(membership.groupId), membership]));
  const activeLines = [];
  const missingLines = [];
  for (const group of activeGroups) {
    const membership = membershipMap.get(group.groupId);
    if (membership) {
      const displayName = group.name || membership.groupName || `Group ${group.groupId}`;
      const ranks = membership.roleNames?.length
        ? membership.roleNames.join(', ')
        : membership.highestRoleName || 'Member';
      activeLines.push(`**${displayName}**\nRank: ${ranks}`);
    } else {
      missingLines.push(group.name || `Group ${group.groupId}`);
    }
  }

  const page3 = baseEmbed(config)
    .setAuthor({ name: bundle.user.username, iconURL: bundle.avatar || undefined })
    .setTitle('Active British Army Information')
    .setThumbnail(bundle.avatar || null)
    .setDescription(
      activeLines.length
        ? activeLines.join('\n\n')
        : 'This user is not currently in any configured British Army or regiment group.'
    );
  if (missingLines.length) {
    page3.addFields({ name: 'Not Currently Enlisted', value: truncate(missingLines.join('\n'), 1024) });
  }

  return [page1, page2, page3].map((embed, index) =>
    embed.setFooter({
      text: `Viewing Page ${index + 1} / 3 • ${config.footerText || config.brandName}`,
      iconURL: config.logoUrl || undefined
    })
  );
}

function ticketControls(closed = false) {
  if (closed) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ticket:reopen').setLabel('Reopen').setEmoji('🔓').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('ticket:delete').setLabel('Delete').setEmoji('🗑️').setStyle(ButtonStyle.Danger)
    );
  }
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket:claim').setLabel('Claim').setEmoji('🙋').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('ticket:unclaim').setLabel('Unclaim').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ticket:add').setLabel('Add User').setEmoji('➕').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ticket:remove').setLabel('Remove User').setEmoji('➖').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ticket:close').setLabel('Close').setEmoji('🔒').setStyle(ButtonStyle.Danger)
  );
}

function ticketTransferControl() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket:transfer').setLabel('Transfer').setEmoji('🔁').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ticket:rename').setLabel('Rename').setEmoji('✏️').setStyle(ButtonStyle.Secondary)
  );
}

function ticketActionModal(action, title, label, placeholder, style = TextInputStyle.Short) {
  return new ModalBuilder()
    .setCustomId(`ticketmodal:${action}`)
    .setTitle(title)
    .addComponents(modalInput('value', label, '', style, true, placeholder));
}

function sanitizeChannelName(value) {
  return String(value || 'user')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 45) || 'user';
}

async function createTicket(interaction, categoryIndex) {
  const config = db.getConfig(interaction.guildId);
  const category = config.ticketCategories[Number(categoryIndex)];
  if (!category) throw new Error('That ticket category no longer exists.');

  const blacklist = db.getTicketBlacklist(interaction.guildId, interaction.user.id);
  if (blacklist) throw new Error(`You are blacklisted from tickets: ${blacklist.reason}`);
  const existing = db.getOpenTicketByUser(interaction.guildId, interaction.user.id);
  if (existing?.channel_id) {
    const existingChannel = await interaction.guild.channels.fetch(existing.channel_id).catch(() => null);
    if (existingChannel) throw new Error(`You already have a ticket open: ${existingChannel}`);
  }

  await interaction.deferReply({ flags: 64 });
  const supportRoleId = category.supportRoleId || config.ticketSupportRoleId;
  const ticketId = db.createTicket({
    guildId: interaction.guildId,
    userId: interaction.user.id,
    categoryKey: String(categoryIndex),
    supportRoleId
  });
  const botMember = interaction.guild.members.me;
  const overwrites = [
    { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: interaction.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks
      ]
    },
    {
      id: botMember.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.AttachFiles
      ]
    }
  ];
  if (supportRoleId) {
    overwrites.push({
      id: supportRoleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles
      ]
    });
  }
  if (config.ticketManagerRoleId && config.ticketManagerRoleId !== supportRoleId) {
    overwrites.push({
      id: config.ticketManagerRoleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels
      ]
    });
  }

  let channel;
  try {
    channel = await interaction.guild.channels.create({
      name: `ticket-${String(ticketId).padStart(4, '0')}-${sanitizeChannelName(interaction.user.username)}`,
      type: ChannelType.GuildText,
      parent: config.ticketParentId || undefined,
      topic: `Ticket #${ticketId} | Owner ${interaction.user.id} | ${category.label}`,
      permissionOverwrites: overwrites
    });
    db.setTicketChannel(ticketId, channel.id);
  } catch (error) {
    db.markTicketDeleted(ticketId);
    throw error;
  }

  const embed = baseEmbed(config)
    .setTitle(`${category.emoji || '🎫'} ${category.label} — Ticket #${ticketId}`)
    .setDescription(
      `Welcome ${interaction.user}. Please explain what you need help with.\n\n` +
      `**Category:** ${category.label}\n**Opened:** ${timestamp(new Date())}`
    )
    .setThumbnail(interaction.user.displayAvatarURL({ size: 256 }));
  await channel.send({
    content: `${interaction.user}${supportRoleId ? ` <@&${supportRoleId}>` : ''}`,
    embeds: [embed],
    components: [ticketControls(), ticketTransferControl()]
  });
  await interaction.editReply({ content: `Your ticket has been created: ${channel}` });
  await interaction.user.send(`Your **${category.label}** ticket was created in **${interaction.guild.name}**: ${channel}`).catch(() => null);
}

async function fetchAllMessages(channel, max = 1000) {
  const all = [];
  let before;
  while (all.length < max) {
    const batch = await channel.messages.fetch({ limit: Math.min(100, max - all.length), before });
    if (!batch.size) break;
    all.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  return all.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function createTranscript(channel, ticket) {
  const messages = await fetchAllMessages(channel);
  const rows = messages.map((message) => {
    const attachmentLinks = [...message.attachments.values()]
      .map((attachment) => `<a href="${escapeHtml(attachment.url)}">${escapeHtml(attachment.name || 'attachment')}</a>`)
      .join(' ');
    const embeds = message.embeds
      .map((embed) => `<div class="embed"><strong>${escapeHtml(embed.title || '')}</strong><br>${escapeHtml(embed.description || '')}</div>`)
      .join('');
    return `<article><img src="${escapeHtml(message.author.displayAvatarURL())}"><div><header><b>${escapeHtml(message.author.tag)}</b> <time>${escapeHtml(new Date(message.createdTimestamp).toISOString())}</time></header><p>${escapeHtml(message.cleanContent).replaceAll('\n', '<br>')}</p>${attachmentLinks}${embeds}</div></article>`;
  }).join('\n');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Ticket #${ticket.id}</title><style>body{font-family:Arial,sans-serif;background:#111827;color:#e5e7eb;max-width:1000px;margin:0 auto;padding:28px}h1{border-bottom:1px solid #374151;padding-bottom:14px}article{display:flex;gap:12px;padding:14px 0;border-bottom:1px solid #1f2937}img{width:42px;height:42px;border-radius:50%}header time{color:#9ca3af;font-size:12px;margin-left:8px}p{white-space:normal}.embed{border-left:4px solid #3b82f6;background:#1f2937;padding:10px;margin-top:8px}a{color:#60a5fa}</style></head><body><h1>Ticket #${ticket.id}</h1><p>Channel: ${escapeHtml(channel.name)} | User ID: ${escapeHtml(ticket.user_id)}</p>${rows || '<p>No messages.</p>'}</body></html>`;
  const filename = path.join(transcriptDirectory, `ticket-${ticket.id}-${Date.now()}.html`);
  fs.writeFileSync(filename, html, 'utf8');
  return filename;
}

async function sendTicketTranscript(channel, ticket, config, reason) {
  const file = await createTranscript(channel, ticket);
  const logChannel = config.ticketLogsChannelId
    ? await channel.guild.channels.fetch(config.ticketLogsChannelId).catch(() => null)
    : null;
  if (logChannel?.isTextBased()) {
    await logChannel.send({
      embeds: [
        baseEmbed(config)
          .setTitle(`Ticket #${ticket.id} Closed`)
          .addFields(
            { name: 'Owner', value: `<@${ticket.user_id}>`, inline: true },
            { name: 'Channel', value: channel.name, inline: true },
            { name: 'Reason', value: truncate(reason || 'No reason provided', 1024) }
          )
      ],
      files: [new AttachmentBuilder(file)]
    });
  }
  return file;
}

async function handleTicketButton(interaction, action) {
  const config = db.getConfig(interaction.guildId);
  const ticket = db.getTicketByChannel(interaction.channelId);
  if (!ticket) throw new Error('This channel is not registered as a ticket.');

  if (action === 'close') {
    if (interaction.user.id !== ticket.user_id && !canManageTickets(interaction.member, config, ticket)) {
      throw new Error('You do not have permission to close this ticket.');
    }
    return interaction.showModal(ticketActionModal('close', 'Close Ticket', 'Reason', 'Explain why this ticket is being closed', TextInputStyle.Paragraph));
  }

  if (!canManageTickets(interaction.member, config, ticket)) {
    throw new Error('You do not have permission to manage this ticket.');
  }

  if (action === 'claim') {
    if (ticket.claimed_by && ticket.claimed_by !== interaction.user.id) {
      throw new Error(`This ticket is already claimed by <@${ticket.claimed_by}>.`);
    }
    db.setTicketClaim(ticket.id, interaction.user.id);
    return interaction.reply({ content: `🙋 Ticket claimed by ${interaction.user}.` });
  }
  if (action === 'unclaim') {
    if (ticket.claimed_by && ticket.claimed_by !== interaction.user.id && !isAdministrator(interaction.member)) {
      throw new Error('Only the current claimant or an administrator can unclaim this ticket.');
    }
    db.setTicketClaim(ticket.id, null);
    return interaction.reply({ content: `Ticket unclaimed by ${interaction.user}.` });
  }
  if (action === 'add') {
    return interaction.showModal(ticketActionModal('add', 'Add User', 'Discord user ID or mention', '123456789012345678'));
  }
  if (action === 'remove') {
    return interaction.showModal(ticketActionModal('remove', 'Remove User', 'Discord user ID or mention', '123456789012345678'));
  }
  if (action === 'transfer') {
    return interaction.showModal(ticketActionModal('transfer', 'Transfer Ticket', 'Discord support role ID or mention', '123456789012345678'));
  }
  if (action === 'rename') {
    return interaction.showModal(ticketActionModal('rename', 'Rename Ticket', 'New channel name', 'command-help'));
  }
  if (action === 'reopen') {
    db.reopenTicket(ticket.id);
    await interaction.channel.permissionOverwrites.edit(ticket.user_id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true
    });
    await interaction.channel.setName(interaction.channel.name.replace(/^closed-/, 'ticket-')).catch(() => null);
    await interaction.update({ components: [ticketControls(), ticketTransferControl()] });
    const owner = await interaction.client.users.fetch(ticket.user_id).catch(() => null);
    if (owner) await owner.send(`Your ticket #${ticket.id} was reopened in **${interaction.guild.name}**.`).catch(() => null);
    return interaction.followUp({ content: `🔓 Ticket reopened by ${interaction.user}.` });
  }
  if (action === 'delete') {
    db.markTicketDeleted(ticket.id);
    await interaction.reply({ content: 'Deleting this ticket in 5 seconds…' });
    setTimeout(() => interaction.channel.delete(`Ticket #${ticket.id} deleted by ${interaction.user.tag}`).catch(() => null), 5000);
  }
}

async function handleTicketModal(interaction, action) {
  const config = db.getConfig(interaction.guildId);
  const ticket = db.getTicketByChannel(interaction.channelId);
  if (!ticket) throw new Error('This channel is not registered as a ticket.');
  const value = interaction.fields.getTextInputValue('value').trim();

  if (action === 'close') {
    if (interaction.user.id !== ticket.user_id && !canManageTickets(interaction.member, config, ticket)) {
      throw new Error('You do not have permission to close this ticket.');
    }
    await interaction.deferReply();
    await sendTicketTranscript(interaction.channel, ticket, config, value).catch(async (error) => {
      await interaction.followUp({ content: `Transcript warning: ${errorMessage(error)}`, flags: 64 });
    });
    db.closeTicket(ticket.id, value);
    await interaction.channel.permissionOverwrites.edit(ticket.user_id, {
      ViewChannel: false,
      SendMessages: false
    }).catch(() => null);
    await interaction.channel.setName(`closed-${String(ticket.id).padStart(4, '0')}`).catch(() => null);
    await interaction.editReply({
      embeds: [
        baseEmbed(config)
          .setTitle(`🔒 Ticket #${ticket.id} Closed`)
          .setDescription(`Closed by ${interaction.user}\n\n**Reason:** ${truncate(value, 1500)}`)
      ],
      components: [ticketControls(true)]
    });
    const owner = await interaction.client.users.fetch(ticket.user_id).catch(() => null);
    if (owner) {
      await owner.send({
        embeds: [baseEmbed(config).setTitle(`Ticket #${ticket.id} Closed`).setDescription(`**Reason:** ${truncate(value, 1500)}`)]
      }).catch(() => null);
    }
    return;
  }

  if (!canManageTickets(interaction.member, config, ticket)) {
    throw new Error('You do not have permission to manage this ticket.');
  }
  if (action === 'rename') {
    const newName = sanitizeChannelName(value);
    await interaction.channel.setName(`ticket-${String(ticket.id).padStart(4, '0')}-${newName}`);
    return safeReply(interaction, `Renamed this ticket to **${interaction.channel.name}**.`);
  }

  const id = cleanId(value);
  if (!id) throw new Error('A valid Discord ID or mention is required.');

  if (action === 'add') {
    await interaction.channel.permissionOverwrites.edit(id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true
    });
    return safeReply(interaction, `Added <@${id}> to this ticket.`);
  }
  if (action === 'remove') {
    if (id === ticket.user_id) throw new Error('The ticket owner cannot be removed. Close the ticket instead.');
    await interaction.channel.permissionOverwrites.delete(id).catch(() => null);
    return safeReply(interaction, `Removed <@${id}> from this ticket.`);
  }
  if (action === 'transfer') {
    const role = await interaction.guild.roles.fetch(id).catch(() => null);
    if (!role) throw new Error('That Discord role could not be found.');
    if (ticket.support_role_id) await interaction.channel.permissionOverwrites.delete(ticket.support_role_id).catch(() => null);
    await interaction.channel.permissionOverwrites.edit(role.id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true
    });
    db.setTicketSupportRole(ticket.id, role.id);
    return safeReply(interaction, `Transferred this ticket to ${role}.`);
  }
}

async function runBackgroundCheck(interaction) {
  const config = db.getConfig(interaction.guildId);
  if (!canBackgroundCheck(interaction.member, config)) throw new Error('You do not have permission to run background checks.');
  const targetUser = interaction.options.getUser('user', true);
  const targetMember = await interaction.guild.members.fetch(targetUser.id);
  const verification = db.getVerification(interaction.guildId, targetUser.id);
  if (!verification) throw new Error('This Discord user does not have a linked Roblox account.');

  await interaction.reply({
    content: `Hello ${targetUser}`,
    embeds: [
      baseEmbed(config)
        .setTitle('Background Checking')
        .setDescription('Please hold on while we background check the user.')
    ],
    fetchReply: true
  });

  try {
    const baGroupIds = [config.mainGroupId, ...config.baGroups.map((group) => group.groupId)].filter(Boolean);
    const bundle = await roblox.getAccountBundle(verification.roblox_id, baGroupIds);
    const pages = await buildBackgroundPages(targetMember, config, verification, bundle);
    const sessionId = crypto.randomBytes(9).toString('base64url');
    backgroundSessions.set(sessionId, {
      ownerId: interaction.user.id,
      guildId: interaction.guildId,
      pages,
      page: 0,
      expiresAt: Date.now() + 15 * 60 * 1000
    });
    await interaction.editReply({
      content: `Hello ${targetUser}`,
      embeds: [pages[0]],
      components: [backgroundButtons(sessionId, 0, pages.length)]
    });
  } catch (error) {
    await interaction.editReply({
      content: `Hello ${targetUser}`,
      embeds: [baseEmbed(config).setTitle('Background Check Failed').setDescription(errorMessage(error))],
      components: []
    });
  }
}

async function handleBackgroundButton(interaction, sessionId, action) {
  const session = backgroundSessions.get(sessionId);
  if (!session || session.expiresAt < Date.now()) {
    backgroundSessions.delete(sessionId);
    throw new Error('This background-check result has expired.');
  }
  const config = db.getConfig(interaction.guildId);
  if (interaction.user.id !== session.ownerId && !canBackgroundCheck(interaction.member, config)) {
    throw new Error('Only the command user or background-check staff can control this result.');
  }
  if (action === 'delete') {
    backgroundSessions.delete(sessionId);
    return interaction.message.delete().catch(() => interaction.update({ content: 'Deleted.', embeds: [], components: [] }));
  }
  session.page = action === 'prev'
    ? Math.max(0, session.page - 1)
    : Math.min(session.pages.length - 1, session.page + 1);
  return interaction.update({
    embeds: [session.pages[session.page]],
    components: [backgroundButtons(sessionId, session.page, session.pages.length)]
  });
}

async function enforceRankingHierarchy(interaction, config, targetVerification, action, requestedRank) {
  if (isAdministrator(interaction.member)) return;
  const actorVerification = db.getVerification(interaction.guildId, interaction.user.id);
  if (!actorVerification) throw new Error('You must be Roblox verified before using ranking commands.');
  const [roles, actorMembership, targetMembership] = await Promise.all([
    roblox.listGroupRoles(config.mainGroupId),
    roblox.getMembership(config.mainGroupId, actorVerification.roblox_id),
    roblox.getMembership(config.mainGroupId, targetVerification.roblox_id)
  ]);
  if (!actorMembership) throw new Error('Your Roblox account is not in the main group.');
  if (!targetMembership) throw new Error('The target Roblox account is not in the main group.');
  const roleMap = new Map(roles.map((role) => [String(role.id), role]));
  const actorRank = Math.max(0, ...actorMembership.roleIds.map((id) => roleMap.get(String(id))?.rank || 0));
  const targetRank = Math.max(0, ...targetMembership.roleIds.map((id) => roleMap.get(String(id))?.rank || 0));
  if (targetRank >= actorRank) throw new Error('You cannot modify a user with an equal or higher Roblox rank.');

  let intendedRank = targetRank;
  const ladder = (config.rankRoleIds.length
    ? config.rankRoleIds.map((id) => roleMap.get(String(id))).filter(Boolean)
    : roles.filter((role) => role.rank > 0 && role.rank < 255)
  ).sort((a, b) => a.rank - b.rank);
  if (action === 'setrank') {
    const lookup = String(requestedRank || '').trim().toLowerCase();
    intendedRank = ladder.find((role) => String(role.id) === lookup || role.displayName.toLowerCase() === lookup)?.rank ?? 255;
  } else {
    const currentIndex = ladder.findIndex((role) => role.rank === targetRank || targetMembership.roleIds.includes(String(role.id)));
    intendedRank = ladder[action === 'promote' ? currentIndex + 1 : currentIndex - 1]?.rank ?? targetRank;
  }
  if (intendedRank >= actorRank) throw new Error('You cannot set or promote a user to your rank or higher.');
}

async function handleCommand(interaction) {
  const config = db.getConfig(interaction.guildId);
  if (interaction.commandName === 'verify' || interaction.commandName === 'reverify') {
    const method = interaction.options.getString('method') || (roblox.hasOAuth ? 'oauth' : 'game');
    return beginVerification(interaction, method, interaction.commandName === 'reverify');
  }
  if (interaction.commandName === 'unlink') {
    const existing = db.getVerification(interaction.guildId, interaction.user.id);
    if (!existing) throw new Error('You do not have a linked Roblox account.');
    db.deleteVerification(interaction.guildId, interaction.user.id);
    const member = interaction.member;
    const removable = [config.verifiedRoleId, ...config.roleBindings.map((binding) => binding.discordRoleId)].filter(Boolean);
    for (const roleId of removable) await member.roles.remove(roleId, 'Roblox account unlinked').catch(() => null);
    if (member.manageable) await member.setNickname(null, 'Roblox account unlinked').catch(() => null);
    return safeReply(interaction, 'Your Roblox account has been unlinked.');
  }
  if (interaction.commandName === 'whois') {
    const target = interaction.options.getUser('user') || interaction.user;
    const link = db.getVerification(interaction.guildId, target.id);
    if (!link) throw new Error('That user is not verified.');
    return safeReply(interaction, {
      embeds: [
        baseEmbed(config)
          .setTitle(`${target.username}'s Roblox Account`)
          .setThumbnail(target.displayAvatarURL())
          .setDescription(`**Username:** ${link.roblox_username}\n**Roblox User ID:** \`${link.roblox_id}\`\n**Verified:** ${timestamp(link.verified_at)}`)
      ]
    });
  }
  if (interaction.commandName === 'sync') {
    const target = interaction.options.getUser('user') || interaction.user;
    if (target.id !== interaction.user.id && !interaction.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
      throw new Error('You need Manage Roles to sync another member.');
    }
    await interaction.deferReply({ flags: 64 });
    const member = await interaction.guild.members.fetch(target.id);
    const result = await syncMember(member);
    return interaction.editReply(`Synced **${target.username}** as **${result.rank}**.`);
  }
  if (interaction.commandName === 'bgcheck') return runBackgroundCheck(interaction);
  if (interaction.commandName === 'rank') {
    if (!canRank(interaction.member, config)) throw new Error('You do not have permission to rank members.');
    if (!config.mainGroupId) throw new Error('The main Roblox group has not been configured.');
    const target = interaction.options.getUser('user', true);
    const action = interaction.options.getString('action', true);
    const requestedRank = interaction.options.getString('rank');
    if (action === 'setrank' && !requestedRank) throw new Error('The rank option is required when using Set Rank.');
    const targetVerification = db.getVerification(interaction.guildId, target.id);
    if (!targetVerification) throw new Error('The target member is not Roblox verified.');
    await interaction.deferReply({ flags: 64 });
    await enforceRankingHierarchy(interaction, config, targetVerification, action, requestedRank);
    const result = await roblox.changeRank({
      groupId: config.mainGroupId,
      userId: targetVerification.roblox_id,
      action,
      targetRank: requestedRank,
      configuredRankRoleIds: config.rankRoleIds
    });
    const caseId = db.addCase({
      guildId: interaction.guildId,
      type: `rank_${action}`,
      actorId: interaction.user.id,
      targetDiscordId: target.id,
      targetRobloxId: targetVerification.roblox_id,
      data: { oldRank: result.oldRole?.displayName || 'Unknown', newRank: result.newRole.displayName }
    });
    const embed = baseEmbed(config)
      .setTitle(action === 'demote' ? 'Member Demoted' : action === 'promote' ? 'Member Promoted' : 'Rank Changed')
      .setColor(action === 'demote' ? 0xdc2626 : action === 'promote' ? 0x16a34a : config.embedColor)
      .setDescription(
        `**${targetVerification.roblox_username}** has been changed from **${result.oldRole?.displayName || 'Unknown'}** to **${result.newRole.displayName}** by ${interaction.user}.`
      )
      .setFooter({ text: `Case #${caseId} • ${config.footerText || config.brandName}`, iconURL: config.logoUrl || undefined });
    await interaction.editReply({ embeds: [embed] });
    await sendLog(interaction.guild, config, { embeds: [embed] });
    const targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);
    if (targetMember) await syncMember(targetMember, targetVerification).catch(() => null);
    return;
  }
  if (interaction.commandName === 'exile') {
    if (!canRank(interaction.member, config)) throw new Error('You do not have permission to exile members.');
    if (!config.mainGroupId) throw new Error('The main Roblox group has not been configured.');
    const target = interaction.options.getUser('user', true);
    const targetVerification = db.getVerification(interaction.guildId, target.id);
    if (!targetVerification) throw new Error('The target member is not Roblox verified.');
    await interaction.deferReply({ flags: 64 });
    await enforceRankingHierarchy(interaction, config, targetVerification, 'demote', null);
    await roblox.exileLegacy(config.mainGroupId, targetVerification.roblox_id);
    const caseId = db.addCase({
      guildId: interaction.guildId,
      type: 'exile',
      actorId: interaction.user.id,
      targetDiscordId: target.id,
      targetRobloxId: targetVerification.roblox_id,
      data: { username: targetVerification.roblox_username }
    });
    const embed = baseEmbed(config)
      .setTitle('Member Exiled')
      .setColor(0xdc2626)
      .setDescription(`**${targetVerification.roblox_username}** was removed from the main group by ${interaction.user}.`)
      .setFooter({ text: `Case #${caseId} • ${config.footerText || config.brandName}`, iconURL: config.logoUrl || undefined });
    await interaction.editReply({ embeds: [embed] });
    await sendLog(interaction.guild, config, { embeds: [embed] });
    return;
  }
  if (interaction.commandName === 'ticketpanel') {
    if (!isAdministrator(interaction.member) && !interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      throw new Error('You need Manage Server to post the ticket panel.');
    }
    const select = new StringSelectMenuBuilder()
      .setCustomId('ticket:open')
      .setPlaceholder('Select a ticket category')
      .addOptions(config.ticketCategories.slice(0, 25).map((category, index) => ({
        label: truncate(category.label, 100),
        description: truncate(category.description, 100),
        value: String(index),
        emoji: category.emoji || undefined
      })));
    await interaction.channel.send({
      embeds: [baseEmbed(config).setTitle(config.ticketPanelTitle).setDescription(config.ticketPanelDescription)],
      components: [new ActionRowBuilder().addComponents(select)]
    });
    return safeReply(interaction, 'Ticket panel posted.');
  }
  if (interaction.commandName === 'ticketblacklist') {
    if (!canManageTickets(interaction.member, config)) throw new Error('You do not have permission to manage the ticket blacklist.');
    const target = interaction.options.getUser('user', true);
    const action = interaction.options.getString('action', true);
    const reason = interaction.options.getString('reason') || 'No reason provided';
    if (action === 'add') db.addTicketBlacklist(interaction.guildId, target.id, reason, interaction.user.id);
    else db.removeTicketBlacklist(interaction.guildId, target.id);
    return safeReply(interaction, `${target} was ${action === 'add' ? 'added to' : 'removed from'} the ticket blacklist.`);
  }
  if (interaction.commandName === 'ticketstats') {
    if (!canManageTickets(interaction.member, config)) throw new Error('You do not have permission to view ticket statistics.');
    const stats = db.getTicketStats(interaction.guildId);
    const categoryLines = stats.byCategory.map((row) => {
      const category = config.ticketCategories[Number(row.category_key)];
      return `• ${category?.label || `Category ${row.category_key}`}: **${row.total}**`;
    }).join('\n') || 'No tickets have been created.';
    return safeReply(interaction, {
      embeds: [baseEmbed(config).setTitle('Ticket Statistics').addFields(
        { name: 'Total', value: String(stats.total), inline: true },
        { name: 'Open', value: String(stats.open), inline: true },
        { name: 'Closed', value: String(stats.closed), inline: true },
        { name: 'Deleted', value: String(stats.deleted), inline: true },
        { name: 'By Category', value: truncate(categoryLines, 1024) }
      )]
    });
  }
  if (interaction.commandName === 'config') {
    if (!isAdministrator(interaction.member) && !interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      throw new Error('You need Manage Server to configure the bot.');
    }
    return interaction.reply(configPanel(config));
  }
  if (interaction.commandName === 'info') {
    const ticketCategories = config.ticketCategories.map((category) => `• ${category.emoji || '🎫'} ${category.label}`).join('\n');
    const baGroups = config.baGroups.map((group) => `• ${group.name} (\`${group.groupId}\`)`).join('\n') || 'None';
    return safeReply(interaction, {
      embeds: [
        baseEmbed(config)
          .setTitle(`${config.brandName} Configuration`)
          .addFields(
            { name: 'Main Group', value: config.mainGroupId ? `\`${config.mainGroupId}\`` : 'Not configured', inline: true },
            { name: 'Verified Role', value: config.verifiedRoleId ? `<@&${config.verifiedRoleId}>` : 'Not configured', inline: true },
            { name: 'Background Check Role', value: config.backgroundCheckRoleId ? `<@&${config.backgroundCheckRoleId}>` : 'Not configured', inline: true },
            { name: 'Ranking Role', value: config.rankingRoleId ? `<@&${config.rankingRoleId}>` : 'Not configured', inline: true },
            { name: 'BA / Regiment Groups', value: truncate(baGroups, 1024) },
            { name: 'Detected Groups', value: String(config.detectedGroups.length), inline: true },
            { name: 'Ticket Categories', value: truncate(ticketCategories || 'None', 1024) }
          )
      ]
    });
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.inGuild()) throw new Error('This action must be used inside a Discord server.');
    if (interaction.isChatInputCommand()) return await handleCommand(interaction);
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'config:section') {
        if (!isAdministrator(interaction.member) && !interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
          throw new Error('You need Manage Server to configure the bot.');
        }
        return interaction.showModal(buildConfigModal(interaction.values[0], db.getConfig(interaction.guildId)));
      }
      if (interaction.customId === 'ticket:open') return createTicket(interaction, interaction.values[0]);
    }
    if (interaction.isButton()) {
      const [prefix, part1, part2] = interaction.customId.split(':');
      if (prefix === 'bg') return handleBackgroundButton(interaction, part1, part2);
      if (prefix === 'ticket') return handleTicketButton(interaction, part1);
    }
    if (interaction.isModalSubmit()) {
      const [prefix, section] = interaction.customId.split(':');
      if (prefix === 'configmodal') {
        if (!isAdministrator(interaction.member) && !interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
          throw new Error('You need Manage Server to configure the bot.');
        }
        const updated = applyConfigModal(interaction, section, db.getConfig(interaction.guildId));
        return safeReply(interaction, {
          embeds: [baseEmbed(updated).setTitle('Configuration Saved').setDescription(`The **${section}** section was updated.`)]
        });
      }
      if (prefix === 'ticketmodal') return handleTicketModal(interaction, section);
    }
  } catch (error) {
    console.error('Interaction error:', error);
    await safeReply(interaction, { content: `❌ ${errorMessage(error)}` }).catch(() => null);
  }
});

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const body = commandBuilders.map((command) => command.toJSON());
  if (process.env.DISCORD_GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID), { body });
    console.log(`Registered ${body.length} guild commands.`);
  } else {
    await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), { body });
    console.log(`Registered ${body.length} global commands.`);
  }
}

function pageHtml(title, message, success = true) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><style>body{font-family:Arial,sans-serif;background:#0b1220;color:#f3f4f6;display:grid;place-items:center;min-height:100vh;margin:0}.card{max-width:580px;background:#18202d;border:1px solid #334155;border-radius:14px;padding:30px;box-shadow:0 20px 60px #0008}.status{font-size:44px}h1{margin:10px 0}p{color:#cbd5e1;line-height:1.6}</style></head><body><main class="card"><div class="status">${success ? '✅' : '❌'}</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p>You may close this page and return to Discord.</p></main></body></html>`;
}

const app = express();
app.use(express.json({ limit: '100kb' }));
app.get('/health', (_request, response) => response.json({ ok: true, bot: client.user?.tag || 'starting' }));

app.get('/verify/:token', (request, response) => {
  try {
    const state = db.getOauthState(request.params.token);
    if (!state) return response.status(400).send(pageHtml('Verification Link Expired', 'Run /verify in Discord to create a new link.', false));
    const challenge = crypto.createHash('sha256').update(state.code_verifier).digest('base64url');
    return response.redirect(roblox.buildAuthorizationUrl({ state: request.params.token, codeChallenge: challenge }));
  } catch (error) {
    return response.status(500).send(pageHtml('Verification Error', errorMessage(error), false));
  }
});

app.get('/oauth/callback', async (request, response) => {
  const stateToken = String(request.query.state || '');
  const code = String(request.query.code || '');
  const oauthError = String(request.query.error_description || request.query.error || '');
  if (oauthError) return response.status(400).send(pageHtml('Roblox Authorization Declined', oauthError, false));
  const state = db.getOauthState(stateToken);
  if (!state || !code) return response.status(400).send(pageHtml('Verification Link Expired', 'Run /verify in Discord and try again.', false));

  try {
    const tokens = await roblox.exchangeAuthorizationCode(code, state.code_verifier);
    const user = await roblox.getOAuthUserInfo(tokens.access_token);
    const alreadyLinked = db.getVerificationByRoblox(state.guild_id, user.id);
    if (alreadyLinked && alreadyLinked.discord_id !== state.discord_id) {
      throw new Error('That Roblox account is already linked to another Discord account in this server.');
    }
    const verification = db.saveVerification(state.guild_id, state.discord_id, user.id, user.username);
    db.deleteOauthState(stateToken);
    const guild = await client.guilds.fetch(state.guild_id);
    const member = await guild.members.fetch(state.discord_id);
    const sync = await syncMember(member, verification);
    const config = db.getConfig(state.guild_id);
    await sendLog(guild, config, {
      embeds: [baseEmbed(config).setTitle('Member Verified').setDescription(`${member} linked **${user.username}** and synced as **${sync.rank}**.`)]
    });
    return response.send(pageHtml('Verification Complete', `${user.username} is now linked to your Discord account.`));
  } catch (error) {
    console.error('OAuth callback error:', error);
    return response.status(400).send(pageHtml('Verification Failed', errorMessage(error), false));
  }
});

app.post('/game/verify', async (request, response) => {
  const expected = Buffer.from(String(process.env.GAME_VERIFICATION_SECRET || ''));
  const supplied = Buffer.from(String(request.get('x-verification-secret') || ''));
  if (!expected.length || expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
    return response.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  const code = String(request.body?.code || '').trim().toUpperCase();
  const robloxId = cleanId(request.body?.userId);
  const username = String(request.body?.username || '').trim();
  const row = db.getGameCode(code);
  if (!row) return response.status(400).json({ ok: false, error: 'Invalid or expired verification code.' });
  if (!robloxId || !username) return response.status(400).json({ ok: false, error: 'Missing Roblox user information.' });

  try {
    const alreadyLinked = db.getVerificationByRoblox(row.guild_id, robloxId);
    if (alreadyLinked && alreadyLinked.discord_id !== row.discord_id) {
      throw new Error('This Roblox account is already linked to another Discord account.');
    }
    const verification = db.saveVerification(row.guild_id, row.discord_id, robloxId, username);
    db.deleteGameCode(code);
    const guild = await client.guilds.fetch(row.guild_id);
    const member = await guild.members.fetch(row.discord_id);
    const sync = await syncMember(member, verification);
    const config = db.getConfig(row.guild_id);
    await sendLog(guild, config, {
      embeds: [baseEmbed(config).setTitle('Member Verified In-Game').setDescription(`${member} linked **${username}** and synced as **${sync.rank}**.`)]
    });
    return response.json({ ok: true, message: `Verified as ${username}. You may return to Discord.` });
  } catch (error) {
    console.error('Game verification error:', error);
    return response.status(400).json({ ok: false, error: errorMessage(error) });
  }
});

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  try {
    await registerCommands();
  } catch (error) {
    console.error('Failed to register commands:', error);
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of backgroundSessions) {
    if (session.expiresAt < now) backgroundSessions.delete(id);
  }
}, 60_000).unref();

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Web server listening on port ${port}`));
client.login(process.env.DISCORD_TOKEN);

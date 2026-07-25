import crypto from 'node:crypto';

const OAUTH_BASE = 'https://apis.roblox.com/oauth';
const OPEN_CLOUD_BASE = 'https://apis.roblox.com/cloud/v2';

export class RobloxApiError extends Error {
  constructor(message, status = 0, body = null) {
    super(message);
    this.name = 'RobloxApiError';
    this.status = status;
    this.body = body;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(url, options = {}, retries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, options);
      const text = await response.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }

      if (!response.ok) {
        const message =
          data?.message ||
          data?.errors?.[0]?.message ||
          data?.error_description ||
          `Roblox request failed with HTTP ${response.status}`;
        const error = new RobloxApiError(message, response.status, data);
        if ((response.status === 429 || response.status >= 500) && attempt < retries) {
          lastError = error;
          await sleep(600 * 2 ** attempt);
          continue;
        }
        throw error;
      }
      return data;
    } catch (error) {
      if (error instanceof RobloxApiError) throw error;
      lastError = error;
      if (attempt < retries) {
        await sleep(600 * 2 ** attempt);
        continue;
      }
    }
  }
  throw new RobloxApiError(lastError?.message || 'Roblox request failed');
}

function resourceId(pathValue) {
  if (!pathValue) return '';
  return String(pathValue).split('/').filter(Boolean).at(-1) || '';
}

function chunks(items, size) {
  const output = [];
  for (let index = 0; index < items.length; index += size) {
    output.push(items.slice(index, index + size));
  }
  return output;
}

function formatCookie(value) {
  if (!value) return '';
  return value.startsWith('.ROBLOSECURITY=') ? value : `.ROBLOSECURITY=${value}`;
}

export function createRobloxClient(env = process.env) {
  const apiKey = env.ROBLOX_OPEN_CLOUD_KEY || '';
  const oauthClientId = env.ROBLOX_OAUTH_CLIENT_ID || '';
  const oauthClientSecret = env.ROBLOX_OAUTH_CLIENT_SECRET || '';
  const oauthRedirectUri = env.ROBLOX_OAUTH_REDIRECT_URI || '';
  const securityCookie = formatCookie(env.ROBLOX_SECURITY_COOKIE || '');

  const groupCache = new Map();
  const roleCache = new Map();

  function apiKeyHeaders(json = false) {
    if (!apiKey) throw new RobloxApiError('ROBLOX_OPEN_CLOUD_KEY is not configured.');
    const headers = { 'x-api-key': apiKey };
    if (json) headers['content-type'] = 'application/json';
    return headers;
  }

  async function getGroup(groupId) {
    const key = String(groupId);
    if (groupCache.has(key)) return groupCache.get(key);
    let group;
    if (apiKey) {
      group = await requestJson(`${OPEN_CLOUD_BASE}/groups/${encodeURIComponent(key)}`, {
        headers: apiKeyHeaders()
      });
      group = {
        id: key,
        name: group.displayName || group.name || `Group ${key}`,
        owner: group.owner || null,
        raw: group
      };
    } else {
      const legacy = await requestJson(`https://groups.roblox.com/v1/groups/${encodeURIComponent(key)}`);
      group = {
        id: key,
        name: legacy.name || `Group ${key}`,
        owner: legacy.owner || null,
        raw: legacy
      };
    }
    groupCache.set(key, group);
    return group;
  }

  async function getGroupNames(groupIds) {
    const unique = [...new Set(groupIds.map(String).filter(Boolean))];
    const missing = unique.filter((id) => !groupCache.has(id));

    for (const batch of chunks(missing, 100)) {
      if (!batch.length) continue;
      try {
        const query = new URLSearchParams();
        for (const id of batch) query.append('groupIds', id);
        const response = await requestJson(`https://groups.roblox.com/v2/groups?${query}`);
        for (const item of response?.data || []) {
          const id = String(item.id);
          groupCache.set(id, {
            id,
            name: item.name || `Group ${id}`,
            owner: item.owner || null,
            raw: item
          });
        }
      } catch {
        // A failed batch should not prevent the background check from finishing.
      }
    }

    for (const id of missing) {
      if (!groupCache.has(id)) {
        groupCache.set(id, { id, name: `Group ${id}`, owner: null, raw: null });
      }
    }

    return new Map(unique.map((id) => [id, groupCache.get(id)]));
  }

  async function listGroupRoles(groupId) {
    const key = String(groupId);
    if (roleCache.has(key)) return roleCache.get(key);

    if (!apiKey) {
      const legacy = await requestJson(`https://groups.roblox.com/v1/groups/${encodeURIComponent(key)}/roles`);
      const roles = (legacy.roles || []).map((role) => ({
        id: String(role.id),
        path: `groups/${key}/roles/${role.id}`,
        displayName: role.name || `Role ${role.id}`,
        rank: Number(role.rank || 0),
        raw: role
      }));
      roleCache.set(key, roles);
      return roles;
    }

    const roles = [];
    let pageToken = '';
    do {
      const query = new URLSearchParams({ maxPageSize: '20' });
      if (pageToken) query.set('pageToken', pageToken);
      const data = await requestJson(
        `${OPEN_CLOUD_BASE}/groups/${encodeURIComponent(key)}/roles?${query}`,
        { headers: apiKeyHeaders() }
      );
      for (const role of data?.groupRoles || []) {
        roles.push({
          id: String(role.id || resourceId(role.path)),
          path: role.path || `groups/${key}/roles/${role.id}`,
          displayName: role.displayName || `Role ${role.id || resourceId(role.path)}`,
          rank: Number(role.rank || 0),
          raw: role
        });
      }
      pageToken = data?.nextPageToken || '';
    } while (pageToken);

    roles.sort((a, b) => a.rank - b.rank);
    roleCache.set(key, roles);
    return roles;
  }

  async function listMembershipsCloud(userId) {
    const memberships = [];
    let pageToken = '';
    const filter = `user == 'users/${String(userId)}'`;

    do {
      const query = new URLSearchParams({ maxPageSize: '100', filter });
      if (pageToken) query.set('pageToken', pageToken);
      const data = await requestJson(`${OPEN_CLOUD_BASE}/groups/-/memberships?${query}`, {
        headers: apiKeyHeaders()
      });
      for (const membership of data?.groupMemberships || []) {
        const groupId = String(membership.path || '').split('/')[1] || '';
        memberships.push({
          groupId,
          groupName: '',
          membershipId: resourceId(membership.path),
          userId: resourceId(membership.user),
          roleIds: (membership.roles?.length ? membership.roles : [membership.role])
            .filter(Boolean)
            .map(resourceId),
          highestRoleId: resourceId(membership.role),
          roleNames: [],
          highestRoleName: '',
          raw: membership
        });
      }
      pageToken = data?.nextPageToken || '';
    } while (pageToken);

    const names = await getGroupNames(memberships.map((item) => item.groupId));
    for (const membership of memberships) {
      membership.groupName = names.get(membership.groupId)?.name || `Group ${membership.groupId}`;
    }
    return memberships;
  }

  async function listMembershipsLegacy(userId) {
    const data = await requestJson(
      `https://groups.roblox.com/v1/users/${encodeURIComponent(String(userId))}/groups/roles`
    );
    return (data?.data || []).map((item) => ({
      groupId: String(item.group?.id || ''),
      groupName: item.group?.name || `Group ${item.group?.id || ''}`,
      membershipId: '',
      userId: String(userId),
      roleIds: item.role?.id ? [String(item.role.id)] : [],
      highestRoleId: item.role?.id ? String(item.role.id) : '',
      roleNames: item.role?.name ? [item.role.name] : [],
      highestRoleName: item.role?.name || '',
      raw: item
    }));
  }

  async function listUserMemberships(userId) {
    if (apiKey) return listMembershipsCloud(userId);
    return listMembershipsLegacy(userId);
  }

  async function enrichMembershipRoles(memberships, groupIds) {
    const wanted = new Set(groupIds.map(String));
    for (const membership of memberships) {
      if (!wanted.has(String(membership.groupId))) continue;
      try {
        const roles = await listGroupRoles(membership.groupId);
        const map = new Map(roles.map((role) => [String(role.id), role]));
        membership.roleNames = membership.roleIds.map((id) => map.get(String(id))?.displayName || `Role ${id}`);
        membership.highestRoleName =
          map.get(String(membership.highestRoleId))?.displayName || membership.roleNames.at(-1) || 'Member';
      } catch {
        membership.roleNames = membership.roleNames.length ? membership.roleNames : ['Member'];
        membership.highestRoleName = membership.highestRoleName || membership.roleNames.at(-1) || 'Member';
      }
    }
    return memberships;
  }

  async function resolveUsername(username) {
    const data = await requestJson('https://users.roblox.com/v1/usernames/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ usernames: [username], excludeBannedUsers: false })
    });
    const user = data?.data?.[0];
    if (!user) throw new RobloxApiError(`Roblox user “${username}” was not found.`, 404);
    return { id: String(user.id), username: user.name, displayName: user.displayName || user.name };
  }

  async function getUser(userId) {
    return requestJson(`https://users.roblox.com/v1/users/${encodeURIComponent(String(userId))}`);
  }

  async function getHeadshot(userId) {
    const query = new URLSearchParams({
      userIds: String(userId),
      size: '420x420',
      format: 'Png',
      isCircular: 'false'
    });
    const data = await requestJson(`https://thumbnails.roblox.com/v1/users/avatar-headshot?${query}`);
    return data?.data?.[0]?.imageUrl || '';
  }

  async function getCount(url) {
    try {
      const data = await requestJson(url);
      return Number(data?.count || 0);
    } catch {
      return 0;
    }
  }

  async function getAccountBundle(userId, baGroupIds = []) {
    const [user, avatar, friends, followers, following, memberships] = await Promise.all([
      getUser(userId),
      getHeadshot(userId),
      getCount(`https://friends.roblox.com/v1/users/${userId}/friends/count`),
      getCount(`https://friends.roblox.com/v1/users/${userId}/followers/count`),
      getCount(`https://friends.roblox.com/v1/users/${userId}/followings/count`),
      listUserMemberships(userId)
    ]);

    await enrichMembershipRoles(memberships, baGroupIds);
    return {
      user: {
        id: String(user.id || userId),
        username: user.name || `User ${userId}`,
        displayName: user.displayName || user.name || `User ${userId}`,
        description: user.description || '',
        created: user.created || null,
        isBanned: Boolean(user.isBanned),
        hasVerifiedBadge: Boolean(user.hasVerifiedBadge)
      },
      avatar,
      counts: { friends, followers, following, groups: memberships.length },
      memberships
    };
  }

  async function getMembership(groupId, userId) {
    if (!apiKey) {
      const all = await listMembershipsLegacy(userId);
      return all.find((membership) => String(membership.groupId) === String(groupId)) || null;
    }
    const filter = `user == 'users/${String(userId)}'`;
    const query = new URLSearchParams({ maxPageSize: '10', filter });
    const data = await requestJson(
      `${OPEN_CLOUD_BASE}/groups/${encodeURIComponent(String(groupId))}/memberships?${query}`,
      { headers: apiKeyHeaders() }
    );
    const membership = data?.groupMemberships?.[0];
    if (!membership) return null;
    return {
      groupId: String(groupId),
      groupName: (await getGroup(groupId)).name,
      membershipId: resourceId(membership.path) || String(userId),
      userId: resourceId(membership.user),
      roleIds: (membership.roles?.length ? membership.roles : [membership.role]).filter(Boolean).map(resourceId),
      highestRoleId: resourceId(membership.role),
      roleNames: [],
      highestRoleName: '',
      raw: membership
    };
  }

  async function assignRole(groupId, userOrMembershipId, roleId) {
    return requestJson(
      `${OPEN_CLOUD_BASE}/groups/${encodeURIComponent(String(groupId))}/memberships/${encodeURIComponent(String(userOrMembershipId))}:assignRole`,
      {
        method: 'POST',
        headers: apiKeyHeaders(true),
        body: JSON.stringify({ role: `groups/${groupId}/roles/${roleId}` })
      }
    );
  }

  async function unassignRole(groupId, userOrMembershipId, roleId) {
    return requestJson(
      `${OPEN_CLOUD_BASE}/groups/${encodeURIComponent(String(groupId))}/memberships/${encodeURIComponent(String(userOrMembershipId))}:unassignRole`,
      {
        method: 'POST',
        headers: apiKeyHeaders(true),
        body: JSON.stringify({ role: `groups/${groupId}/roles/${roleId}` })
      }
    );
  }

  async function changeRank({ groupId, userId, action, targetRank, configuredRankRoleIds = [] }) {
    if (!apiKey) throw new RobloxApiError('Ranking requires ROBLOX_OPEN_CLOUD_KEY.');
    const membership = await getMembership(groupId, userId);
    if (!membership) throw new RobloxApiError('The Roblox user is not in the configured main group.', 404);

    const roles = await listGroupRoles(groupId);
    const roleMap = new Map(roles.map((role) => [String(role.id), role]));
    let orderedRoles;

    if (configuredRankRoleIds.length) {
      orderedRoles = configuredRankRoleIds
        .map(String)
        .map((id) => roleMap.get(id))
        .filter(Boolean);
    } else {
      orderedRoles = roles.filter((role) => role.rank > 0 && role.rank < 255);
    }
    orderedRoles.sort((a, b) => a.rank - b.rank);
    if (!orderedRoles.length) throw new RobloxApiError('No usable ranking roles were found.');

    const currentCandidates = orderedRoles.filter((role) => membership.roleIds.includes(String(role.id)));
    const current = currentCandidates.sort((a, b) => b.rank - a.rank)[0] || null;
    let target;

    if (action === 'setrank') {
      const lookup = String(targetRank || '').trim().toLowerCase();
      target = orderedRoles.find(
        (role) => String(role.id) === lookup || role.displayName.toLowerCase() === lookup
      );
      if (!target) throw new RobloxApiError('That rank was not found in the configured rank ladder.', 404);
    } else {
      if (!current) throw new RobloxApiError('The user does not currently hold a configured rank role.');
      const currentIndex = orderedRoles.findIndex((role) => role.id === current.id);
      target = orderedRoles[action === 'promote' ? currentIndex + 1 : currentIndex - 1];
      if (!target) {
        throw new RobloxApiError(
          action === 'promote' ? 'The user is already at the highest configured rank.' : 'The user is already at the lowest configured rank.'
        );
      }
    }

    if (current && current.id === target.id) {
      return { oldRole: current, newRole: target, unchanged: true, membership };
    }

    const membershipIdentifier = membership.membershipId || String(userId);
    for (const heldRole of currentCandidates) {
      if (heldRole.id !== target.id) {
        await unassignRole(groupId, membershipIdentifier, heldRole.id);
      }
    }
    await assignRole(groupId, membershipIdentifier, target.id);

    return {
      oldRole: current,
      newRole: target,
      unchanged: false,
      membership
    };
  }

  async function exileLegacy(groupId, userId) {
    if (!securityCookie) {
      throw new RobloxApiError(
        '/exile is disabled. Set ROBLOX_SECURITY_COOKIE to enable the legacy kick-member endpoint.'
      );
    }
    const url = `https://groups.roblox.com/v1/groups/${encodeURIComponent(String(groupId))}/users/${encodeURIComponent(String(userId))}`;
    let response = await fetch(url, {
      method: 'DELETE',
      headers: { cookie: securityCookie }
    });
    if (response.status === 403) {
      const csrf = response.headers.get('x-csrf-token');
      if (csrf) {
        response = await fetch(url, {
          method: 'DELETE',
          headers: { cookie: securityCookie, 'x-csrf-token': csrf }
        });
      }
    }
    if (!response.ok) {
      const text = await response.text();
      let body = text;
      try {
        body = JSON.parse(text);
      } catch {
        // Keep text.
      }
      throw new RobloxApiError(
        body?.errors?.[0]?.message || `Exile failed with HTTP ${response.status}`,
        response.status,
        body
      );
    }
    return true;
  }

  function buildAuthorizationUrl({ state, codeChallenge }) {
    if (!oauthClientId || !oauthRedirectUri) {
      throw new RobloxApiError('Roblox OAuth is not configured.');
    }
    const query = new URLSearchParams({
      client_id: oauthClientId,
      redirect_uri: oauthRedirectUri,
      scope: 'openid profile',
      response_type: 'code',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256'
    });
    return `${OAUTH_BASE}/v1/authorize?${query}`;
  }

  async function exchangeAuthorizationCode(code, codeVerifier) {
    if (!oauthClientId || !oauthClientSecret || !oauthRedirectUri) {
      throw new RobloxApiError('Roblox OAuth is not completely configured.');
    }
    const body = new URLSearchParams({
      client_id: oauthClientId,
      client_secret: oauthClientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: oauthRedirectUri,
      code_verifier: codeVerifier
    });
    return requestJson(`${OAUTH_BASE}/v1/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body
    });
  }

  async function getOAuthUserInfo(accessToken) {
    const info = await requestJson(`${OAUTH_BASE}/v1/userinfo`, {
      headers: { authorization: `Bearer ${accessToken}` }
    });
    const id = String(info.sub || info.id || '');
    if (!id) throw new RobloxApiError('Roblox OAuth did not return a user ID.');
    return {
      id,
      username: info.preferred_username || info.name || `User ${id}`,
      displayName: info.nickname || info.display_name || info.preferred_username || info.name || `User ${id}`,
      picture: info.picture || '',
      raw: info
    };
  }

  function createPkcePair() {
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
  }

  return {
    hasOpenCloudKey: Boolean(apiKey),
    hasOAuth: Boolean(oauthClientId && oauthClientSecret && oauthRedirectUri),
    hasExileCookie: Boolean(securityCookie),
    resolveUsername,
    getUser,
    getHeadshot,
    getGroup,
    getGroupNames,
    listGroupRoles,
    listUserMemberships,
    enrichMembershipRoles,
    getAccountBundle,
    getMembership,
    assignRole,
    unassignRole,
    changeRank,
    exileLegacy,
    buildAuthorizationUrl,
    exchangeAuthorizationCode,
    getOAuthUserInfo,
    createPkcePair,
    resourceId
  };
}

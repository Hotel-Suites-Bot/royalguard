# Royal Guard — Discord + Roblox Bot

A single-server British Army management bot with Roblox verification, three-page background checks, Open Cloud ranking, and a complete ticket system.

## Included

### Verification

- `/verify` using Roblox OAuth or the optional Roblox verification game.
- `/reverify`, `/unlink`, `/whois`, and `/sync`.
- Prevents one Roblox account from being linked to multiple Discord accounts in the same server.
- Verified Discord role, Roblox-to-Discord role bindings, and automatic nickname formatting.

### Background checks

- `/bgcheck user:@Member` sends a loading embed and then changes it into three pages.
- Page 1: Discord account age, server join date, roles, avatar, and linked account.
- Page 2: Roblox account age, description, groups, friends, followers, following, and configured detected/blacklisted groups.
- Page 3: main British Army rank plus every configured regiment/division and rank.
- Previous, next, and delete buttons with staff permission checks.

### Roblox group management

- `/rank user:@Member action:Promote|Demote|Set Rank`.
- `/exile user:@Member` as an optional legacy-cookie fallback.
- Configurable rank ladder.
- Prevents non-administrators from modifying an equal/higher Roblox rank or assigning a rank equal to/higher than their own.
- Case IDs and audit embeds.

### Tickets

- Configurable ticket panel and up to 25 categories.
- A separate support role can be assigned to each category.
- Claim, unclaim, add user, remove user, transfer, rename, close, reopen, and delete.
- Ticket blacklist, close-reason modal, DM notifications, HTML transcripts, logs, and `/ticketstats`.

### Configuration

- One `/config` dropdown panel for permissions, verification, BA groups, background detection, tickets, and branding.
- `/info` displays the active configuration.
- SQLite storage is local and does not require MongoDB.

This project intentionally has **no sessions, no staff-management records, and no applications**.

## Requirements

- Node.js 22.12.0 or newer.
- A Discord application/bot with **Server Members Intent** and **Message Content Intent** enabled.
- A public HTTPS URL for OAuth verification, such as a Railway deployment or VPS domain.
- A Roblox OAuth 2.0 application with the exact callback URL used in `ROBLOX_OAUTH_REDIRECT_URI`.
- A Roblox Open Cloud API key with the required group read/write permissions for ranking.

## Installation

1. Extract the project and open its folder in VS Code.
2. Open a terminal in the folder and run:

```bash
npm install
```

3. Copy `.env.example` to `.env`.
4. Fill out the Discord and Roblox credentials in `.env`.
5. Start the bot:

```bash
npm start
```

6. Invite the bot with the `bot` and `applications.commands` scopes. Give it the permissions it needs to manage roles, nicknames, channels, messages, and ticket permissions.
7. Run `/config` in Discord and complete each section.

While testing, set `DISCORD_GUILD_ID` so slash-command changes appear immediately. Removing it registers global commands, which can take longer to update.

## `.env` settings

```env
DISCORD_TOKEN=your-discord-bot-token
DISCORD_CLIENT_ID=your-discord-application-id
DISCORD_GUILD_ID=your-testing-server-id

PUBLIC_BASE_URL=https://your-public-domain
PORT=3000

ROBLOX_OAUTH_CLIENT_ID=your-oauth-client-id
ROBLOX_OAUTH_CLIENT_SECRET=your-oauth-client-secret
ROBLOX_OAUTH_REDIRECT_URI=https://your-public-domain/oauth/callback

ROBLOX_OPEN_CLOUD_KEY=your-open-cloud-api-key
GAME_VERIFICATION_SECRET=use-a-long-random-secret

# Optional and used only by /exile:
ROBLOX_SECURITY_COOKIE=

DATABASE_PATH=./data/royal-guard.sqlite
```

Never upload `.env`, your Discord token, OAuth secret, Open Cloud key, verification secret, or Roblox security cookie to GitHub.

## Roblox OAuth setup

Create an OAuth application in Roblox Creator Hub. Add this redirect URI exactly:

```text
https://YOUR-DOMAIN/oauth/callback
```

The bot requests the `openid profile` scopes and uses Authorization Code + PKCE. `PUBLIC_BASE_URL` must be the public HTTPS address where this Node.js project is running.

## Open Cloud group setup

Create an Open Cloud API key that is permitted to read the configured groups and manage group membership roles. Put it in `ROBLOX_OPEN_CLOUD_KEY`.

In `/config` → **Verification & BA Groups**:

### Rank role IDs

Enter Roblox role IDs from the lowest rank to the highest rank, one per line:

```text
11111111
22222222
33333333
```

Only roles in this ladder are changed by `/rank`. Unrelated regiment or specialist roles are left alone.

### BA/regiment groups

Enter one group per line:

```text
1234567|British Army
2345678|Grenadier Guards
3456789|Household Cavalry
```

Page 3 of `/bgcheck` uses this list to display active regiments and ranks.

### Discord role bindings

Use this format:

```text
groupId|robloxRoleId|discordRoleId
```

Example:

```text
1234567|22222222|987654321098765432
```

A member receives the Discord role while holding that Roblox role and loses it when they no longer hold it.

## Detected and blacklisted groups

In `/config` → **Background Checks**, enter:

```text
groupId|D|Detected group name
groupId|B|Blacklisted group name
```

- `D` means detected/suspicious.
- `B` means blacklisted.

The bot compares this list against all public Roblox group memberships returned for the verified user.

## Ticket category format

In `/config` → **Tickets**, each line uses:

```text
label|description|emoji|supportRoleId
```

Example:

```text
General Support|Questions and general help|📩|111111111111111111
Rank Support|Problems with a Roblox rank|🎖️|222222222222222222
Report a Member|Submit a private report|🚨|333333333333333333
```

The default support role is used when a category does not include its own support role.

## Optional verification game

The `roblox-game` folder contains:

- `VerificationServer.server.lua` — place in `ServerScriptService`.
- `VerificationNotification.client.lua` — place in `StarterPlayer > StarterPlayerScripts`.

In the server script:

1. Replace `API_URL` with `https://YOUR-DOMAIN/game/verify`.
2. Replace `SHARED_SECRET` with exactly the same value as `GAME_VERIFICATION_SECRET`.
3. Enable **Allow HTTP Requests** in Roblox Game Settings → Security.

A Discord user chooses the game method with `/verify method:Verification Game`, joins the game, and types:

```text
!verify CODE
```

## Exile limitation

Roblox Open Cloud group role APIs are used for ranking. The included `/exile` command is disabled unless `ROBLOX_SECURITY_COOKIE` is set because the project uses Roblox's legacy member-removal endpoint only for that command. Cookies are sensitive and can expire; leaving the variable blank safely disables `/exile` while all Open Cloud ranking features continue working.

## Commands

| Command | Purpose |
|---|---|
| `/verify` | Link Discord to Roblox with OAuth or the game |
| `/reverify` | Replace the linked Roblox account |
| `/unlink` | Remove the link and synced roles |
| `/whois` | View a linked Roblox account |
| `/sync` | Refresh nickname and Discord roles |
| `/bgcheck` | Run the three-page background check |
| `/rank` | Promote, demote, or set rank |
| `/exile` | Remove a member using the optional fallback |
| `/ticketpanel` | Post the ticket opening panel |
| `/ticketblacklist` | Add/remove a ticket blacklist entry |
| `/ticketstats` | View ticket totals |
| `/config` | Open the configuration panel |
| `/info` | View active configuration |

## Hosting notes

The web server exposes:

- `GET /health`
- `GET /verify/:token`
- `GET /oauth/callback`
- `POST /game/verify`

Your host must keep the Discord process and Express web server running together. On Railway, set all `.env` values as service variables and use `npm start` as the start command.

-- Place this Script in ServerScriptService.
-- Enable Game Settings > Security > Allow HTTP Requests.

local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local API_URL = "https://YOUR-DOMAIN/game/verify"
local SHARED_SECRET = "REPLACE_WITH_THE_SAME_GAME_VERIFICATION_SECRET_FROM_ENV"
local COMMAND_PREFIX = "!verify"
local COOLDOWN_SECONDS = 5

local resultEvent = ReplicatedStorage:FindFirstChild("VerificationResult")
if not resultEvent then
	resultEvent = Instance.new("RemoteEvent")
	resultEvent.Name = "VerificationResult"
	resultEvent.Parent = ReplicatedStorage
end

local lastRequestAt = {}

local function notify(player, success, message)
	resultEvent:FireClient(player, success, tostring(message))
end

local function submitCode(player, code)
	local now = os.clock()
	if lastRequestAt[player.UserId] and now - lastRequestAt[player.UserId] < COOLDOWN_SECONDS then
		notify(player, false, "Please wait before trying another code.")
		return
	end
	lastRequestAt[player.UserId] = now

	local ok, response = pcall(function()
		return HttpService:RequestAsync({
			Url = API_URL,
			Method = "POST",
			Headers = {
				["Content-Type"] = "application/json",
				["x-verification-secret"] = SHARED_SECRET,
			},
			Body = HttpService:JSONEncode({
				code = string.upper(code),
				userId = player.UserId,
				username = player.Name,
			}),
		})
	end)

	if not ok then
		notify(player, false, "The verification service could not be reached.")
		warn("Verification HTTP error:", response)
		return
	end

	local decodedOk, data = pcall(function()
		return HttpService:JSONDecode(response.Body)
	end)
	if not decodedOk then
		notify(player, false, "The verification service returned an invalid response.")
		return
	end

	if response.Success and data.ok then
		notify(player, true, data.message or "Your Roblox account has been verified.")
	else
		notify(player, false, data.error or "Verification failed. Check the code and try again.")
	end
end

local function onChatted(player, message)
	local prefix, code = string.match(message, "^(%S+)%s+(%S+)%s*$")
	if not prefix or string.lower(prefix) ~= COMMAND_PREFIX then
		return
	end
	if not string.match(code, "^[A-Za-z0-9]+$") then
		notify(player, false, "That verification code is invalid.")
		return
	end
	submitCode(player, code)
end

local function onPlayerAdded(player)
	player.Chatted:Connect(function(message)
		onChatted(player, message)
	end)
end

Players.PlayerAdded:Connect(onPlayerAdded)
Players.PlayerRemoving:Connect(function(player)
	lastRequestAt[player.UserId] = nil
end)

for _, player in Players:GetPlayers() do
	task.spawn(onPlayerAdded, player)
end

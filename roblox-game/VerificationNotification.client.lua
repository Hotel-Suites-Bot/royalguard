-- Place this LocalScript in StarterPlayer > StarterPlayerScripts.

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local TweenService = game:GetService("TweenService")
local Players = game:GetService("Players")

local event = ReplicatedStorage:WaitForChild("VerificationResult")
local playerGui = Players.LocalPlayer:WaitForChild("PlayerGui")

local function showNotification(success, message)
	local old = playerGui:FindFirstChild("VerificationNotification")
	if old then old:Destroy() end

	local gui = Instance.new("ScreenGui")
	gui.Name = "VerificationNotification"
	gui.ResetOnSpawn = false
	gui.IgnoreGuiInset = true
	gui.Parent = playerGui

	local frame = Instance.new("Frame")
	frame.AnchorPoint = Vector2.new(0.5, 0)
	frame.Position = UDim2.new(0.5, 0, 0, -120)
	frame.Size = UDim2.fromOffset(460, 94)
	frame.BackgroundColor3 = success and Color3.fromRGB(23, 104, 64) or Color3.fromRGB(145, 40, 40)
	frame.BorderSizePixel = 0
	frame.Parent = gui

	local corner = Instance.new("UICorner")
	corner.CornerRadius = UDim.new(0, 12)
	corner.Parent = frame

	local stroke = Instance.new("UIStroke")
	stroke.Color = Color3.fromRGB(255, 255, 255)
	stroke.Transparency = 0.82
	stroke.Parent = frame

	local title = Instance.new("TextLabel")
	title.BackgroundTransparency = 1
	title.Position = UDim2.fromOffset(20, 13)
	title.Size = UDim2.new(1, -40, 0, 26)
	title.Font = Enum.Font.GothamBold
	title.TextSize = 18
	title.TextColor3 = Color3.new(1, 1, 1)
	title.TextXAlignment = Enum.TextXAlignment.Left
	title.Text = success and "Verification Complete" or "Verification Failed"
	title.Parent = frame

	local body = Instance.new("TextLabel")
	body.BackgroundTransparency = 1
	body.Position = UDim2.fromOffset(20, 40)
	body.Size = UDim2.new(1, -40, 0, 40)
	body.Font = Enum.Font.Gotham
	body.TextSize = 14
	body.TextColor3 = Color3.fromRGB(235, 235, 235)
	body.TextWrapped = true
	body.TextXAlignment = Enum.TextXAlignment.Left
	body.TextYAlignment = Enum.TextYAlignment.Top
	body.Text = tostring(message)
	body.Parent = frame

	TweenService:Create(frame, TweenInfo.new(0.35, Enum.EasingStyle.Quint, Enum.EasingDirection.Out), {
		Position = UDim2.new(0.5, 0, 0, 24),
	}):Play()

	task.delay(6, function()
		if not frame.Parent then return end
		local tween = TweenService:Create(frame, TweenInfo.new(0.3, Enum.EasingStyle.Quint, Enum.EasingDirection.In), {
			Position = UDim2.new(0.5, 0, 0, -120),
		})
		tween:Play()
		tween.Completed:Wait()
		gui:Destroy()
	end)
end

event.OnClientEvent:Connect(showNotification)

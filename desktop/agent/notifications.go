package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
)

// NotificationConfig holds notification channel settings.
type NotificationConfig struct {
	Telegram *TelegramConfig `json:"telegram,omitempty"`
	Discord  *DiscordConfig  `json:"discord,omitempty"`
	Slack    *SlackConfig    `json:"slack,omitempty"`
	Teams    *TeamsConfig    `json:"teams,omitempty"`
}

type TelegramConfig struct {
	BotToken string `json:"botToken"` // from @BotFather
	ChatID   string `json:"chatId"`   // user/group chat ID
	Enabled  bool   `json:"enabled"`
}

type DiscordConfig struct {
	WebhookURL string `json:"webhookUrl"` // Discord webhook URL
	Enabled    bool   `json:"enabled"`
}

type SlackConfig struct {
	WebhookURL string `json:"webhookUrl"` // Slack incoming webhook URL
	Enabled    bool   `json:"enabled"`
}

type TeamsConfig struct {
	WebhookURL string `json:"webhookUrl"` // Microsoft Teams incoming webhook URL
	Enabled    bool   `json:"enabled"`
}

// NotificationManager handles sending notifications across channels.
type NotificationManager struct {
	config *NotificationConfig
	client *http.Client
}

// NewNotificationManager creates a notification manager.
func NewNotificationManager(config *NotificationConfig) *NotificationManager {
	if config == nil {
		config = &NotificationConfig{}
	}
	return &NotificationManager{
		config: config,
		client: &http.Client{Timeout: 10 * time.Second},
	}
}

// UpdateConfig updates the notification configuration.
func (nm *NotificationManager) UpdateConfig(config *NotificationConfig) {
	if config != nil {
		nm.config = config
	}
}

// NotifyTaskCompleted sends a notification when a task completes.
func (nm *NotificationManager) NotifyTaskCompleted(taskID, title, status string, costUSD float64, durationSec int) {
	icon := "✅"
	if status == "failed" {
		icon = "❌"
	} else if status == "stopped" {
		icon = "⏹"
	}

	msg := fmt.Sprintf("%s Task %s: %s\n\nStatus: %s", icon, taskID[:8], title, status)
	if costUSD > 0 {
		msg += fmt.Sprintf("\nCost: $%.4f", costUSD)
	}
	if durationSec > 0 {
		msg += fmt.Sprintf("\nDuration: %ds", durationSec)
	}

	nm.sendAll(msg)
}

// NotifyExecCompleted sends a notification when an exec command finishes.
func (nm *NotificationManager) NotifyExecCompleted(command, status string, exitCode int) {
	icon := "✅"
	if exitCode != 0 {
		icon = "❌"
	}

	cmd := command
	if len(cmd) > 50 {
		cmd = cmd[:50] + "..."
	}

	msg := fmt.Sprintf("%s Exec: %s\nExit code: %d", icon, cmd, exitCode)
	nm.sendAll(msg)
}

// NotifySessionTransfer sends a notification when a session is transferred.
func (nm *NotificationManager) NotifySessionTransfer(title, sourceDevice, targetDevice string) {
	msg := fmt.Sprintf("🔄 Session transferred\n\"%s\"\n%s → %s", title, sourceDevice, targetDevice)
	nm.sendAll(msg)
}

// NotifyAgentEvent sends a notification for agent lifecycle events.
func (nm *NotificationManager) NotifyAgentEvent(event, detail string) {
	msg := fmt.Sprintf("🔔 Agent: %s\n%s", event, detail)
	nm.sendAll(msg)
}

// sendAll sends a message to all configured notification channels.
func (nm *NotificationManager) sendAll(message string) {
	if nm.config.Telegram != nil && nm.config.Telegram.Enabled {
		go nm.sendTelegram(message)
	}
	if nm.config.Discord != nil && nm.config.Discord.Enabled {
		go nm.sendDiscord(message)
	}
	if nm.config.Slack != nil && nm.config.Slack.Enabled {
		go nm.sendSlack(message)
	}
	if nm.config.Teams != nil && nm.config.Teams.Enabled {
		go nm.sendTeams(message)
	}
}

// --- Telegram ---

func (nm *NotificationManager) sendTelegram(message string) {
	if nm.config.Telegram == nil || nm.config.Telegram.BotToken == "" || nm.config.Telegram.ChatID == "" {
		return
	}

	url := fmt.Sprintf("https://api.telegram.org/bot%s/sendMessage", nm.config.Telegram.BotToken)
	body, _ := json.Marshal(map[string]interface{}{
		"chat_id":    nm.config.Telegram.ChatID,
		"text":       message,
		"parse_mode": "Markdown",
	})

	resp, err := nm.client.Post(url, "application/json", bytes.NewReader(body))
	if err != nil {
		log.Printf("[notify:telegram] send failed: %v", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		respBody, _ := io.ReadAll(resp.Body)
		log.Printf("[notify:telegram] API error %d: %s", resp.StatusCode, string(respBody))
	}
}

// --- Discord ---

func (nm *NotificationManager) sendDiscord(message string) {
	if nm.config.Discord == nil || nm.config.Discord.WebhookURL == "" {
		return
	}

	body, _ := json.Marshal(map[string]string{"content": message})
	resp, err := nm.client.Post(nm.config.Discord.WebhookURL, "application/json", bytes.NewReader(body))
	if err != nil {
		log.Printf("[notify:discord] send failed: %v", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		log.Printf("[notify:discord] API error %d", resp.StatusCode)
	}
}

// --- Slack ---

func (nm *NotificationManager) sendSlack(message string) {
	if nm.config.Slack == nil || nm.config.Slack.WebhookURL == "" {
		return
	}

	body, _ := json.Marshal(map[string]string{"text": message})
	resp, err := nm.client.Post(nm.config.Slack.WebhookURL, "application/json", bytes.NewReader(body))
	if err != nil {
		log.Printf("[notify:slack] send failed: %v", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		log.Printf("[notify:slack] API error %d", resp.StatusCode)
	}
}

// --- Microsoft Teams ---

func (nm *NotificationManager) sendTeams(message string) {
	if nm.config.Teams == nil || nm.config.Teams.WebhookURL == "" {
		return
	}

	// Teams Incoming Webhook expects an Adaptive Card or simple text payload
	body, _ := json.Marshal(map[string]string{"text": message})
	resp, err := nm.client.Post(nm.config.Teams.WebhookURL, "application/json", bytes.NewReader(body))
	if err != nil {
		log.Printf("[notify:teams] send failed: %v", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		log.Printf("[notify:teams] API error %d", resp.StatusCode)
	}
}

// TestNotification sends a test message to verify configuration.
func (nm *NotificationManager) TestNotification(channel string) string {
	msg := "🧪 Yaver test notification — your integration is working!"

	switch strings.ToLower(channel) {
	case "telegram":
		if nm.config.Telegram == nil || !nm.config.Telegram.Enabled {
			return "Telegram not configured"
		}
		nm.sendTelegram(msg)
		return "Test sent to Telegram"
	case "discord":
		if nm.config.Discord == nil || !nm.config.Discord.Enabled {
			return "Discord not configured"
		}
		nm.sendDiscord(msg)
		return "Test sent to Discord"
	case "slack":
		if nm.config.Slack == nil || !nm.config.Slack.Enabled {
			return "Slack not configured"
		}
		nm.sendSlack(msg)
		return "Test sent to Slack"
	case "teams":
		if nm.config.Teams == nil || !nm.config.Teams.Enabled {
			return "Teams not configured"
		}
		nm.sendTeams(msg)
		return "Test sent to Teams"
	default:
		nm.sendAll(msg)
		return "Test sent to all configured channels"
	}
}

package com.ironspubbingo;

import net.runelite.client.config.Config;
import net.runelite.client.config.ConfigGroup;
import net.runelite.client.config.ConfigItem;
import net.runelite.client.config.ConfigSection;
import net.runelite.client.config.Notification;

@ConfigGroup(IronsPubBingoConfig.GROUP)
public interface IronsPubBingoConfig extends Config
{
	String GROUP = "ironspubbingo";

	@ConfigSection(
		name = "General",
		description = "Notifications and board display",
		position = 10
	)
	String generalSection = "general";

	@ConfigItem(
		keyName = "completionNotification",
		name = "Tile completion notification",
		description = "Notify when a bingo tile is completed",
		section = generalSection,
		position = 11
	)
	default Notification completionNotification()
	{
		return Notification.ON;
	}

	@ConfigItem(
		keyName = "lineDisplay",
		name = "Line style",
		description = "How completed bingo lines are shown: strokes drawn through the tiles (Lines), or gold tile borders (Highlight)",
		section = generalSection,
		position = 13
	)
	default LineDisplay lineDisplay()
	{
		return LineDisplay.LINES;
	}

	@ConfigItem(
		keyName = "progressFill",
		name = "Fill tiles by progress",
		description = "Fill partially completed tiles from bottom to top according to their progress",
		section = generalSection,
		position = 14
	)
	default boolean progressFill()
	{
		return true;
	}

	@ConfigItem(
		keyName = "popOutAlwaysOnTop",
		name = "Pop-out window always on top",
		description = "Keep the pop-out board window above the RuneLite window (and other windows)",
		section = generalSection,
		position = 15
	)
	default boolean popOutAlwaysOnTop()
	{
		return false;
	}

	@ConfigSection(
		name = "Progress Messages",
		description = "Which goal types show progress chat messages (when they are enabled at all)",
		position = 19,
		closedByDefault = true
	)
	String progressMsgSection = "progressMessages";

	@ConfigItem(
		keyName = "progressChatMessages",
		name = "Progress chat messages",
		description = "Show a chat message when a bingo goal progresses (master switch for the toggles below)",
		section = progressMsgSection,
		position = 0
	)
	default boolean progressChatMessages()
	{
		return true;
	}

	@ConfigItem(keyName = "progressMsgDrops", name = "Drops", description = "Progress messages for drop goals",
		section = progressMsgSection, position = 1)
	default boolean progressMsgDrops()
	{
		return true;
	}

	@ConfigItem(keyName = "progressMsgRaids", name = "Raid purples", description = "Progress messages for raid unique goals",
		section = progressMsgSection, position = 2)
	default boolean progressMsgRaids()
	{
		return true;
	}

	@ConfigItem(keyName = "progressMsgKc", name = "Boss kill counts", description = "Progress messages for kill count goals",
		section = progressMsgSection, position = 3)
	default boolean progressMsgKc()
	{
		return true;
	}

	@ConfigItem(keyName = "progressMsgKills", name = "NPC kills", description = "Progress messages for kill goals",
		section = progressMsgSection, position = 4)
	default boolean progressMsgKills()
	{
		return true;
	}

	@ConfigItem(keyName = "progressMsgPets", name = "Pets", description = "Progress messages for pet goals",
		section = progressMsgSection, position = 5)
	default boolean progressMsgPets()
	{
		return true;
	}

	@ConfigItem(keyName = "progressMsgLaps", name = "Agility laps", description = "Progress messages for lap goals",
		section = progressMsgSection, position = 6)
	default boolean progressMsgLaps()
	{
		return true;
	}

	@ConfigItem(keyName = "progressMsgValue", name = "Loot value", description = "Progress messages for loot value goals",
		section = progressMsgSection, position = 7)
	default boolean progressMsgValue()
	{
		return true;
	}

	@ConfigItem(keyName = "progressMsgChat", name = "Chat patterns", description = "Progress messages for chat-pattern goals",
		section = progressMsgSection, position = 8)
	default boolean progressMsgChat()
	{
		return true;
	}

	@ConfigSection(
		name = "Party Service",
		description = "Live sync with teammates over RuneLite's party service",
		position = 20
	)
	String partySection = "party";

	@ConfigItem(
		keyName = "autoJoinTeam",
		name = "Auto-join team party on login",
		description = "Connect to the team party automatically when you log in (unless you're already in another party)",
		section = partySection,
		position = 21
	)
	default boolean autoJoinTeam()
	{
		return false;
	}

	@ConfigSection(
		name = "Custom Team",
		description = "Type your own team code for playing without a team store - with a store, pick your team using the panel's Choose team button",
		position = 30
	)
	String customTeamSection = "customTeam";

	@ConfigItem(
		keyName = "teamCode",
		name = "Team code",
		description = "Code shared by your bingo host. Everyone with the same code shares progress"
			+ " (via RuneLite's party service). Choose team writes the picked store team here too",
		section = customTeamSection,
		position = 31
	)
	default String teamCode()
	{
		return "";
	}

	@ConfigItem(
		keyName = "teamName",
		name = "Team name",
		description = "Display name for your team, shown in the panel and in Discord posts",
		section = customTeamSection,
		position = 32
	)
	default String teamName()
	{
		return "";
	}

	@ConfigSection(
		name = "Team Store",
		description = "The event's team store, used when 'Use team store' is on",
		position = 40
	)
	String teamStoreSection = "teamStore";

	@ConfigItem(
		keyName = "teamStoreEnabled",
		name = "Use team store",
		description = "Sync team progress through the event's team store (URL below) and pick"
			+ " your team with the panel's Choose team button. Off = custom-code team, synced"
			+ " over the party service only",
		section = teamStoreSection,
		position = 40,
		warning = "This feature submits your IP address to a 3rd-party server not controlled or verified by RuneLite developers"
	)
	default boolean teamStoreEnabled()
	{
		return false;
	}

	@ConfigItem(
		keyName = "teamSyncUrl",
		name = "Team store URL",
		description = "The event's progress store URL from your bingo host, so progress also syncs"
			+ " when teammates are not online at the same time (see the plugin's README to set one up)",
		section = teamStoreSection,
		position = 41,
		secret = true
	)
	default String teamSyncUrl()
	{
		return "";
	}

	@ConfigSection(
		name = "Discord",
		description = "Post tile completions to a Discord channel",
		position = 50
	)
	String discordSection = "discord";

	@ConfigItem(
		keyName = "webhookUrl",
		name = "Webhook URL",
		description = "Discord webhook to post tile completions to (channel settings -> Integrations -> Webhooks)",
		section = discordSection,
		position = 51,
		secret = true
	)
	default String webhookUrl()
	{
		return "";
	}

	@ConfigItem(
		keyName = "postCompletions",
		name = "Post completions to Discord",
		description = "Post a message and screenshot to the webhook when you complete a bingo tile",
		section = discordSection,
		position = 52,
		warning = "This feature submits your IP address to a 3rd-party server not controlled or verified by RuneLite developers"
	)
	default boolean postCompletions()
	{
		return false;
	}
}

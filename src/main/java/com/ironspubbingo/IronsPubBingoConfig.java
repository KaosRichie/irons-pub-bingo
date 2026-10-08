package com.ironspubbingo;

import java.awt.Color;
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
		description = "Draw completed lines through the tiles (Lines) or as tile borders (Highlight)",
		section = generalSection,
		position = 12
	)
	default LineDisplay lineDisplay()
	{
		return LineDisplay.LINES;
	}

	@ConfigItem(
		keyName = "lineColor",
		name = "Line color",
		description = "Color of completed bingo lines",
		section = generalSection,
		position = 13
	)
	default Color lineColor()
	{
		return BingoUi.COLOR_LINE;
	}

	@ConfigItem(
		keyName = "progressFill",
		name = "Fill tiles by progress",
		description = "Fill tiles from the bottom up as they progress",
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
		description = "Keep the pop-out board window above other windows",
		section = generalSection,
		position = 15
	)
	default boolean popOutAlwaysOnTop()
	{
		return false;
	}

	@ConfigItem(
		keyName = "showTileNumbers",
		name = "Tile numbers in tile view",
		description = "Show the tile's number in the tile view",
		section = generalSection,
		position = 16
	)
	default boolean showTileNumbers()
	{
		return true;
	}

	@ConfigSection(
		name = "In-game Overlay",
		description = "What the in-game overlay shows",
		position = 18
	)
	String overlaySection = "overlay";

	@ConfigItem(
		keyName = "overlayPinnedTiles",
		name = "Pinned tiles",
		description = "Show the tiles you pinned, with their progress. Right-click a tile on the board to pin it.",
		section = overlaySection,
		position = 0
	)
	default boolean overlayPinnedTiles()
	{
		return true;
	}

	@ConfigItem(
		keyName = "overlayHideCompletedPins",
		name = "Hide completed pinned tiles",
		description = "Leave completed tiles out of the pinned tiles box. They stay pinned.",
		section = overlaySection,
		position = 1
	)
	default boolean overlayHideCompletedPins()
	{
		return false;
	}

	@ConfigItem(
		keyName = "overlayCountdown",
		name = "Event countdown",
		description = "Show the time until the event starts, or the time left until it ends.",
		section = overlaySection,
		position = 2
	)
	default boolean overlayCountdown()
	{
		return true;
	}

	@ConfigItem(
		keyName = "overlayStoreWarning",
		name = "Store problems",
		description = "Show a warning when the team store is not taking your progress, for example a wrong board or an unknown team.",
		section = overlaySection,
		position = 3
	)
	default boolean overlayStoreWarning()
	{
		return true;
	}

	@ConfigItem(
		keyName = "overlayLiveSyncWarning",
		name = "Live sync problems",
		description = "Show a warning when you are not in your team's party. Turn it off if you often use a party for other things, like raids.",
		section = overlaySection,
		position = 4
	)
	default boolean overlayLiveSyncWarning()
	{
		return false;
	}

	@ConfigSection(
		name = "Progress Messages",
		description = "Which goal types show progress chat messages, while Progress chat messages is on",
		position = 19,
		closedByDefault = true
	)
	String progressMsgSection = "progressMessages";

	@ConfigItem(
		keyName = "progressChatMessages",
		name = "Progress chat messages",
		description = "Show a chat message when a bingo goal progresses. Turns off all the toggles below",
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
		name = "Custom Team",
		description = "Your team code for events without a team store. With the store on, pick your team with Choose team in the panel",
		position = 30
	)
	String customTeamSection = "customTeam";

	@ConfigItem(
		keyName = "teamCode",
		name = "Team code",
		description = "Used only while the team store is off. Everyone with the same code shares progress through a RuneLite party",
		section = customTeamSection,
		position = 31
	)
	default String teamCode()
	{
		return "";
	}

	@ConfigItem(
		keyName = "storeTeam",
		name = "Store team",
		description = "The store team picked with Choose team",
		hidden = true
	)
	default String storeTeam()
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
		description = "Sync progress through the event's team store. Pick your team with Choose team in the panel",
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
		description = "The team store URL from your bingo host",
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

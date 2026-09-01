package com.ironspubbingo;

import com.google.gson.Gson;
import com.google.gson.JsonSyntaxException;
import com.google.gson.reflect.TypeToken;
import com.google.inject.Provides;
import java.lang.reflect.Type;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.inject.Inject;
import javax.swing.JOptionPane;
import javax.swing.SwingUtilities;
import lombok.Getter;
import lombok.extern.slf4j.Slf4j;
import net.runelite.api.ChatMessageType;
import net.runelite.api.coords.WorldPoint;
import net.runelite.api.Client;
import net.runelite.api.GameState;
import net.runelite.api.Skill;
import net.runelite.api.events.ChatMessage;
import net.runelite.api.events.GameStateChanged;
import net.runelite.api.events.ItemContainerChanged;
import net.runelite.api.events.StatChanged;
import net.runelite.api.gameval.InventoryID;
import net.runelite.api.gameval.ItemID;
import net.runelite.client.Notifier;
import net.runelite.client.callback.ClientThread;
import net.runelite.client.chat.ChatColorType;
import net.runelite.client.chat.ChatMessageBuilder;
import net.runelite.client.chat.ChatMessageManager;
import net.runelite.client.chat.QueuedMessage;
import net.runelite.client.config.ConfigManager;
import net.runelite.client.eventbus.Subscribe;
import net.runelite.client.events.ConfigChanged;
import net.runelite.client.events.ServerNpcLoot;
import net.runelite.client.events.PartyChanged;
import net.runelite.client.events.PlayerLootReceived;
import net.runelite.client.events.RuneScapeProfileChanged;
import net.runelite.client.game.ItemManager;
import net.runelite.client.game.ItemStack;
import net.runelite.client.party.PartyMember;
import net.runelite.client.party.PartyService;
import net.runelite.client.party.WSClient;
import net.runelite.client.party.events.UserJoin;
import net.runelite.client.party.events.UserPart;
import net.runelite.client.plugins.Plugin;
import net.runelite.client.plugins.PluginDescriptor;
import net.runelite.client.plugins.loottracker.LootReceived;
import net.runelite.client.ui.ClientToolbar;
import net.runelite.client.ui.NavigationButton;
import net.runelite.client.util.AsyncBufferedImage;
import net.runelite.client.util.ImageUtil;
import net.runelite.client.util.Text;
import net.runelite.http.api.item.ItemPrice;
import net.runelite.http.api.loottracker.LootRecordType;

@Slf4j
@PluginDescriptor(
	name = "Irons Pub Bingo",
	description = "Track clan bingo boards solo or as a team: drops, raid purples, kill counts, pets, XP goals and more",
	tags = {"bingo", "clan", "event", "drops", "tracker", "competition", "team"}
)
public class IronsPubBingoPlugin extends Plugin
{
	private static final Pattern KC_MESSAGE = Pattern.compile(
		"Your (?:completed )?(.+?) (?:(?:kill|chest|harvest|lap|success|completion) )?count is:? ([\\d,]+)");
	private static final String[] PET_MESSAGES = {
		"you have a funny feeling like you're being followed",
		"you feel something weird sneaking into your backpack",
	};
	private static final String COLLECTION_LOG_PREFIX = "new item added to your collection log: ";
	private static final String PARTY_PREFIX = "bingo-";
	private static final long SAVE_THROTTLE_MS = 15_000;
	private static final long BROADCAST_THROTTLE_MS = 10_000;
	private static final long STORE_POST_THROTTLE_MS = 15_000;
	private static final long STORE_POLL_SECONDS = 120;
	/** Hosts can tune polling; anything outside these bounds is clamped into range. */
	private static final long STORE_POLL_MIN_SECONDS = 60;
	private static final long STORE_POLL_MAX_SECONDS = 900;
	/** A session is live when it spoke within this window (heartbeats come every poll). */
	private static final int MAX_PROGRESS_MESSAGES_PER_EVENT = 3;
	private static final int TILES_PER_MESSAGE = 25;

	@Inject
	private Client client;

	@Inject
	private ClientThread clientThread;

	@Inject
	private ClientToolbar clientToolbar;

	@Inject
	private ConfigManager configManager;

	@Inject
	private ItemManager itemManager;

	@Inject
	private Notifier notifier;

	@Inject
	private ChatMessageManager chatMessageManager;

	@Inject
	private PartyService partyService;

	@Inject
	private WSClient wsClient;

	@Inject
	private BingoDiscordNotifier discordNotifier;

	@Inject
	private BingoTeamStore teamStore;

	@Inject
	private ScheduledExecutorService executor;

	@Inject
	private Gson gson;

	@Inject
	private IronsPubBingoConfig config;

	private IronsPubBingoPanel panel;
	private NavigationButton navButton;
	private BingoBoardWindow boardWindow;
	private ScheduledFuture<?> storePollTask;

	@Getter
	private BingoBoard board;
	private String boardKey;
	/** This account's own progress. */
	private final Map<Integer, TileProgress> progress = new HashMap<>();
	/** Last known progress per teammate, keyed by account hash, cached across sessions. */
	private final Map<String, TeamMemberState> teamProgress = new HashMap<>();
	/** Host-defined teams from the store's Teams tab (code -> display name), if any. */
	private final Map<String, String> storeTeamNames = new LinkedHashMap<>();
	/** Every team's points on this board, best first, from the store's Scores tab. */
	private final List<BingoTeamStore.Standing> storeStandings = new ArrayList<>();
	/** Members evicted from the current team scope; ignored in every merge, never relayed. */
	private final Set<String> removedMembers = new HashSet<>();
	/** Tiles with XP-only changes waiting for the next throttled team broadcast. */
	private final Set<Integer> pendingBroadcast = new HashSet<>();
	private long lastSaveMs;
	private long lastBroadcastMs;
	private long lastStorePostMs;
	private boolean dirty;
	/** Error from the last team store attempt, or null when it succeeded. */
	private String storeError;
	/** Time of the last successful team store sync, or null. */
	private String storeSyncedAt;
	/** Last confirmed display name of the logged in account, per RS profile. */
	private String lastKnownName;
	/** Highest board revision seen from a teammate, when newer than ours. */
	private Integer newerBoardVersion;
	/** The newer revision came from the store itself, so Import from store has it. */
	private boolean newerBoardFromStore;
	/** Store key the board definition was last uploaded for. */
	private String metaSentForBoard;
	/** Last total Agility XP seen, for lap detection; -1 = unseeded (never count a seed). */
	private long lastAgilityXp = -1;
	/** Tick of the last pickpocket message, to ignore the loot the server announces for it. */
	private int pickpocketTick = -1;
	/**
	 * What the store last accepted from us, member id -> serialized state. Polls resend
	 * only members whose state changed since; the server merges per tile anyway, so a
	 * partial push is exactly as correct as a full one and far smaller. Cleared whenever
	 * the scope changes (board, team, mode, store generation) or a push fails.
	 */
	private final Map<String, String> storePushed = new HashMap<>();
	/** Marks of grace held at the last inventory change; -1 = unseeded (never count a seed). */
	private int lastMarkCount = -1;
	/** Marks dropped while on a course; re-picking them up must not count again. */
	private int markDropDebt;
	/** A team-code change awaits the player's confirmation; store pushes pause meanwhile. */
	private boolean teamSwitchPending;
	/** SHA-256 of the exact board code this client imported; null without a board. */
	private String boardCodeHash;
	/** Swallows the ConfigChanged fired by our own revert of a cancelled team switch. */
	private boolean revertingTeamCode;
	/** Store requests in flight; the panel shows a syncing indicator while > 0. */
	private int storeRequestsInFlight;
	/**
	 * Session-level store pause (panel button): stop store traffic without leaving the
	 * team - like being offline, not like switching teams, so no reset. Not persisted.
	 */
	private boolean storePaused;
	/**
	 * Effective minimum ms between store pushes: the host can raise it via the sheet's
	 * Settings tab (for big events on one deployment), but never below the plugin's own
	 * default and never above a sane cap. Completions bypass it either way.
	 */
	/** Seconds between store polls; the host can raise this from the Settings tab. */
	private long storePollSeconds = STORE_POLL_SECONDS;

	@Provides
	IronsPubBingoConfig provideConfig(ConfigManager configManager)
	{
		return configManager.getConfig(IronsPubBingoConfig.class);
	}

	@Override
	protected void startUp()
	{
		wsClient.registerMessage(IronsPubBingoMemberState.class);
		wsClient.registerMessage(IronsPubBingoSyncRequest.class);
		wsClient.registerMessage(IronsPubBingoPing.class);

		String savedBoard = configManager.getConfiguration(IronsPubBingoConfig.GROUP, "board");
		if (savedBoard != null)
		{
			try
			{
				BingoBoard parsed = BingoBoard.parse(gson, savedBoard);
				activateBoard(parsed);
				boardCodeHash = boardFingerprint(savedBoard);
			}
			catch (IllegalArgumentException e)
			{
				log.warn("Saved bingo board no longer parses: {}", e.getMessage());
			}
		}

		panel = new IronsPubBingoPanel(this);
		navButton = NavigationButton.builder()
			.tooltip("Irons Pub Bingo")
			.icon(ImageUtil.loadImageResource(IronsPubBingoPlugin.class, "panel_icon.png"))
			.priority(7)
			.panel(panel)
			.build();
		clientToolbar.addNavigation(navButton);

		schedulePoll();

		SwingUtilities.invokeLater(() -> panel.rebuild());
	}

	/** (Re)starts the store poll at the current interval. */
	private void schedulePoll()
	{
		if (storePollTask != null)
		{
			storePollTask.cancel(false);
		}
		storePollTask = executor.scheduleWithFixedDelay(
			() -> clientThread.invokeLater(() ->
			{
				syncStore(false);
				sendPresencePing();
				refreshPanel(); // liveness decays with time, not only with events
			}),
			storePollSeconds, storePollSeconds, TimeUnit.SECONDS);
	}

	@Override
	protected void shutDown()
	{
		if (storePollTask != null)
		{
			storePollTask.cancel(false);
			storePollTask = null;
		}
		flushBroadcast();
		saveProgress(true);
		wsClient.unregisterMessage(IronsPubBingoMemberState.class);
		wsClient.unregisterMessage(IronsPubBingoSyncRequest.class);
		wsClient.unregisterMessage(IronsPubBingoPing.class);
		clientToolbar.removeNavigation(navButton);
		navButton = null;
		if (panel != null)
		{
			panel.stopTimers();
		}
		panel = null;
		if (boardWindow != null)
		{
			BingoBoardWindow window = boardWindow;
			boardWindow = null;
			SwingUtilities.invokeLater(window::dispose);
		}
	}

	/** Opens (or fronts) the pop-out board window. Swing thread only. */
	void openBoardWindow()
	{
		if (boardWindow == null)
		{
			boardWindow = new BingoBoardWindow(this);
		}
		boardWindow.open();
	}

	boolean popOutAlwaysOnTop()
	{
		return config.popOutAlwaysOnTop();
	}

	@Subscribe
	public void onConfigChanged(ConfigChanged event)
	{
		if (!IronsPubBingoConfig.GROUP.equals(event.getGroup()))
		{
			return;
		}
		if ("popOutAlwaysOnTop".equals(event.getKey()))
		{
			BingoBoardWindow window = boardWindow;
			if (window != null)
			{
				SwingUtilities.invokeLater(() -> window.setAlwaysOnTop(config.popOutAlwaysOnTop()));
			}
			return;
		}
		if ("teamCode".equals(event.getKey()))
		{
			if (revertingTeamCode)
			{
				revertingTeamCode = false;
				return;
			}
			// Pause store pushes IMMEDIATELY: the config already names the new team, and
			// a poll firing before the switch handler runs would push the old team's
			// cached members into the new team's scope.
			teamSwitchPending = true;
			String oldRawCode = event.getOldValue();
			clientThread.invokeLater(() -> onTeamCodeChanged(oldRawCode));
			return;
		}
		if ("teamStoreEnabled".equals(event.getKey()))
		{
			if (revertingTeamCode)
			{
				revertingTeamCode = false;
				return;
			}
			teamSwitchPending = true;
			boolean wasOn = "true".equals(event.getOldValue());
			clientThread.invokeLater(() -> onStoreToggleChanged(wasOn));
			return;
		}
		if ("teamSyncUrl".equals(event.getKey()))
		{
			refreshPanel();
			return;
		}
		// Display settings (line style, progress fill, ...) apply live.
		refreshPanel();
	}

	/** Called from the pop-out window: select the tile in the sidebar detail view. */
	void selectTileInPanel(int tileIndex)
	{
		IronsPubBingoPanel p = panel;
		if (p != null)
		{
			p.selectTile(tileIndex);
		}
		refreshBoardWindow();
	}

	/** The tile selected in the sidebar, or -1. Swing thread only. */
	int selectedTileIndex()
	{
		IronsPubBingoPanel p = panel;
		return p != null ? p.getSelectedTile() : -1;
	}

	/** Repaints the pop-out board (e.g. after the panel-side selection changed). Swing thread only. */
	void refreshBoardWindow()
	{
		BingoBoardWindow window = boardWindow;
		if (window != null && window.isVisible())
		{
			window.refresh();
		}
	}

	// ---------------------------------------------------------------- board management

	/**
	 * Parses, validates, stores and activates a board.
	 *
	 * @return an error message for the user, or null on success
	 */
	String loadBoardFromJson(String json)
	{
		BingoBoard parsed;
		try
		{
			parsed = BingoBoard.parse(gson, json);
		}
		catch (IllegalArgumentException e)
		{
			return e.getMessage();
		}
		activateBoard(parsed);
		boardCodeHash = boardFingerprint(json);
		configManager.setConfiguration(IronsPubBingoConfig.GROUP, "board", json);
		// An explicit import means "start counting from now": restored progress may carry
		// baselines from an old session, and the login stat burst would otherwise credit
		// everything trained since then as instant gain.
		clientThread.invokeLater(() ->
		{
			reseedXpBaselines();
			announceToTeam();
			syncStore(true);
		});
		return null;
	}

	/**
	 * Restarts XP counting from here. A skill reads 0 XP until the login packet lands, so
	 * 0 is treated as "not known yet" rather than as a baseline - a 0 baseline would turn
	 * the login stat burst into "you just gained your entire woodcutting total". Unknown
	 * baselines are seeded by that skill's next stat update instead.
	 */
	private void reseedXpBaselines()
	{
		if (board == null)
		{
			return;
		}
		visitGoals((tile, goal, p) ->
		{
			if (goal.goalType == GoalType.XP)
			{
				int xp = client.getSkillExperience(goal.skillEnum);
				p.baseline = xp > 0 ? (long) xp : null;
			}
			return false;
		});
		int agility = client.getSkillExperience(Skill.AGILITY);
		lastAgilityXp = agility > 0 ? agility : -1;
		saveProgress(false);
	}

	/**
	 * The board as the team store needs it to render a readable view for admins: tile
	 * labels, per-goal labels and targets. No progress, no player data.
	 */
	private Object buildBoardMeta()
	{
		if (board == null)
		{
			return null;
		}
		Map<String, Object> meta = new HashMap<>();
		meta.put("name", board.getName());
		meta.put("size", board.getSize());
		// Board geometry and bonus values, so the store's own announcements (admin
		// verified completions) can mirror the plugin's line/blackout messages.
		meta.put("diagonals", board.diagonalsCount());
		meta.put("linePoints", board.linePointsValue());
		meta.put("blackoutPoints", board.blackoutPointsValue());
		List<Object> tiles = new ArrayList<>();
		for (BingoTile tile : board.getTiles())
		{
			Map<String, Object> tileMeta = new HashMap<>();
			tileMeta.put("label", tile.label);
			tileMeta.put("mode", tile.anyMode ? "ANY" : "ALL");
			List<Object> goals = new ArrayList<>();
			for (BingoGoal goal : tile.goals)
			{
				// Manual goals ride along too: leaving them out shifted every later
				// goal's index, so mixed tiles' progress and admin credit landed on
				// the wrong columns - and manual-only tiles vanished from the portal.
				Map<String, Object> goalMeta = new HashMap<>();
				goalMeta.put("label", goal.shortDescribe());
				goalMeta.put("target", goal.target());
				goalMeta.put("distinct", goal.usesMatchedSet());
				goalMeta.put("manual", goal.goalType == GoalType.MANUAL);
				goals.add(goalMeta);
			}
			tileMeta.put("goals", goals);
			tiles.add(tileMeta);
		}
		meta.put("tiles", tiles);
		return meta;
	}

	private void activateBoard(BingoBoard parsed)
	{
		newerBoardVersion = null;
		newerBoardFromStore = false;
		metaSentForBoard = null;
		storeError = null; // whatever the store objected to, it was about the old board
		board = parsed;
		// Stable id when the host set one (board hotfixes keep progress), otherwise a
		// canonical content hash, so whitespace differences in the pasted JSON don't
		// put teammates on different keys.
		boardKey = parsed.storageKey(gson);
		storePushed.clear();
		loadProgress();
	}

	/** Whether automatic tracking counts right now (inside the board's event window, if any). */
	private boolean trackingActive()
	{
		if (board == null)
		{
			return false;
		}
		long now = System.currentTimeMillis();
		if (board.startTime != null && now < board.startTime.toEpochMilli())
		{
			return false;
		}
		return board.endTime == null || now <= board.endTime.toEpochMilli();
	}

	/** Remaining time as days:hours:minutes:seconds, e.g. "2:13:45:09". */
	static String formatCountdown(long millis)
	{
		long totalSeconds = Math.max(0, millis / 1000);
		return String.format("%d:%02d:%02d:%02d",
			totalSeconds / 86400,
			(totalSeconds % 86400) / 3600,
			(totalSeconds % 3600) / 60,
			totalSeconds % 60);
	}

	/** Panel line describing the event window as a live countdown, or "" when none. */
	String eventStatusText()
	{
		if (board == null)
		{
			return "";
		}
		long now = System.currentTimeMillis();
		if (board.startTime != null && now < board.startTime.toEpochMilli())
		{
			return "Event starts in " + formatCountdown(board.startTime.toEpochMilli() - now)
				+ " - tracking paused";
		}
		if (board.endTime != null && now > board.endTime.toEpochMilli())
		{
			return "Event ended - tracking stopped";
		}
		if (board.endTime != null)
		{
			return "Time left: " + formatCountdown(board.endTime.toEpochMilli() - now);
		}
		return "";
	}

	/** Absolute start/end times for the countdown's tooltip, or null when none. */
	String eventWindowTooltip()
	{
		if (board == null || (board.startTime == null && board.endTime == null))
		{
			return null;
		}
		SimpleDateFormat format = new SimpleDateFormat("EEE d MMM yyyy, HH:mm");
		StringBuilder text = new StringBuilder("<html>");
		if (board.startTime != null)
		{
			text.append("Starts: ").append(format.format(new Date(board.startTime.toEpochMilli())));
		}
		if (board.endTime != null)
		{
			text.append(board.startTime != null ? "<br>" : "")
				.append("Ends: ").append(format.format(new Date(board.endTime.toEpochMilli())));
		}
		return text.append("</html>").toString();
	}

	/**
	 * Non-fatal notes about the loaded board, shown once after import so hosts catch
	 * mistakes (unresolvable icons, unlabelled chat patterns) before the event.
	 */
	List<String> lintBoard()
	{
		List<String> notes = new ArrayList<>();
		if (board == null)
		{
			return notes;
		}
		for (int i = 0; i < board.getTiles().size(); i++)
		{
			BingoTile tile = board.getTiles().get(i);
			if (tile.iconName != null)
			{
				iconFor(tile);
				if (tile.resolvedIconId <= 0)
				{
					notes.add("Tile " + (i + 1) + " \"" + tile.label + "\": icon \"" + tile.iconName
						+ "\" not found - untradeable items need a numeric item ID");
				}
			}
			for (BingoGoal goal : tile.goals)
			{
				if (goal.goalType == GoalType.CHAT
					&& (goal.name == null || goal.name.trim().isEmpty())
					&& BingoGoal.readablePattern(goal.pattern) == null)
				{
					notes.add("Tile " + (i + 1) + " \"" + tile.label
						+ "\": chat pattern has no readable text - set a progress bar label in the board");
				}
			}
		}
		return notes;
	}

	/** Warning when a teammate runs a newer revision of this board, or null. */
	String boardUpdateNotice()
	{
		if (newerBoardVersion == null)
		{
			return null;
		}
		return newerBoardFromStore
			? "Board v" + newerBoardVersion + " is out - reimport it: Setup, Import board, Import from store"
			: "Board v" + newerBoardVersion + " is out - ask your host for the new board code";
	}

	/** Board name plus revision, e.g. "Summer Bingo (v2)". */
	String boardTitleText()
	{
		if (board == null)
		{
			return "No board loaded";
		}
		return board.getName() + (board.version != null ? " (v" + board.version + ")" : "");
	}

	void clearBoard()
	{
		saveProgress(true);
		newerBoardVersion = null;
		newerBoardFromStore = false;
		board = null;
		boardKey = null;
		boardCodeHash = null;
		progress.clear();
		teamProgress.clear();
		pendingBroadcast.clear();
		configManager.unsetConfiguration(IronsPubBingoConfig.GROUP, "board");
	}

	// ---------------------------------------------------------------- progress persistence

	private void loadProgress()
	{
		progress.clear();
		teamProgress.clear();
		pendingBroadcast.clear();
		if (configManager.getRSProfileKey() != null)
		{
			lastKnownName = configManager.getRSProfileConfiguration(IronsPubBingoConfig.GROUP, "ownName");
		}
		if (boardKey == null || configManager.getRSProfileKey() == null)
		{
			return;
		}
		Map<Integer, TileProgress> own = readJsonConfig("progress_" + boardKey,
			new TypeToken<Map<Integer, TileProgress>>()
			{
			}.getType());
		if (own != null)
		{
			progress.putAll(own);
		}
		Map<String, TeamMemberState> team = readJsonConfig(teamCacheKey(normalizedTeamCode()),
			new TypeToken<Map<String, TeamMemberState>>()
			{
			}.getType());
		if (team != null)
		{
			teamProgress.putAll(team);
		}
		loadRemovedMembers();
		enforceTeamOwnership();
		reconcileTileSignatures();
	}

	private static final Type STRING_LIST = new TypeToken<List<String>>()
	{
	}.getType();

	/**
	 * Resets tiles whose tracking definition changed since this profile last saw the
	 * board. Board edits keep the id (and so the progress); when a tile starts tracking
	 * something ELSE - a drop counter becomes a manual tile - its old numbers describe
	 * nothing and would leak into the new goals. Targets are not part of the signature,
	 * so tuning a count keeps progress. Runs on login and on every import.
	 */
	private void reconcileTileSignatures()
	{
		if (board == null || configManager.getRSProfileKey() == null)
		{
			return;
		}
		List<String> current = new ArrayList<>();
		for (BingoTile tile : board.getTiles())
		{
			current.add(tile.trackingSignature());
		}
		List<String> saved = readJsonConfig("sigs3_" + boardKey, STRING_LIST);
		if (saved != null)
		{
			Set<Integer> resetTiles = new HashSet<>();
			long now = System.currentTimeMillis();
			for (int i = 0; i < current.size() && i < saved.size(); i++)
			{
				if (!current.get(i).equals(saved.get(i)) && progress.containsKey(i))
				{
					// Fresh timestamp: the empty state must WIN the LWW merge, or
					// teammates' caches would push the stale numbers right back.
					progress.remove(i);
					progressFor(i).ts = now;
					resetTiles.add(i);
				}
			}
			if (!resetTiles.isEmpty())
			{
				// Teammates' cached copies of OTHER members stay; each member's own
				// client wipes its side the same way when they import the new board.
				log.debug("Tracking changed on {} tile(s); resetting their progress", resetTiles.size());
				broadcastOwnTiles(resetTiles);
				syncStore(true);
				saveProgress(true);
			}
		}
		if (!current.equals(saved))
		{
			configManager.setRSProfileConfiguration(IronsPubBingoConfig.GROUP,
				"sigs3_" + boardKey, gson.toJson(current));
		}
	}

	private <T> T readJsonConfig(String key, Type type)
	{
		String json = configManager.getRSProfileConfiguration(IronsPubBingoConfig.GROUP, key);
		if (json == null)
		{
			return null;
		}
		try
		{
			return gson.fromJson(json, type);
		}
		catch (JsonSyntaxException e)
		{
			log.warn("Could not load saved bingo state for {}", key, e);
			return null;
		}
	}

	private void saveProgress(boolean force)
	{
		if (board == null || boardKey == null || configManager.getRSProfileKey() == null)
		{
			return;
		}
		long now = System.currentTimeMillis();
		if (!force && now - lastSaveMs < SAVE_THROTTLE_MS)
		{
			dirty = true;
			return;
		}
		configManager.setRSProfileConfiguration(IronsPubBingoConfig.GROUP, "progress_" + boardKey, gson.toJson(progress));
		configManager.setRSProfileConfiguration(IronsPubBingoConfig.GROUP,
			teamCacheKey(normalizedTeamCode()), gson.toJson(teamProgress));
		lastSaveMs = now;
		dirty = false;
	}

	TileProgress progressFor(int tileIndex)
	{
		return progress.computeIfAbsent(tileIndex, k -> new TileProgress());
	}

	/**
	 * The team view of a tile: own progress merged with every teammate's last known progress.
	 */
	TileProgress mergedProgressFor(int tileIndex)
	{
		TileProgress own = progressFor(tileIndex);
		Map<String, TeamMemberState> team = activeTeamProgress();
		if (team.isEmpty())
		{
			return own;
		}
		List<TileProgress> all = new ArrayList<>();
		all.add(own);
		for (TeamMemberState member : team.values())
		{
			TileProgress tp = member.tilesMap().get(tileIndex);
			if (tp != null)
			{
				all.add(tp);
			}
		}
		if (all.size() == 1)
		{
			return own;
		}
		return TileProgress.merge(board.getTiles().get(tileIndex).goals.size(), all);
	}

	boolean hasTeamData()
	{
		return !activeTeamProgress().isEmpty();
	}

	/**
	 * Everyone known to be on this team - you, plus every teammate the caches have seen -
	 * sorted, own name first. Membership, not presence: nothing here says who is online.
	 */
	List<String> teamMemberNames()
	{
		Set<String> names = new TreeSet<>(String.CASE_INSENSITIVE_ORDER);
		for (Map.Entry<String, TeamMemberState> entry : activeTeamProgress().entrySet())
		{
			if (!isAdminMember(entry.getKey()) && entry.getValue().name != null
				&& !entry.getValue().name.isEmpty())
			{
				names.add(entry.getValue().name);
			}
		}
		String own = localPlayerName();
		List<String> ordered = new ArrayList<>();
		if (own != null)
		{
			names.remove(own);
			ordered.add(own);
		}
		ordered.addAll(names);
		return ordered;
	}

	/**
	 * Per-member progress on a tile (own account first), keyed by display name — for
	 * showing who contributed what in the tile detail view.
	 */
	Map<String, TileProgress> memberProgressFor(int tileIndex)
	{
		Map<String, TileProgress> result = new java.util.LinkedHashMap<>();
		String ownName = localPlayerName();
		result.put(ownName != null ? ownName : "You", progressFor(tileIndex));
		for (TeamMemberState member : activeTeamProgress().values())
		{
			TileProgress tp = member.tilesMap().get(tileIndex);
			if (tp == null)
			{
				continue;
			}
			String name = member.name == null || member.name.isEmpty() ? "Unknown" : member.name;
			while (result.containsKey(name))
			{
				name += " *";
			}
			result.put(name, tp);
		}
		return result;
	}

	/**
	 * The tile's item icon from the game cache, or null if the tile has none.
	 * Name icons are resolved against the item price list (tradeable items).
	 */
	AsyncBufferedImage iconFor(BingoTile tile)
	{
		if (tile.iconItemId > 0)
		{
			return itemManager.getImage(tile.iconItemId);
		}
		if (tile.iconName == null)
		{
			return null;
		}
		if (tile.resolvedIconId == 0)
		{
			tile.resolvedIconId = -1;
			List<ItemPrice> results = itemManager.search(tile.iconName);
			for (ItemPrice result : results)
			{
				if (result.getName().equalsIgnoreCase(tile.iconName))
				{
					tile.resolvedIconId = result.getId();
					break;
				}
			}
			if (tile.resolvedIconId == -1 && !results.isEmpty())
			{
				tile.resolvedIconId = results.get(0).getId();
			}
		}
		return tile.resolvedIconId > 0 ? itemManager.getImage(tile.resolvedIconId) : null;
	}

	// ---------------------------------------------------------------- team identity

	private long memberIdSourceHash = -1;
	private String memberIdCache;

	/**
	 * Stable member key for the logged in account, or null pre-login. A SHA-256 prefix of
	 * the account hash: stable across name changes, but the raw account identifier never
	 * leaves the client.
	 */
	private String localMemberId()
	{
		long hash = client.getAccountHash();
		if (hash == -1)
		{
			return null;
		}
		if (hash != memberIdSourceHash)
		{
			memberIdCache = deriveMemberId(hash);
			memberIdSourceHash = hash;
		}
		return memberIdCache;
	}

	static String deriveMemberId(long accountHash)
	{
		try
		{
			MessageDigest digest = MessageDigest.getInstance("SHA-256");
			byte[] out = digest.digest(Long.toString(accountHash).getBytes(StandardCharsets.UTF_8));
			StringBuilder sb = new StringBuilder(16);
			for (int i = 0; i < 8; i++)
			{
				sb.append(String.format("%02x", out[i]));
			}
			return sb.toString();
		}
		catch (NoSuchAlgorithmException e)
		{
			// SHA-256 is guaranteed on every JVM
			throw new IllegalStateException(e);
		}
	}

	/**
	 * Fingerprint of the exact board code this client runs, sent with every store sync.
	 * When the host pasted the official code on the sheet, the store rejects any other
	 * board - so locally editing a goal (easier items, same board id) stops syncing.
	 */
	static String boardFingerprint(String rawBoardJson)
	{
		try
		{
			MessageDigest digest = MessageDigest.getInstance("SHA-256");
			byte[] out = digest.digest(rawBoardJson.trim().getBytes(StandardCharsets.UTF_8));
			StringBuilder sb = new StringBuilder(64);
			for (byte b : out)
			{
				sb.append(String.format("%02x", b));
			}
			return sb.toString();
		}
		catch (NoSuchAlgorithmException e)
		{
			throw new IllegalStateException(e);
		}
	}

	private String localPlayerName()
	{
		if (client.getLocalPlayer() != null && client.getLocalPlayer().getName() != null)
		{
			String name = Text.removeTags(client.getLocalPlayer().getName());
			if (!name.isEmpty() && !name.equals(lastKnownName))
			{
				// Remember it for the moments the live name is unavailable (early login).
				lastKnownName = name;
				if (configManager.getRSProfileKey() != null)
				{
					configManager.setRSProfileConfiguration(IronsPubBingoConfig.GROUP, "ownName", name);
				}
			}
			return name;
		}
		if (lastKnownName != null)
		{
			return lastKnownName;
		}
		PartyMember local = partyService.getLocalMember();
		String partyName = local != null ? local.getDisplayName() : null;
		return partyName == null || partyName.isEmpty() || partyName.startsWith("<") ? null : partyName;
	}

	// ---------------------------------------------------------------- team sync: party layer

	private String normalizedTeamCode()
	{
		return normalizeTeamCode(config.teamCode());
	}

	private static String normalizeTeamCode(String raw)
	{
		if (raw == null)
		{
			return null;
		}
		String code = raw.trim().toLowerCase(Locale.ROOT)
			.replaceAll("[^a-z0-9-]+", "-").replaceAll("(^-+|-+$)", "");
		return code.isEmpty() ? null : code;
	}

	/**
	 * Cached teammate states are scoped per team, not just per board: switching team codes
	 * on the same board must never carry the old team's members into the new team's store.
	 * A switch deletes both sides of the key anyway (see {@link #dropCachedTeammates}).
	 */
	private String teamCacheKey(String teamCode)
	{
		return "team3_" + boardKey + "_" + (teamCode == null ? "solo" : teamCode);
	}

	private String expectedPassphrase()
	{
		String code = normalizedTeamCode();
		return code == null ? null : PARTY_PREFIX + code;
	}

	/**
	 * The key this team's data lives under in the team store. Includes the team code, so
	 * one store deployment can serve a whole event without two teams on the same board
	 * silently merging their progress.
	 */
	private String storeScopedKey()
	{
		String code = normalizedTeamCode();
		return boardKey + "_" + (code == null ? "solo" : code);
	}

	/** Whether we are in any RuneLite party at all (possibly not the bingo one). */
	boolean inAnyParty()
	{
		return partyService.isInParty();
	}

	/** Whether we are in the party belonging to our configured bingo team code. */
	boolean inTeamParty()
	{
		String expected = expectedPassphrase();
		return expected != null && partyService.isInParty()
			&& expected.equals(partyService.getPartyPassphrase());
	}

	/**
	 * Joins the team party for the configured team code.
	 *
	 * @return an error message for the user, or null on success
	 */
	String joinTeam()
	{
		String expected = expectedPassphrase();
		if (expected == null)
		{
			return "Set a team code in the Irons Pub Bingo settings first (ask your bingo host).";
		}
		partyService.changeParty(expected);
		return null;
	}

	/**
	 * Reacts to the team code being edited while the plugin runs. Without this the plugin
	 * sat in the old team's party until the next restart ("In a different party") and kept
	 * pushing the old team's cached members under the new team's store scope.
	 */
	private void onTeamCodeChanged(String oldRawCode)
	{
		String oldCode = normalizeTeamCode(oldRawCode);
		String newCode = normalizedTeamCode();
		if (Objects.equals(oldCode, newCode))
		{
			teamSwitchPending = false; // cosmetic edit, no switch
			return;
		}
		// Progress must not follow a player from one team to another (a defector would
		// count for both teams), so switching resets the board - after asking. Store
		// pushes pause while the dialog is open, or pre-reset progress would already
		// have been pushed under the new team's scope.
		// Ask when there is progress to lose - or when we can't tell (logged out, profile
		// not loaded): the reset then happens at next login via the teamOf invariant.
		if (board != null && (hasOwnProgress() || configManager.getRSProfileKey() == null))
		{
			teamSwitchPending = true;
			SwingUtilities.invokeLater(() ->
			{
				int answer = JOptionPane.showConfirmDialog(panel,
					"Each team keeps its own progress, so this board switches to what you\n"
						+ "have on the new team - nothing you earned here counts for it.\n\n"
						+ "Coming back to this team restores this progress.\n\n"
						+ "Switch team?",
					"Irons Pub Bingo", JOptionPane.OK_CANCEL_OPTION, JOptionPane.WARNING_MESSAGE);
				clientThread.invokeLater(() ->
				{
					teamSwitchPending = false;
					if (answer == JOptionPane.OK_OPTION)
					{
						// Take nothing along and leave nothing behind: the store evicts
						// this account from the old team's scope (tombstoned, so cached
						// copies can't resurrect it) and the fresh state starts at zero.
						enqueueEviction(scopeFor(oldCode));
						switchOwnProgress(oldCode, config.teamStoreEnabled(),
							normalizedTeamCode(), config.teamStoreEnabled());
						applyTeamSwitch(oldCode);
						stampTeamOwnership();
						saveProgress(true);
					}
					else
					{
						revertingTeamCode = true;
						configManager.setConfiguration(IronsPubBingoConfig.GROUP, "teamCode",
							oldRawCode == null ? "" : oldRawCode);
					}
					refreshPanel();
				});
			});
			return;
		}
		teamSwitchPending = false; // must lift before applyTeamSwitch's own sync
		storeError = null; // the old team's rejection says nothing about the new one
		switchOwnProgress(oldCode, config.teamStoreEnabled(), newCode, config.teamStoreEnabled());
		applyTeamSwitch(oldCode);
		stampTeamOwnership();
	}

	/**
	 * The store's generation, which the host's "Reset store data" bumps. A new generation
	 * means the event was wiped there, so everything we cached ABOUT TEAMMATES has to go
	 * as well - relaying it on the next push would rebuild the old event row by row. Our
	 * own tracked progress is ours and stays.
	 */
	private void applyStoreEpoch(Integer epoch)
	{
		if (epoch == null || boardKey == null || configManager.getRSProfileKey() == null)
		{
			return;
		}
		String code = normalizedTeamCode();
		String key = "epoch_" + scopeFor(code);
		String seen = configManager.getRSProfileConfiguration(IronsPubBingoConfig.GROUP, key);
		configManager.setRSProfileConfiguration(IronsPubBingoConfig.GROUP, key, String.valueOf(epoch));
		if (seen == null || seen.equals(String.valueOf(epoch)))
		{
			return;
		}
		log.debug("Store generation {} -> {}, dropping cached team data", seen, epoch);
		storePushed.clear();
		teamProgress.clear();
		removedMembers.clear();
		configManager.unsetRSProfileConfiguration(IronsPubBingoConfig.GROUP, removedCacheKey(code));
		saveProgress(true);
	}

	private String scopeFor(String teamCode)
	{
		return boardKey + "_" + (teamCode == null ? "solo" : teamCode);
	}

	private static final Type STRING_SET = new TypeToken<Set<String>>()
	{
	}.getType();

	/**
	 * Queues a store eviction of this account from a team scope. Persisted and retried
	 * (from syncStore ticks and login) until the store confirms, so a switch made while
	 * offline or during a store outage still lands - fire-and-forget would silently leave
	 * the old team counting this player forever.
	 */
	private void enqueueEviction(String scope)
	{
		if (configManager.getRSProfileKey() == null)
		{
			return;
		}
		Set<String> pending = readJsonConfig("pendingEvictions", STRING_SET);
		if (pending == null)
		{
			pending = new HashSet<>();
		}
		if (pending.add(scope))
		{
			configManager.setRSProfileConfiguration(IronsPubBingoConfig.GROUP,
				"pendingEvictions", gson.toJson(pending));
		}
		flushPendingEvictions();
	}

	private void flushPendingEvictions()
	{
		// Only the URL is needed: departures must land even after the sync toggle went off.
		if (!teamStore.hasUrl() || configManager.getRSProfileKey() == null)
		{
			return;
		}
		String self = localMemberId();
		if (self == null)
		{
			return; // not logged in; retried at login and with every store sync
		}
		Set<String> pending = readJsonConfig("pendingEvictions", STRING_SET);
		if (pending == null || pending.isEmpty())
		{
			return;
		}
		for (String scope : pending)
		{
			teamStore.remove(scope, self, () -> clientThread.invokeLater(() ->
			{
				Set<String> current = readJsonConfig("pendingEvictions", STRING_SET);
				if (current != null && current.remove(scope) && configManager.getRSProfileKey() != null)
				{
					configManager.setRSProfileConfiguration(IronsPubBingoConfig.GROUP,
						"pendingEvictions", gson.toJson(current));
				}
			}));
		}
	}

	private String removedCacheKey(String teamCode)
	{
		return "removed3_" + boardKey + "_" + (teamCode == null ? "solo" : teamCode);
	}

	/** Loads the evicted-member tombstones for the current team scope and enforces them. */
	private void loadRemovedMembers()
	{
		removedMembers.clear();
		if (boardKey == null || configManager.getRSProfileKey() == null)
		{
			return;
		}
		Set<String> cached = readJsonConfig(removedCacheKey(normalizedTeamCode()), STRING_SET);
		if (cached != null)
		{
			removedMembers.addAll(cached);
		}
	}

	/**
	 * The teammates who count right now: everyone cached for this team, minus whoever has
	 * left it. A departure is a filter, not a delete - their progress stays cached, so if
	 * they come back (the store clears the "left" mark) it comes back with them.
	 */
	private Map<String, TeamMemberState> activeTeamProgress()
	{
		if (removedMembers.isEmpty())
		{
			return teamProgress;
		}
		Map<String, TeamMemberState> active = new LinkedHashMap<>();
		for (Map.Entry<String, TeamMemberState> entry : teamProgress.entrySet())
		{
			if (!removedMembers.contains(entry.getKey()))
			{
				active.put(entry.getKey(), entry.getValue());
			}
		}
		return active;
	}

	/**
	 * Wipes own progress but stamps every tile with a fresh empty entry: the timestamps
	 * beat any stale copy of the old progress a teammate's cache might later relay, so a
	 * reset can never be undone by gossip (same trick as the per-tile reset button).
	 */
	/** Where this profile's own progress for a team (in one sync mode) waits for a return. */
	private String parkedProgressKey(String teamCode, boolean storeMode)
	{
		return "parked_" + scopeFor(teamCode) + (storeMode ? "_store" : "_party");
	}

	/**
	 * Files the current progress under the team it was earned on, and loads back whatever
	 * this profile last had on the team it is joining. Progress still never moves between
	 * teams - each team keeps its own copy - but leaving one no longer destroys it, so
	 * coming back restores what you had there. XP baselines are reseeded either way: XP
	 * earned while away counted for the other team and must not be credited twice.
	 */
	private void switchOwnProgress(String fromTeam, boolean fromStore, String toTeam, boolean toStore)
	{
		boolean canPark = boardKey != null && configManager.getRSProfileKey() != null;
		if (canPark)
		{
			configManager.setRSProfileConfiguration(IronsPubBingoConfig.GROUP,
				parkedProgressKey(fromTeam, fromStore), gson.toJson(progress));
		}
		Map<Integer, TileProgress> parked = canPark
			? readJsonConfig(parkedProgressKey(toTeam, toStore),
				new TypeToken<Map<Integer, TileProgress>>()
				{
				}.getType())
			: null;
		if (parked == null)
		{
			resetOwnProgress(); // never been on this team: a fresh, freshly stamped board
			return;
		}
		progress.clear();
		pendingBroadcast.clear();
		progress.putAll(parked);
		reseedXpBaselines();
	}

	private void resetOwnProgress()
	{
		progress.clear();
		pendingBroadcast.clear();
		if (board != null)
		{
			long now = System.currentTimeMillis();
			for (int i = 0; i < board.getTiles().size(); i++)
			{
				progressFor(i).ts = now;
			}
		}
		reseedXpBaselines();
	}

	/** Records which team this profile's progress for the current board belongs to. */
	private void stampTeamOwnership()
	{
		if (boardKey != null && configManager.getRSProfileKey() != null)
		{
			String code = normalizedTeamCode();
			configManager.setRSProfileConfiguration(IronsPubBingoConfig.GROUP,
				"teamOf_" + boardKey, code == null ? "solo" : code);
		}
	}

	/**
	 * The robustness invariant behind team switching: progress belongs to the team it was
	 * earned on. If saved progress turns out to belong to a different team than the one
	 * configured (the code changed while logged out, on another account's session, or by
	 * hand), the reset that the switch dialog promised is applied here instead - so no
	 * path exists that carries progress from one team to another.
	 */
	private void enforceTeamOwnership()
	{
		if (boardKey == null || configManager.getRSProfileKey() == null)
		{
			return;
		}
		String code = normalizedTeamCode();
		String current = code == null ? "solo" : code;
		String owner = configManager.getRSProfileConfiguration(IronsPubBingoConfig.GROUP, "teamOf_" + boardKey);
		if (owner == null)
		{
			// Pre-invariant progress (or a fresh board): it belongs to the current team.
			stampTeamOwnership();
			return;
		}
		if (!owner.equals(current))
		{
			log.debug("Progress for {} belonged to team {} - parking it and loading {}", boardKey, owner, current);
			enqueueEviction(boardKey + "_" + owner);
			switchOwnProgress(owner, config.teamStoreEnabled(), code, config.teamStoreEnabled());
			stampTeamOwnership();
			saveProgress(true);
		}
	}

	/**
	 * The store toggle is a team switch in disguise: on = the store team for the code,
	 * off = a custom party-only team. So flipping it follows the same policy as changing
	 * the code - progress never moves between teams. Turning it OFF also evicts this
	 * account from the store team (one departure notice; no other traffic after) and
	 * drops the store-owned "(verified)" members, which nothing else could ever remove
	 * once the store stopped answering.
	 */
	private void onStoreToggleChanged(boolean wasOn)
	{
		boolean nowOn = config.teamStoreEnabled();
		if (wasOn == nowOn)
		{
			teamSwitchPending = false;
			return;
		}
		if (board == null || !hasOwnProgress())
		{
			teamSwitchPending = false; // must lift before the toggle's own sync
			switchOwnProgress(normalizedTeamCode(), wasOn, normalizedTeamCode(), nowOn);
			applyStoreToggle(wasOn);
			return;
		}
		teamSwitchPending = true;
		SwingUtilities.invokeLater(() ->
		{
			int answer = JOptionPane.showConfirmDialog(panel,
				nowOn
						? "Turning the team store ON joins the store team for your code.\n"
							+ "That is a different team, so the board switches to your progress\n"
							+ "there.\n\nJoin the store team?"
						: "Turning the team store OFF leaves the store team - you become a\n"
							+ "custom, party-only team, the board switches to your progress\n"
							+ "there, and you are removed from the store team's board.\n\n"
							+ "Leave the store team?",
				"Irons Pub Bingo", JOptionPane.OK_CANCEL_OPTION, JOptionPane.WARNING_MESSAGE);
			clientThread.invokeLater(() ->
			{
				teamSwitchPending = false;
				if (answer == JOptionPane.OK_OPTION)
				{
					switchOwnProgress(normalizedTeamCode(), wasOn, normalizedTeamCode(), !wasOn);
					applyStoreToggle(wasOn);
					saveProgress(true);
				}
				else
				{
					revertingTeamCode = true;
					configManager.setConfiguration(IronsPubBingoConfig.GROUP, "teamStoreEnabled", wasOn);
				}
				refreshPanel();
			});
		});
	}

	private void applyStoreToggle(boolean wasOn)
	{
		storeRequestsInFlight = 0; // toggling modes invalidates any in-flight accounting
		storePushed.clear();
		storeStandings.clear();
		if (wasOn)
		{
			// Leaving the store team: the departure notice tombstones this account there,
			// and the verified members belong to the store - without one they're gone.
			if (boardKey != null)
			{
				enqueueEviction(scopeFor(normalizedTeamCode()));
			}
			teamProgress.keySet().removeIf(id -> isAdminMember(id));
			storeError = null;
		}
		else
		{
			syncStore(true); // joining: pull the store team's state (rejoin heals old tombstones)
		}
		refreshPanel();
	}

	/** Whether any tile holds real progress (counters, matched items or a manual tick). */
	private boolean hasOwnProgress()
	{
		for (TileProgress p : progress.values())
		{
			if (p.manual)
			{
				return true;
			}
			if (p.goals == null)
			{
				continue;
			}
			for (GoalProgress g : p.goals)
			{
				if (g != null && (g.n > 0 || (g.matched != null && !g.matched.isEmpty())))
				{
					return true;
				}
			}
		}
		return false;
	}

	/** Swaps party membership and the per-team member cache over to the new team code. */
	private void applyTeamSwitch(String oldCode)
	{
		storePushed.clear();
		teamProgress.clear();
		if (boardKey != null && configManager.getRSProfileKey() != null)
		{
			// Park the old team's cached members under their own key, so coming back
			// restores them, and start from whatever is cached for the new team. What
			// each team shows is then filtered by that team's departures.
			configManager.setRSProfileConfiguration(IronsPubBingoConfig.GROUP,
				teamCacheKey(oldCode), gson.toJson(teamProgress));
			Map<String, TeamMemberState> cached = readJsonConfig(teamCacheKey(normalizedTeamCode()),
				new TypeToken<Map<String, TeamMemberState>>()
				{
				}.getType());
			if (cached != null)
			{
				teamProgress.putAll(cached);
			}
			loadRemovedMembers();
		}
		// Follow the code into its party - but only if we were in the old team's party.
		// Never pull the player out of an unrelated party (e.g. a raid).
		String oldPassphrase = oldCode == null ? null : PARTY_PREFIX + oldCode;
		if (partyService.isInParty() && oldPassphrase != null
			&& oldPassphrase.equals(partyService.getPartyPassphrase()))
		{
			partyService.changeParty(expectedPassphrase());
		}
		syncStore(true);
		refreshPanel();
	}

	void leaveTeam()
	{
		if (partyService.isInParty())
		{
			partyService.changeParty(null);
		}
	}

	/** The panel's "Sync team" button: exchange progress over party and team store. */
	void requestTeamSync()
	{
		if (board == null)
		{
			return;
		}
		announceToTeam();
		syncStore(true);
		// A manual sync restarts the poll clock: the next automatic sync comes one
		// full interval from now, not moments after this one.
		schedulePoll();
	}

	void resetTeamData()
	{
		teamProgress.clear();
		if (boardKey != null && configManager.getRSProfileKey() != null)
		{
			configManager.unsetRSProfileConfiguration(IronsPubBingoConfig.GROUP, teamCacheKey(normalizedTeamCode()));
		}
		refreshPanel();
	}

	/** Replaces the cached host-defined team list; null (fetch failed) leaves it alone. */
	private void cacheStoreTeams(List<BingoTeamStore.TeamInfo> teams)
	{
		if (teams == null)
		{
			return;
		}
		storeTeamNames.clear();
		for (BingoTeamStore.TeamInfo team : teams)
		{
			if (team != null && team.code != null)
			{
				storeTeamNames.put(team.code, team.name == null ? "" : team.name);
			}
		}
	}

	/**
	 * Which team mode the current code is in, or null when there is nothing to
	 * distinguish (no code, or the store host defined no teams). Makes it obvious in the
	 * panel whether the code came from the host's list or was typed by hand.
	 */
	String teamModeText()
	{
		String code = normalizedTeamCode();
		if (code == null || storeTeamNames.isEmpty() || !teamStore.isConfigured())
		{
			return null; // no store in play: nothing to distinguish
		}
		return storeTeamNames.containsKey(code) ? "store team" : "custom code, party-only";
	}

	/**
	 * Display team name. For a store team the sheet's name is authoritative (the host
	 * named it); the local Team name setting only labels custom-code teams, else the code.
	 */
	String teamDisplayName()
	{
		String code = normalizedTeamCode();
		// The sheet's name only applies while the store is actually in use - with the
		// toggle off this is a plain custom-code team, whatever the cache still holds.
		String sheetName = code == null || !teamStore.isConfigured() ? null : storeTeamNames.get(code);
		if (sheetName != null && !sheetName.isEmpty())
		{
			return sheetName;
		}
		String name = config.teamName().trim();
		if (!name.isEmpty())
		{
			return name;
		}
		return code;
	}

	/** Whether an account is active (LOGGED_IN, or briefly LOADING/HOPPING mid-session). */
	boolean isLoggedIn()
	{
		GameState state = client.getGameState();
		return state == GameState.LOGGED_IN || state == GameState.LOADING
			|| state == GameState.HOPPING;
	}

	boolean storeConfigured()
	{
		return teamStore.isConfigured();
	}

	/**
	 * The team's 1-based placement among all teams on this board, or 0 when it doesn't
	 * apply (no store, no code, fewer than two scoring teams, or team not scored yet).
	 */
	int placementRank()
	{
		String code = normalizedTeamCode();
		if (!teamStore.isConfigured() || code == null || storeStandings.size() < 2)
		{
			return 0;
		}
		for (int i = 0; i < storeStandings.size(); i++)
		{
			if (code.equals(storeStandings.get(i).team))
			{
				return i + 1;
			}
		}
		return 0;
	}

	/** The team store URL, which doubles as the player portal in a browser; null if unset. */
	String portalUrl()
	{
		String url = config.teamSyncUrl().trim();
		return url.isEmpty() ? null : url;
	}

	/** The panel's "Choose team" picker: the host-defined teams from the store's sheet. */
	void fetchStoreTeams(java.util.function.BiConsumer<List<BingoTeamStore.TeamInfo>, String> callback)
	{
		teamStore.fetchTeams(boardKey, callback);
	}

	/** The panel's "Get board from store": the board code the host pasted on the sheet. */
	void fetchStoreBoard(java.util.function.BiConsumer<String, String> callback)
	{
		teamStore.fetchBoard(callback);
	}

	/** Progress chat messages: the master switch plus the per-goal-type toggle. */
	private boolean progressMessagesEnabled(GoalType type)
	{
		if (!config.progressChatMessages())
		{
			return false;
		}
		switch (type)
		{
			case DROP:
				return config.progressMsgDrops();
			case RAID_PURPLE:
				return config.progressMsgRaids();
			case KC:
				return config.progressMsgKc();
			case KILL:
				return config.progressMsgKills();
			case PET:
				return config.progressMsgPets();
			case LAP:
				return config.progressMsgLaps();
			case VALUE:
				return config.progressMsgValue();
			case CHAT:
				return config.progressMsgChat();
			default:
				return true;
		}
	}

	/** Applies a team picked in the panel; runs through the normal switch confirmation. */
	void setTeamCode(String code)
	{
		configManager.setConfiguration(IronsPubBingoConfig.GROUP, "teamCode", code);
	}

	/**
	 * Files a credit request on the team sheet's Requests tab for an admin to review
	 * (things the tracker missed or can't verify). Tile and goal are 0-based here,
	 * 1-based on the sheet.
	 */
	void submitCreditRequest(int tileIndex, Integer goalIndex, Long add, boolean complete,
		String note, String links, java.util.function.BiConsumer<Boolean, String> callback)
	{
		String self = localMemberId();
		String player = localPlayerName() != null ? localPlayerName() : lastKnownName;
		if (board == null || self == null || player == null)
		{
			callback.accept(false, "log in first");
			return;
		}
		BingoTeamStore.CreditRequest request = new BingoTeamStore.CreditRequest();
		request.member = self;
		request.player = player;
		request.tile = tileIndex + 1;
		request.goal = goalIndex == null ? null : goalIndex + 1;
		request.add = add;
		request.complete = complete;
		request.note = note;
		request.links = links;
		teamStore.submitRequest(storeScopedKey(), request, boardCodeHash,
			board == null ? null : board.version, callback);
	}

	/** Whether the player set a Discord webhook, for the request dialog's proof toggle. */
	boolean webhookConfigured()
	{
		return discordNotifier.webhookConfigured();
	}

	/** Posts a proof screenshot for a credit request; callback gets (link, error). */
	void postProofScreenshot(String requestDetail, java.util.function.BiConsumer<String, String> callback)
	{
		discordNotifier.postProofScreenshot(localPlayerName(), requestDetail, teamDisplayName(), callback);
	}

	String teamStatusText()
	{
		if (expectedPassphrase() == null)
		{
			return "No team code set";
		}
		if (!partyService.isInParty())
		{
			return "Not connected";
		}
		if (!inTeamParty())
		{
			return "In a different party";
		}
		// Deliberately no member count here: who's online is the friends list's job.
		// This line only answers "is my team sync working"; the hover tooltip lists the
		// individual sessions for diagnostics.
		return "Connected";
	}

	/** Whether a store request is currently in flight (drives the panel's loading state). */
	boolean storeBusy()
	{
		return storeRequestsInFlight > 0;
	}

	boolean storePaused()
	{
		return storePaused;
	}

	/** HH:mm of the last successful store sync, or null before the first one. */
	String storeSyncedAtText()
	{
		return storeSyncedAt;
	}

	/** The panel's Pause/Resume store button; resuming catches up immediately. */
	void setStorePaused(boolean paused)
	{
		storePaused = paused;
		if (!paused)
		{
			syncStore(true);
		}
		refreshPanel();
	}

	/**
	 * What is still missing before the store can sync ("No board imported"), or null when
	 * nothing is. The store panel shows this instead of a bare "waiting" or "error",
	 * which say nothing about why the store is idle.
	 */
	String storeSetupHint()
	{
		if (!teamStore.isConfigured() || storePaused)
		{
			return null;
		}
		if (board == null)
		{
			return "No board imported";
		}
		String code = normalizedTeamCode();
		// The host's team list arrives with every reply, including a rejection, so an
		// unlisted or missing code is known as soon as one sync has been attempted.
		if (!storeTeamNames.isEmpty() && (code == null || !storeTeamNames.containsKey(code)))
		{
			return "No team";
		}
		return null;
	}

	/**
	 * The store error trimmed to something that fits on the button, which is only as wide
	 * as "No board imported". Server rejections are whole sentences; the first clause
	 * carries the meaning, and the log keeps the rest.
	 */
	String storeErrorShort()
	{
		if (storeError == null)
		{
			return "";
		}
		String text = storeError;
		int cut = text.indexOf(" - ");
		if (cut > 0)
		{
			text = text.substring(0, cut);
		}
		return text.length() > 17 ? text.substring(0, 14) + "..." : text;
	}

	/** Whether the last team store attempt failed, for the status dot. */
	boolean storeHasError()
	{
		return storeError != null;
	}

	/** Whether the store has ever synced successfully this session. */
	boolean storeEverSynced()
	{
		return storeSyncedAt != null;
	}

	/** Broadcasts everything this client knows (own + relayed teammates) and asks for theirs. */
	private void announceToTeam()
	{
		if (board == null || !inTeamParty())
		{
			return;
		}
		String self = localMemberId();
		if (self != null)
		{
			sendMemberState(self, localPlayerName(), shareOwnTiles(progress.keySet()));
		}
		// Relay cached teammate state too, so members who never overlap with each other
		// still converge through anyone they do overlap with (gossip).
		for (Map.Entry<String, TeamMemberState> entry : activeTeamProgress().entrySet())
		{
			// Admin credit is only ever distributed by the team store, which owns it and
			// can withdraw it; relaying it would leave copies nobody can take back.
			if (!isAdminMember(entry.getKey()))
			{
				sendMemberState(entry.getKey(), entry.getValue().name, entry.getValue().tilesMap());
			}
		}
		partyService.send(new IronsPubBingoSyncRequest(boardKey));
	}

	private Map<Integer, TileProgress> shareOwnTiles(Collection<Integer> tiles)
	{
		Map<Integer, TileProgress> shares = new HashMap<>();
		for (int tileIndex : tiles)
		{
			TileProgress own = progress.get(tileIndex);
			if (own != null)
			{
				shares.put(tileIndex, own.toShare(board.getTiles().get(tileIndex).goals.size()));
			}
		}
		return shares;
	}

	private void sendMemberState(String member, String name, Map<Integer, TileProgress> tiles)
	{
		if (tiles.isEmpty() || !inTeamParty())
		{
			return;
		}
		Map<Integer, TileProgress> chunk = new HashMap<>();
		for (Map.Entry<Integer, TileProgress> entry : tiles.entrySet())
		{
			chunk.put(entry.getKey(), entry.getValue());
			if (chunk.size() >= TILES_PER_MESSAGE)
			{
				partyService.send(new IronsPubBingoMemberState(boardKey, board.identityKey(), board.version, member, name, chunk));
				chunk = new HashMap<>();
			}
		}
		if (!chunk.isEmpty())
		{
			partyService.send(new IronsPubBingoMemberState(boardKey, board.identityKey(), board.version, member, name, chunk));
		}
	}

	private void broadcastOwnTiles(Collection<Integer> tiles)
	{
		String self = localMemberId();
		if (board == null || tiles.isEmpty() || self == null || !inTeamParty())
		{
			return;
		}
		sendMemberState(self, localPlayerName(), shareOwnTiles(tiles));
		lastBroadcastMs = System.currentTimeMillis();
	}

	private void flushBroadcast()
	{
		if (!pendingBroadcast.isEmpty())
		{
			broadcastOwnTiles(new ArrayList<>(pendingBroadcast));
			pendingBroadcast.clear();
		}
	}

	@Subscribe
	public void onIronsPubBingoMemberState(IronsPubBingoMemberState update)
	{
		clientThread.invokeLater(() ->
		{
			if (update.member == null)
			{
				return;
			}
			PartyMember local = partyService.getLocalMember();
			if (local != null && local.getMemberId() == update.getMemberId()
				&& update.member.equals(localMemberId()))
			{
				return; // our own message echoed back
			}
			if (board == null || !inTeamParty() || update.tiles == null)
			{
				return;
			}
			if (!boardKey.equals(update.board))
			{
				// A different board - never merge it, however similar it looks. When it is
				// a newer revision of OUR board, that is worth a notice and nothing else.
				String identity = board.identityKey();
				if (identity != null && identity.equals(update.boardId)
					&& update.boardVersion != null && board.version != null
					&& update.boardVersion > board.version
					&& (newerBoardVersion == null || update.boardVersion > newerBoardVersion))
				{
					newerBoardVersion = update.boardVersion;
					refreshPanel();
				}
				return;
			}
			applyMemberStates(Map.of(update.member, memberState(update.name, update.tiles)));
		});
	}

	@Subscribe
	public void onIronsPubBingoSyncRequest(IronsPubBingoSyncRequest request)
	{
		clientThread.invokeLater(() ->
		{
			PartyMember local = partyService.getLocalMember();
			if (board == null || !boardKey.equals(request.board)
				|| (local != null && local.getMemberId() == request.getMemberId()))
			{
				return;
			}
			String self = localMemberId();
			if (self != null)
			{
				sendMemberState(self, localPlayerName(), shareOwnTiles(progress.keySet()));
			}
			for (Map.Entry<String, TeamMemberState> entry : activeTeamProgress().entrySet())
			{
				sendMemberState(entry.getKey(), entry.getValue().name, entry.getValue().tilesMap());
			}
		});
	}

	private void sendPresencePing()
	{
		// Nobody reads these anymore (the session diagnostics UI was removed), but the
		// periodic traffic keeps the party websocket from dying silently while idle - a
		// dead socket reconnects under a NEW member id on the next real send, which is
		// exactly the ghost-session problem this prevents.
		if (board != null && inTeamParty() && localMemberId() != null)
		{
			partyService.send(new IronsPubBingoPing(boardKey));
		}
	}

	@Subscribe
	public void onPartyChanged(PartyChanged event)
	{
		clientThread.invokeLater(() ->
		{
			announceToTeam();
			refreshPanel();
		});
	}

	@Subscribe
	public void onUserJoin(UserJoin event)
	{
		refreshPanel();
	}

	@Subscribe
	public void onUserPart(UserPart event)
	{
		refreshPanel();
	}

	/** Admin-credited members come from the team store, keyed "admin:&lt;player&gt;". */
	static boolean isAdminMember(String member)
	{
		return member != null && member.startsWith("admin:") && member.length() > 6
			&& member.length() <= 64;
	}

	/**
	 * Member keys must be exact 16-hex-char derived ids (or the store's admin credit ids);
	 * rejects corrupted keys (e.g. a backend that mangled the value), which would otherwise
	 * re-enter our own progress as a phantom teammate and double-count it.
	 */
	private static boolean isValidMemberId(String member)
	{
		if (isAdminMember(member))
		{
			return true;
		}
		if (member.length() != 16)
		{
			return false;
		}
		for (int i = 0; i < member.length(); i++)
		{
			char c = member.charAt(i);
			if ((c < '0' || c > '9') && (c < 'a' || c > 'f'))
			{
				return false;
			}
		}
		return true;
	}

	private static TeamMemberState memberState(String name, Map<Integer, TileProgress> tiles)
	{
		TeamMemberState state = new TeamMemberState();
		state.name = name;
		state.tiles = tiles;
		return state;
	}

	/**
	 * Merges incoming member states (from party messages or the team store) into the team
	 * cache last-write-wins, notifying about tiles the merge completed.
	 */
	private void applyMemberStates(Map<String, TeamMemberState> incoming)
	{
		String self = localMemberId();
		Set<Integer> before = completedTiles();
		boolean changed = false;
		String lastChangedName = null;
		int changedMembers = 0;
		for (Map.Entry<String, TeamMemberState> entry : incoming.entrySet())
		{
			String member = entry.getKey();
			TeamMemberState state = entry.getValue();
			if (member == null || state == null || member.equals(self) || !isValidMemberId(member)
				|| removedMembers.contains(member))
			{
				continue;
			}
			TeamMemberState cached = teamProgress.computeIfAbsent(member, k -> new TeamMemberState());
			if (cached.apply(state.name, state.tiles, board.getTiles().size()))
			{
				changed = true;
				changedMembers++;
				lastChangedName = cached.name;
			}
		}
		if (!changed)
		{
			return;
		}
		Set<Integer> after = completedTiles();
		String by = changedMembers == 1 && lastChangedName != null ? " (by " + lastChangedName + ")" : " (team)";
		for (Integer idx : after)
		{
			if (!before.contains(idx))
			{
				String label = board.getTiles().get(idx).label;
				notifier.notify(config.completionNotification(), "Bingo tile complete: " + label + by);
				sendHighlightedMessage("Bingo tile complete: " + label + by);
			}
		}
		String bonus = bonusAnnouncement(before, after);
		if (bonus != null)
		{
			notifier.notify(config.completionNotification(), bonus);
			sendHighlightedMessage(bonus);
		}
		// No Discord post here on purpose: every teammate's client sees this same merge,
		// and admin-verified completions are announced by the STORE at approval time.
		saveProgress(!after.equals(before));
		refreshPanel();
	}

	// ---------------------------------------------------------------- team sync: store layer

	/**
	 * Pushes everything this client knows to the configured team store and merges the
	 * server's reply. One call is both push and pull; safe to call often, throttled unless
	 * forced. No-op when the store is not configured.
	 */
	private void syncStore(boolean force)
	{
		// While a team switch awaits confirmation, the config already names the new team -
		// pushing now would leak pre-reset progress into its scope.
		if (board == null || !teamStore.isConfigured() || teamSwitchPending || storePaused)
		{
			return;
		}
		long now = System.currentTimeMillis();
		if (!force && now - lastStorePostMs < STORE_POST_THROTTLE_MS)
		{
			return;
		}
		lastStorePostMs = now;
		flushPendingEvictions();

		// Hybrid team modes: when the host lists teams on the store, a code they didn't
		// list is a PARTY-ONLY team - nothing is pushed to the store (the server would
		// reject it anyway; this avoids error spam). The team list is re-fetched instead,
		// so being added to the Teams tab resumes store sync within a poll cycle.
		String teamCode = normalizedTeamCode();
		if (!storeTeamNames.isEmpty() && (teamCode == null || !storeTeamNames.containsKey(teamCode)))
		{
			// Keep this short: it is shown on the store button next to "No board imported".
			storeError = teamCode == null ? "No team" : "Party-only team";
			teamStore.fetchTeams(boardKey, (teams, error) -> clientThread.invokeLater(() ->
			{
				cacheStoreTeams(teams);
				String code = normalizedTeamCode();
				if (code != null && storeTeamNames.containsKey(code))
				{
					// The host just listed us: pick straight up, don't wait for the poll.
					storeError = null;
					syncStore(true);
				}
			}));
			refreshPanel();
			return;
		}

		Map<String, TeamMemberState> known = new HashMap<>();
		String self = localMemberId();
		String ownName = localPlayerName();
		if (self != null && ownName != null)
		{
			known.put(self, memberState(ownName, shareOwnTiles(progress.keySet())));
		}
		for (Map.Entry<String, TeamMemberState> entry : teamProgress.entrySet())
		{
			// Admin-credited members are generated by the store, and evicted members are
			// tombstoned there; never send either back.
			if (!isAdminMember(entry.getKey()) && !removedMembers.contains(entry.getKey()))
			{
				known.put(entry.getKey(), entry.getValue());
			}
		}
		if (known.isEmpty())
		{
			return;
		}
		// Push only what the store doesn't already have; an unchanged poll uploads
		// nothing and just pulls. The reply always carries the full merged state.
		final Map<String, String> sending = new HashMap<>();
		Map<String, TeamMemberState> toSend = new HashMap<>();
		for (Map.Entry<String, TeamMemberState> entry : known.entrySet())
		{
			String json = gson.toJson(entry.getValue());
			if (!json.equals(storePushed.get(entry.getKey())))
			{
				toSend.put(entry.getKey(), entry.getValue());
				sending.put(entry.getKey(), json);
			}
		}
		final String forBoard = storeScopedKey();
		// The board definition lets the store render a readable board for admins; it only
		// changes when the board does, so send it once per board per session.
		Object meta = forBoard.equals(metaSentForBoard) ? null : buildBoardMeta();
		storeRequestsInFlight++;
		refreshPanel();
		teamStore.sync(forBoard, toSend, meta, self, earnedPoints(), boardCodeHash,
			board == null ? null : board.version,
			(payload, error) -> clientThread.invokeLater(() ->
		{
			storeRequestsInFlight = Math.max(0, storeRequestsInFlight - 1);
			if (payload != null)
			{
				cacheStoreTeams(payload.teams);
				// The host's poll interval, clamped to something the store can carry.
				long wanted = payload.pollSeconds == null || payload.pollSeconds <= 0
					? STORE_POLL_SECONDS
					: Math.min(STORE_POLL_MAX_SECONDS, Math.max(STORE_POLL_MIN_SECONDS, payload.pollSeconds));
				if (wanted != storePollSeconds)
				{
					storePollSeconds = wanted;
					schedulePoll();
				}
				if (payload.standings != null)
				{
					storeStandings.clear();
					storeStandings.addAll(payload.standings);
				}
			}
			if (board == null || !storeScopedKey().equals(forBoard))
			{
				return;
			}
			if (error != null)
			{
				storeError = error;
				// The store rejected us for running an outdated board: surface it via
				// the same notice a teammate's newer revision would trigger.
				if (payload != null && payload.newerVersion != null && board != null
					&& (board.version == null || payload.newerVersion > board.version)
					&& (newerBoardVersion == null || payload.newerVersion > newerBoardVersion))
				{
					newerBoardVersion = payload.newerVersion;
					newerBoardFromStore = true;
				}
			}
			else
			{
				storeError = null;
				storeSyncedAt = new SimpleDateFormat("HH:mm").format(new Date());
				metaSentForBoard = forBoard;
				storePushed.putAll(sending);
				applyStoreEpoch(payload.epoch);
				// The store owns admin credit and evictions outright, so a credit or member
				// removed there must disappear here too - merging alone would keep the
				// stale copy forever (and relay it back).
				Set<Integer> before = completedTiles();
				boolean dropped = teamProgress.keySet()
					.removeIf(id -> isAdminMember(id) && !payload.members.containsKey(id));
				if (payload.removed != null && !removedMembers.equals(new HashSet<>(payload.removed)))
				{
					// Mirror the store's departures exactly: an added one hides that member
					// (and stops us relaying them), a cleared one brings them back from the
					// cache the moment they rejoin the team.
					removedMembers.clear();
					removedMembers.addAll(payload.removed);
					if (configManager.getRSProfileKey() != null)
					{
						configManager.setRSProfileConfiguration(IronsPubBingoConfig.GROUP,
							removedCacheKey(normalizedTeamCode()), gson.toJson(removedMembers));
					}
					dropped = true;
				}
				applyMemberStates(payload.members);
				if (dropped)
				{
					saveProgress(true);
					if (!completedTiles().equals(before))
					{
						refreshPanel();
					}
				}
			}
			refreshPanel();
		}));
	}

	// ---------------------------------------------------------------- panel API

	boolean isTileComplete(int tileIndex)
	{
		return board != null && board.getTiles().get(tileIndex).isComplete(mergedProgressFor(tileIndex));
	}

	int completedCount()
	{
		if (board == null)
		{
			return 0;
		}
		int n = 0;
		for (int i = 0; i < board.getTiles().size(); i++)
		{
			if (isTileComplete(i))
			{
				n++;
			}
		}
		return n;
	}

	int completedLines()
	{
		if (board == null)
		{
			return 0;
		}
		int size = board.getSize();
		int lines = 0;
		for (int r = 0; r < size; r++)
		{
			boolean row = true;
			boolean col = true;
			for (int c = 0; c < size; c++)
			{
				row &= isTileComplete(r * size + c);
				col &= isTileComplete(c * size + r);
			}
			lines += (row ? 1 : 0) + (col ? 1 : 0);
		}
		if (!board.diagonalsCount())
		{
			return lines;
		}
		boolean diag = true;
		boolean anti = true;
		for (int i = 0; i < size; i++)
		{
			diag &= isTileComplete(i * size + i);
			anti &= isTileComplete(i * size + (size - 1 - i));
		}
		return lines + (diag ? 1 : 0) + (anti ? 1 : 0);
	}

	/**
	 * Completed bingo lines as {firstCellIndex, lastCellIndex} segments, for drawing
	 * strokes through them on the grid.
	 */
	LineDisplay lineDisplay()
	{
		return config.lineDisplay();
	}

	boolean progressFill()
	{
		return config.progressFill();
	}

	boolean showTileNumbers()
	{
		return config.showTileNumbers();
	}

	/**
	 * The tile's overall progress as 0..1, from the team-merged view: the average across
	 * its goals (each capped at its target), or the best goal for ANY-mode tiles.
	 */
	double tileProgressFraction(int tileIndex)
	{
		if (board == null)
		{
			return 0;
		}
		BingoTile tile = board.getTiles().get(tileIndex);
		TileProgress merged = mergedProgressFor(tileIndex);
		double sum = 0;
		double best = 0;
		int counted = 0;
		for (int g = 0; g < tile.goals.size(); g++)
		{
			BingoGoal goal = tile.goals.get(g);
			long target = goal.target();
			if (goal.goalType == GoalType.MANUAL || target <= 0)
			{
				continue;
			}
			double fraction = Math.min(1.0, goal.progressOf(merged.goal(g, tile.goals.size())) / (double) target);
			sum += fraction;
			best = Math.max(best, fraction);
			counted++;
		}
		if (counted == 0)
		{
			return 0;
		}
		return tile.anyMode ? best : sum / counted;
	}

	/** Cells that are part of a completed line, for the HIGHLIGHT display style. */
	Set<Integer> completedLineCells()
	{
		Set<Integer> cells = new HashSet<>();
		if (board == null)
		{
			return cells;
		}
		int size = board.getSize();
		for (int r = 0; r < size; r++)
		{
			boolean row = true;
			boolean col = true;
			for (int c = 0; c < size; c++)
			{
				row &= isTileComplete(r * size + c);
				col &= isTileComplete(c * size + r);
			}
			for (int c = 0; c < size; c++)
			{
				if (row)
				{
					cells.add(r * size + c);
				}
				if (col)
				{
					cells.add(c * size + r);
				}
			}
		}
		if (!board.diagonalsCount())
		{
			return cells;
		}
		boolean diag = true;
		boolean anti = true;
		for (int i = 0; i < size; i++)
		{
			diag &= isTileComplete(i * size + i);
			anti &= isTileComplete(i * size + (size - 1 - i));
		}
		for (int i = 0; i < size; i++)
		{
			if (diag)
			{
				cells.add(i * size + i);
			}
			if (anti)
			{
				cells.add(i * size + (size - 1 - i));
			}
		}
		return cells;
	}

	List<int[]> completedLineSegments()
	{
		List<int[]> segments = new ArrayList<>();
		if (board == null)
		{
			return segments;
		}
		int size = board.getSize();
		for (int r = 0; r < size; r++)
		{
			boolean row = true;
			boolean col = true;
			for (int c = 0; c < size; c++)
			{
				row &= isTileComplete(r * size + c);
				col &= isTileComplete(c * size + r);
			}
			if (row)
			{
				segments.add(new int[]{r * size, r * size + size - 1});
			}
			if (col)
			{
				segments.add(new int[]{r, (size - 1) * size + r});
			}
		}
		if (!board.diagonalsCount())
		{
			return segments;
		}
		boolean diag = true;
		boolean anti = true;
		for (int i = 0; i < size; i++)
		{
			diag &= isTileComplete(i * size + i);
			anti &= isTileComplete(i * size + (size - 1 - i));
		}
		if (diag)
		{
			segments.add(new int[]{0, size * size - 1});
		}
		if (anti)
		{
			segments.add(new int[]{size - 1, (size - 1) * size});
		}
		return segments;
	}

	/** All points the board can award: tiles + every line bonus + the blackout bonus. */
	int totalBoardPoints()
	{
		if (board == null)
		{
			return 0;
		}
		int total = board.linePointsValue() * board.maxLines() + board.blackoutPointsValue();
		for (BingoTile tile : board.getTiles())
		{
			total += tile.pointsValue();
		}
		return total;
	}

	int earnedLineBonus()
	{
		return board == null ? 0 : completedLines() * board.linePointsValue();
	}

	int earnedBlackoutBonus()
	{
		if (board == null || board.blackoutPointsValue() == 0)
		{
			return 0;
		}
		return completedCount() == board.getTiles().size() ? board.blackoutPointsValue() : 0;
	}

	int earnedPoints()
	{
		if (board == null)
		{
			return 0;
		}
		int total = earnedLineBonus() + earnedBlackoutBonus();
		for (int i = 0; i < board.getTiles().size(); i++)
		{
			if (board.getTiles().get(i).pointsValue() > 0 && isTileComplete(i))
			{
				total += board.getTiles().get(i).pointsValue();
			}
		}
		return total;
	}

	void setManualComplete(int tileIndex, boolean complete)
	{
		Set<Integer> before = completedTiles();
		progressFor(tileIndex).manual = complete;
		Set<Integer> changedTiles = new HashSet<>();
		changedTiles.add(tileIndex);
		afterChange(before, changedTiles, new LinkedHashSet<>());
	}

	void resetTileProgress(int tileIndex)
	{
		progress.remove(tileIndex);
		progressFor(tileIndex).ts = System.currentTimeMillis();
		Set<Integer> tiles = new HashSet<>();
		tiles.add(tileIndex);
		broadcastOwnTiles(tiles);
		syncStore(true);
		saveProgress(true);
		refreshPanel();
	}

	// ---------------------------------------------------------------- event handlers

	/**
	 * NPC kill loot, as announced by the game's own loot tracker script. This is the same
	 * source RuneLite's Loot Tracker uses, and the only one that sees loot delivered
	 * straight to the inventory (Araxxor's harvested corpse) instead of onto the ground.
	 * The legacy ground-scan event (NpcLootReceived) fires alongside this for ordinary
	 * kills, so subscribing to both would count them twice.
	 */
	@Subscribe
	public void onServerNpcLoot(ServerNpcLoot event)
	{
		// The server announces pickpocket loot through the same script. It counts as
		// loot from that NPC - so pickpocket-farmed tiles work - but never as a kill.
		BingoGoal.LootKind kind = pickpocketTick == client.getTickCount()
			? BingoGoal.LootKind.PICKPOCKET
			: BingoGoal.LootKind.KILL;
		handleLoot(event.getComposition().getName(), event.getItems(), kind);
	}

	@Subscribe
	public void onPlayerLootReceived(PlayerLootReceived event)
	{
		handleLoot(event.getPlayer().getName(), event.getItems(), BingoGoal.LootKind.OTHER);
	}

	@Subscribe
	public void onLootReceived(LootReceived event)
	{
		// NPC, player and pickpocket loot already arrives via the dedicated events
		// above - the Loot Tracker's re-posts of them would count everything twice.
		if (event.getType() == LootRecordType.NPC || event.getType() == LootRecordType.PLAYER
			|| event.getType() == LootRecordType.PICKPOCKET)
		{
			return;
		}
		handleLoot(event.getName(), event.getItems(), BingoGoal.LootKind.OTHER);
	}

	/**
	 * Marks of grace are neither NPC loot nor announced in chat - they spawn on the roofs.
	 * Detected as inventory gains while inside an agility course region (they can't be
	 * bought, and banks are outside course regions), and fed through the normal drop
	 * pipeline with the course as the loot source - so a plain DROP goal on
	 * "Mark of grace" works, optionally per course.
	 */
	@Subscribe
	public void onItemContainerChanged(ItemContainerChanged event)
	{
		if (event.getContainerId() != InventoryID.INV)
		{
			return;
		}
		int current = event.getItemContainer().count(ItemID.GRACE);
		int previous = lastMarkCount;
		lastMarkCount = current;
		if (previous < 0 || current == previous || client.getLocalPlayer() == null)
		{
			return;
		}
		BingoCourse course = BingoCourse.forRegion(client.getLocalPlayer().getWorldLocation().getRegionID());
		if (current < previous)
		{
			// Marks dropped on a course could be picked straight back up - remember the
			// deficit so the re-pickup doesn't count as newly earned. Decreases elsewhere
			// (spending at the Graceful shop, banking) can't be re-picked on a course.
			if (course != null)
			{
				markDropDebt += previous - current;
			}
			return;
		}
		int gained = current - previous;
		int owed = Math.min(markDropDebt, gained);
		markDropDebt -= owed;
		gained -= owed;
		if (gained > 0 && course != null && board != null)
		{
			handleLoot(course.getDisplayName(), List.of(new ItemStack(ItemID.GRACE, gained)), BingoGoal.LootKind.OTHER);
		}
	}

	@Subscribe
	public void onChatMessage(ChatMessage event)
	{
		if (board == null)
		{
			return;
		}
		ChatMessageType type = event.getType();
		if (type != ChatMessageType.GAMEMESSAGE && type != ChatMessageType.SPAM && type != ChatMessageType.MESBOX)
		{
			return;
		}
		String message = Text.removeTags(event.getMessage());
		String lower = message.toLowerCase(Locale.ROOT);
		if (lower.startsWith("you pick ") && lower.contains(" pocket"))
		{
			pickpocketTick = client.getTickCount();
		}
		final boolean active = trackingActive();
		// For region-gated CHAT goals: the plain region, and the template region when the
		// player stands in an instance (whose real-world coordinates are throwaway).
		int worldRegion = -1;
		int instanceRegion = -1;
		if (client.getLocalPlayer() != null)
		{
			worldRegion = client.getLocalPlayer().getWorldLocation().getRegionID();
			instanceRegion = WorldPoint.fromLocalInstance(client, client.getLocalPlayer().getLocalLocation()).getRegionID();
		}
		final int chatWorldRegion = worldRegion;
		final int chatInstanceRegion = instanceRegion;

		Matcher kcMatcher = KC_MESSAGE.matcher(message);
		String kcBoss = kcMatcher.find() ? kcMatcher.group(1) : null;
		long kcReported = kcBoss != null ? Long.parseLong(kcMatcher.group(2).replace(",", "")) : 0;
		if (!active && kcBoss == null)
		{
			return;
		}

		boolean petReceived = false;
		for (String petMessage : PET_MESSAGES)
		{
			petReceived |= lower.contains(petMessage);
		}
		final boolean anyPet = petReceived;

		String collectionLogItem = lower.startsWith(COLLECTION_LOG_PREFIX)
			? message.substring(COLLECTION_LOG_PREFIX.length()).trim()
			: null;

		Set<Integer> before = completedTiles();
		Set<Long> changed = visitGoals((tile, goal, p) ->
		{
			switch (goal.goalType)
			{
				case KC:
					// Outside the event window kc baselines still ride along (countIt =
					// false), so pre-event kills never count once the window opens.
					return kcBoss != null && Wildcards.anyMatch(goal.npcPatterns, kcBoss)
						&& applyKillCount(p, kcBoss, kcReported, active);
				case PET:
					if (!active)
					{
						return false;
					}
					if (goal.petPatterns.isEmpty())
					{
						return anyPet && bump(p, 1);
					}
					return collectionLogItem != null
						&& Wildcards.anyMatch(goal.petPatterns, collectionLogItem)
						&& addMatched(p, collectionLogItem);
				case CHAT:
					return active && goal.allowsRegion(chatWorldRegion, chatInstanceRegion)
						&& goal.chatPattern.matcher(message).find() && bump(p, 1);
				default:
					return false;
			}
		});
		if (!changed.isEmpty())
		{
			afterChange(before, tilesOf(changed), changed);
		}
		else if (!active && kcBoss != null)
		{
			saveProgress(false); // persist ridden kc baselines eventually
		}
	}

	@Subscribe
	public void onStatChanged(StatChanged event)
	{
		if (board == null)
		{
			return;
		}
		final boolean active = trackingActive();

		// Lap detection, mirroring RuneLite's Agility plugin: a lap ends when Agility XP
		// lands while the player stands on the course's end tile(s), course by map region.
		BingoCourse lapCourse = null;
		if (event.getSkill() == Skill.AGILITY)
		{
			long gained = lastAgilityXp < 0 ? 0 : event.getXp() - lastAgilityXp;
			lastAgilityXp = event.getXp();
			if (active && gained > 0 && client.getLocalPlayer() != null)
			{
				var location = client.getLocalPlayer().getWorldLocation();
				BingoCourse course = BingoCourse.forRegion(location.getRegionID());
				if (course != null && course.isEndPoint(location))
				{
					lapCourse = course;
				}
			}
		}
		final BingoCourse completedLap = lapCourse;

		Set<Integer> before = completedTiles();
		Set<Long> changed = visitGoals((tile, goal, p) ->
		{
			if (goal.goalType == GoalType.LAP)
			{
				return goal.courseEnum == completedLap && completedLap != null && bump(p, 1);
			}
			if (goal.goalType != GoalType.XP || goal.skillEnum != event.getSkill())
			{
				return false;
			}
			if (p.baseline == null || !active)
			{
				// Outside the event window the baseline rides along without counting,
				// so XP gained before the start (or after the end) never leaks in.
				p.baseline = (long) event.getXp();
				return false;
			}
			// Accumulate the gain since the last sighting; a stale baseline from a previous
			// session means XP earned in between (e.g. on mobile) is counted on the next drop.
			long gained = event.getXp() - p.baseline;
			p.baseline = (long) event.getXp();
			if (gained <= 0)
			{
				return false;
			}
			p.n += gained;
			return true;
		});
		if (!changed.isEmpty())
		{
			afterChange(before, tilesOf(changed), changed);
		}
		else if (!active)
		{
			saveProgress(false); // persist ridden xp baselines eventually
		}
	}

	@Subscribe
	public void onGameStateChanged(GameStateChanged event)
	{
		if (event.getGameState() == GameState.LOGGED_IN)
		{
			// The local player's name lags the LOGGED_IN state by a few frames; retry until
			// it exists so announcements never go out with an empty name.
			clientThread.invokeLater(() ->
			{
				if (client.getGameState() != GameState.LOGGED_IN)
				{
					return true; // logged out again; the next login retriggers this
				}
				if (client.getLocalPlayer() == null || client.getLocalPlayer().getName() == null)
				{
					return false; // not ready yet, retry next frame
				}
				flushPendingEvictions();
				announceToTeam();
				syncStore(false);
				refreshPanel();
				return true;
			});
		}
		else if (event.getGameState() == GameState.LOGIN_SCREEN || event.getGameState() == GameState.HOPPING)
		{
			flushBroadcast();
			if (dirty)
			{
				saveProgress(true);
			}
			// Land the session's progress before the client goes idle, so a player who
			// logs out between polls is not missing from the sheet until they return.
			syncStore(true);
			refreshPanel(); // the panel hides its content while logged out
		}
	}

	@Subscribe
	public void onRuneScapeProfileChanged(RuneScapeProfileChanged event)
	{
		lastAgilityXp = -1; // different account: reseed before counting laps again
		lastMarkCount = -1;
		markDropDebt = 0;
		loadProgress();
		refreshPanel();
	}

	// ---------------------------------------------------------------- tracking

	private void handleLoot(String source, Collection<ItemStack> items, BingoGoal.LootKind kind)
	{
		if (board == null || !trackingActive() || items == null || items.isEmpty())
		{
			return;
		}

		int n = items.size();
		String[] names = new String[n];
		int[] ids = new int[n];
		int[] quantities = new int[n];
		long totalValue = 0;
		int i = 0;
		for (ItemStack stack : items)
		{
			// Canonicalize first: NOTED drops (e.g. Araxxor's noted rune platelegs) have
			// their own item id, which the price map doesn't know - pricing the raw id
			// values the pile at 0 and silently fails VALUE goals.
			int canonicalId = itemManager.canonicalize(stack.getId());
			names[i] = itemManager.getItemComposition(canonicalId).getName();
			ids[i] = canonicalId;
			quantities[i] = stack.getQuantity();
			totalValue += (long) itemManager.getItemPrice(canonicalId) * stack.getQuantity();
			i++;
		}
		final long lootValue = totalValue;
		Raid raid = Raid.fromLootSource(source);
		// What each DROP/VALUE goal actually received, so a completion post can say
		// which drop finished the tile.
		Map<BingoGoal, String> lootDetails = new HashMap<>();

		Set<Integer> before = completedTiles();
		Set<Long> changed = visitGoals((tile, goal, p) ->
		{
			boolean any = false;
			switch (goal.goalType)
			{
				case KILL:
					// One server-announced kill loot = one kill attributed to us (it awards
					// loot to whoever dealt the most damage - the ironman rule) - so a
					// shared kill counts exactly once across the team.
					return kind == BingoGoal.LootKind.KILL
						&& Wildcards.anyMatch(goal.npcPatterns, source)
						&& bump(p, 1);
				case DROP:
					if (!goal.allowsLoot(kind) || !Wildcards.anyMatch(goal.sourcePatterns, source))
					{
						return false;
					}
					StringBuilder got = new StringBuilder();
					for (int idx = 0; idx < names.length; idx++)
					{
						if (goal.matchesItem(names[idx], ids[idx]))
						{
							any |= goal.isDistinct()
								? addMatched(p, names[idx])
								: bump(p, quantities[idx]);
							got.append(got.length() > 0 ? ", " : "").append(names[idx]);
							if (quantities[idx] > 1)
							{
								got.append(" x").append(quantities[idx]);
							}
						}
					}
					if (any)
					{
						lootDetails.put(goal, got + " from " + source);
					}
					return any;
				case RAID_PURPLE:
					if (raid == null || !goal.raidSet.contains(raid))
					{
						return false;
					}
					for (String name : names)
					{
						if (raid.isUnique(name))
						{
							any |= goal.isDistinct() ? addMatched(p, name) : bump(p, 1);
						}
					}
					return any;
				case VALUE:
					if (!goal.allowsLoot(kind) || !Wildcards.anyMatch(goal.sourcePatterns, source)
						|| lootValue < goal.amount || !bump(p, 1))
					{
						return false;
					}
					StringBuilder pile = new StringBuilder();
					for (int idx = 0; idx < names.length; idx++)
					{
						pile.append(idx > 0 ? ", " : "").append(names[idx]);
						if (quantities[idx] > 1)
						{
							pile.append(" x").append(quantities[idx]);
						}
					}
					lootDetails.put(goal, String.format("%s (%,d gp) from %s", pile, lootValue, source));
					return true;
				default:
					return false;
			}
		});
		if (!changed.isEmpty())
		{
			afterChange(before, tilesOf(changed), changed, lootDetails);
		}
	}

	private interface GoalVisitor
	{
		boolean visit(BingoTile tile, BingoGoal goal, GoalProgress p);
	}

	/**
	 * Runs the visitor over every goal on the board.
	 *
	 * @return the changed goals, encoded as (tileIndex << 16 | goalIndex)
	 */
	private Set<Long> visitGoals(GoalVisitor visitor)
	{
		Set<Long> changed = new LinkedHashSet<>();
		List<BingoTile> tiles = board.getTiles();
		for (int t = 0; t < tiles.size(); t++)
		{
			BingoTile tile = tiles.get(t);
			for (int g = 0; g < tile.goals.size(); g++)
			{
				GoalProgress p = progressFor(t).goal(g, tile.goals.size());
				if (visitor.visit(tile, tile.goals.get(g), p))
				{
					changed.add(((long) t << 16) | g);
				}
			}
		}
		return changed;
	}

	/**
	 * The goal whose progress in this change finished the tile, described for humans -
	 * or null for single-goal tiles, where the label already says everything.
	 */
	private String finishingGoal(int tileIndex, Set<Long> changedGoals)
	{
		BingoTile tile = board.getTiles().get(tileIndex);
		if (tile.goals.size() < 2)
		{
			return null;
		}
		for (long pair : changedGoals)
		{
			if ((int) (pair >> 16) != tileIndex)
			{
				continue;
			}
			BingoGoal goal = tile.goals.get((int) (pair & 0xFFFF));
			long merged = goal.progressOf(mergedProgressFor(tileIndex).goal((int) (pair & 0xFFFF), tile.goals.size()));
			if (merged >= goal.target())
			{
				return goal.shortDescribe();
			}
		}
		return null;
	}

	private static Set<Integer> tilesOf(Set<Long> changedGoals)
	{
		Set<Integer> tiles = new LinkedHashSet<>();
		for (long pair : changedGoals)
		{
			tiles.add((int) (pair >> 16));
		}
		return tiles;
	}

	private static boolean bump(GoalProgress p, long delta)
	{
		p.n += delta;
		return true;
	}

	private static boolean addMatched(GoalProgress p, String name)
	{
		return p.addName(name);
	}

	/**
	 * Applies a reported kill count for a boss to a KC goal's progress: the first sighting
	 * after board import baselines at reported - 1 (that message itself is a kill during the
	 * event), later sightings count the delta — so missed messages are caught up on the next
	 * kill and progress reflects kill count gained since import.
	 *
	 * @return whether progress changed
	 */
	static boolean applyKillCount(GoalProgress p, String boss, long reported, boolean countIt)
	{
		Map<String, long[]> kc = p.kcMap();
		String key = boss.toLowerCase(Locale.ROOT);
		long[] entry = kc.get(key);
		if (!countIt)
		{
			// Ride the baseline: absorb kills outside the event window without counting.
			if (entry == null)
			{
				kc.put(key, new long[]{reported, reported});
			}
			else if (reported > entry[1])
			{
				entry[0] += reported - entry[1];
				entry[1] = reported;
			}
			return false;
		}
		if (entry == null)
		{
			kc.put(key, new long[]{reported - 1, reported});
		}
		else if (reported > entry[1])
		{
			entry[1] = reported;
		}
		else
		{
			return false;
		}
		long total = 0;
		for (long[] e : kc.values())
		{
			total += e[1] - e[0];
		}
		if (total == p.n)
		{
			return false;
		}
		p.n = total;
		return true;
	}

	/** Completed lines given a set of completed tile indexes. */
	private int linesIn(Set<Integer> complete)
	{
		if (board == null)
		{
			return 0;
		}
		int size = board.getSize();
		int lines = 0;
		for (int r = 0; r < size; r++)
		{
			boolean row = true;
			boolean col = true;
			for (int c = 0; c < size; c++)
			{
				row &= complete.contains(r * size + c);
				col &= complete.contains(c * size + r);
			}
			lines += (row ? 1 : 0) + (col ? 1 : 0);
		}
		if (!board.diagonalsCount())
		{
			return lines;
		}
		boolean diag = true;
		boolean anti = true;
		for (int i = 0; i < size; i++)
		{
			diag &= complete.contains(i * size + i);
			anti &= complete.contains(i * size + (size - 1 - i));
		}
		return lines + (diag ? 1 : 0) + (anti ? 1 : 0);
	}

	/** Announcement for newly completed lines / a blackout, or null when neither happened. */
	private String bonusAnnouncement(Set<Integer> completedBefore, Set<Integer> completedAfter)
	{
		int linesGained = linesIn(completedAfter) - linesIn(completedBefore);
		boolean blackout = completedAfter.size() == board.getTiles().size()
			&& completedBefore.size() < board.getTiles().size();
		if (linesGained <= 0 && !blackout)
		{
			return null;
		}
		// A blackout finishes lines too - announce both, lines first.
		StringBuilder text = new StringBuilder();
		if (linesGained > 0)
		{
			text.append("Bingo! ").append(linesGained == 1 ? "Line complete" : linesGained + " lines complete");
			if (board.linePointsValue() > 0)
			{
				text.append(" (+").append(linesGained * board.linePointsValue()).append(" pts)");
			}
		}
		if (blackout)
		{
			if (text.length() > 0)
			{
				text.append(" - ");
			}
			text.append("BLACKOUT! Every tile complete");
			if (board.blackoutPointsValue() > 0)
			{
				text.append(" (+").append(board.blackoutPointsValue()).append(" pts)");
			}
		}
		return text.toString();
	}

	private Set<Integer> completedTiles()
	{
		Set<Integer> complete = new HashSet<>();
		if (board == null)
		{
			return complete;
		}
		for (int i = 0; i < board.getTiles().size(); i++)
		{
			if (isTileComplete(i))
			{
				complete.add(i);
			}
		}
		return complete;
	}

	/**
	 * Runs after this client changed its own progress: stamps ownership timestamps,
	 * notifies on newly completed tiles, posts to Discord, shows progress chat messages,
	 * broadcasts to the team, pushes to the team store and saves.
	 */
	private void afterChange(Set<Integer> completedBefore, Set<Integer> changedTiles, Set<Long> changedGoals)
	{
		afterChange(completedBefore, changedTiles, changedGoals, null);
	}

	/** lootDetails: what each DROP/VALUE goal just received, for the completion post. */
	private void afterChange(Set<Integer> completedBefore, Set<Integer> changedTiles, Set<Long> changedGoals,
		Map<BingoGoal, String> lootDetails)
	{
		long now = System.currentTimeMillis();
		for (int tileIndex : changedTiles)
		{
			progressFor(tileIndex).ts = now;
		}

		Set<Integer> completedAfter = completedTiles();
		List<String> newlyCompleted = new ArrayList<>();
		Set<Integer> newlyCompletedIdx = new HashSet<>();
		List<String> discordLabels = new ArrayList<>();
		List<String> completionLoot = new ArrayList<>();
		for (Integer idx : completedAfter)
		{
			if (!completedBefore.contains(idx))
			{
				BingoTile tile = board.getTiles().get(idx);
				newlyCompleted.add(tile.label);
				newlyCompletedIdx.add(idx);
				// For Discord, name the goal that finished a multi-goal tile - "which
				// half of the OR was it" is the first thing teammates ask.
				String via = finishingGoal(idx, changedGoals);
				discordLabels.add(via == null ? tile.label : tile.label + " (" + via + ")");
				if (lootDetails != null)
				{
					for (BingoGoal goal : tile.goals)
					{
						String detail = lootDetails.get(goal);
						if (detail != null && !completionLoot.contains(detail))
						{
							completionLoot.add(detail);
							break;
						}
					}
				}
			}
		}

		// Progress messages first, completion messages last - reads better in chat.
		boolean nonXpChange = changedGoals.isEmpty();
		int shown = 0;
		for (long pair : changedGoals)
		{
			int t = (int) (pair >> 16);
			int g = (int) (pair & 0xFFFF);
			BingoTile tile = board.getTiles().get(t);
			BingoGoal goal = tile.goals.get(g);
			if (goal.goalType == GoalType.XP)
			{
				continue;
			}
			nonXpChange = true;
			long merged = goal.progressOf(mergedProgressFor(t).goal(g, tile.goals.size()));
			if (progressMessagesEnabled(goal.goalType)
				&& merged <= goal.target() && shown++ < MAX_PROGRESS_MESSAGES_PER_EVENT)
			{
				sendHighlightedMessage("Bingo progress - " + tile.label + ": " + merged + "/" + goal.target());
			}
			if (goal.wantsScreenshot() && !newlyCompletedIdx.contains(t))
			{
				// The host flagged this goal for proof-as-you-go (rare drops, mostly).
				// When this very change completes the tile, the completion post below
				// carries the screenshot instead of doubling up.
				discordNotifier.postGoalProgress(localPlayerName(), tile.label,
					goal.shortDescribe(), merged, goal.target(), teamDisplayName());
			}
		}

		String bonus = bonusAnnouncement(completedBefore, completedAfter);
		for (String label : newlyCompleted)
		{
			notifier.notify(config.completionNotification(), "Bingo tile complete: " + label);
			sendHighlightedMessage("Bingo tile complete: " + label);
		}
		if (bonus != null)
		{
			notifier.notify(config.completionNotification(), bonus);
			sendHighlightedMessage(bonus);
		}
		if (!newlyCompleted.isEmpty())
		{
			discordNotifier.postCompletion(localPlayerName(),
				board.getName(), discordLabels, completedAfter.size(), board.getTiles().size(), bonus,
				completionLoot.isEmpty() ? null : String.join("; ", completionLoot), teamDisplayName());
		}

		// XP-only changes arrive every xp drop; batch their team broadcasts.
		pendingBroadcast.addAll(changedTiles);
		if (nonXpChange || !newlyCompleted.isEmpty() || now - lastBroadcastMs > BROADCAST_THROTTLE_MS)
		{
			flushBroadcast();
		}
		// Only completions are worth their own store call. Ordinary progress rides the
		// 2 minute poll, which pushes as well as pulls - pushing per change cost up to
		// four calls a minute per player for freshness nobody was watching.
		if (!newlyCompleted.isEmpty())
		{
			syncStore(true);
		}

		saveProgress(nonXpChange || !newlyCompleted.isEmpty());
		refreshPanel();
	}

	private void sendHighlightedMessage(String message)
	{
		chatMessageManager.queue(QueuedMessage.builder()
			.type(ChatMessageType.CONSOLE)
			.runeLiteFormattedMessage(new ChatMessageBuilder()
				.append(ChatColorType.HIGHLIGHT)
				.append(message)
				.build())
			.build());
	}

	private void refreshPanel()
	{
		IronsPubBingoPanel p = panel;
		BingoBoardWindow window = boardWindow;
		SwingUtilities.invokeLater(() ->
		{
			if (p != null)
			{
				p.refresh();
			}
			if (window != null && window.isVisible())
			{
				window.refresh();
			}
		});
	}

}

package com.ironspubbingo;

import com.google.gson.Gson;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import org.junit.Test;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

public class BingoBoardTest
{
	private final Gson gson = new Gson();

	@Test
	public void exampleBoardParses() throws IOException
	{
		BingoBoard board = BingoBoard.parse(gson, readResource("/example-board.json"));
		assertEquals(5, board.getSize());
		assertEquals(25, board.getTiles().size());
		// Every goal resolved its type during validation
		for (BingoTile tile : board.getTiles())
		{
			for (BingoGoal goal : tile.goals)
			{
				assertNotNull(goal.goalType);
			}
		}
	}

	@Test
	public void anyModeTileCompletesWithOneGoal()
	{
		BingoBoard board = BingoBoard.parse(gson,
			"{\"size\":1,\"tiles\":[{\"label\":\"x or y\",\"mode\":\"ANY\",\"goals\":["
				+ "{\"type\":\"DROP\",\"items\":[\"Zenyte shard\"],\"count\":3},"
				+ "{\"type\":\"DROP\",\"items\":[\"Venator shard\"],\"count\":3}]}]}");
		BingoTile tile = board.getTiles().get(0);
		TileProgress progress = new TileProgress();
		assertTrue(!tile.isComplete(progress));
		progress.goal(1, 2).n = 3;
		assertTrue(tile.isComplete(progress));
	}

	@Test
	public void distinctDropsCountUniqueNames()
	{
		BingoBoard board = BingoBoard.parse(gson,
			"{\"size\":1,\"tiles\":[{\"label\":\"uniques\",\"goals\":["
				+ "{\"type\":\"DROP\",\"items\":[\"*champion scroll*\"],\"distinct\":true,\"count\":2}]}]}");
		BingoGoal goal = board.getTiles().get(0).goals.get(0);
		GoalProgress p = new GoalProgress();
		p.matchedSet().add("imp champion scroll");
		p.matchedSet().add("imp champion scroll");
		assertEquals(1, goal.progressOf(p));
		assertTrue(!goal.isComplete(p));
		p.matchedSet().add("goblin champion scroll");
		assertTrue(goal.isComplete(p));
	}

	@Test
	public void manualTileNeedsManualTick()
	{
		BingoBoard board = BingoBoard.parse(gson,
			"{\"size\":1,\"tiles\":[{\"label\":\"pov\"}]}");
		BingoTile tile = board.getTiles().get(0);
		TileProgress progress = new TileProgress();
		assertTrue(!tile.isComplete(progress));
		progress.manual = true;
		assertTrue(tile.isComplete(progress));
	}

	@Test
	public void wrongTileCountRejected()
	{
		try
		{
			BingoBoard.parse(gson, "{\"size\":2,\"tiles\":[{\"label\":\"only one\"}]}");
			fail("expected IllegalArgumentException");
		}
		catch (IllegalArgumentException expected)
		{
		}
	}

	@Test
	public void badGoalReportsTileAndReason()
	{
		try
		{
			BingoBoard.parse(gson, "{\"size\":1,\"tiles\":[{\"label\":\"bad\",\"goals\":[{\"type\":\"DROP\"}]}]}");
			fail("expected IllegalArgumentException");
		}
		catch (IllegalArgumentException e)
		{
			assertTrue(e.getMessage().contains("tile 1"));
			assertTrue(e.getMessage().contains("items"));
		}
	}

	@Test
	public void raidUniqueDetection()
	{
		assertEquals(Raid.TOB, Raid.fromLootSource("Theatre of Blood: Hard Mode"));
		assertTrue(Raid.TOB.isUnique("Scythe of vitur (uncharged)"));
		assertTrue(!Raid.TOB.isUnique("Vial of blood"));
		assertEquals(null, Raid.fromLootSource("Barrows"));
	}

	@Test
	public void killCountTracksGainsSinceImport()
	{
		GoalProgress p = new GoalProgress();
		// First message after import: that kill counts, earlier kc doesn't.
		assertTrue(IronsPubBingoPlugin.applyKillCount(p, "Zulrah", 506, true));
		assertEquals(1, p.n);
		assertTrue(IronsPubBingoPlugin.applyKillCount(p, "Zulrah", 507, true));
		assertEquals(2, p.n);
		// Repeated/stale report changes nothing.
		assertTrue(!IronsPubBingoPlugin.applyKillCount(p, "Zulrah", 507, true));
		assertEquals(2, p.n);
		// Missed messages are caught up from the reported total.
		assertTrue(IronsPubBingoPlugin.applyKillCount(p, "Zulrah", 510, true));
		assertEquals(5, p.n);
		// A second boss on the same goal sums independently.
		assertTrue(IronsPubBingoPlugin.applyKillCount(p, "Vorkath", 51, true));
		assertEquals(6, p.n);
	}

	@Test
	public void killCountBaselineRidesOutsideEventWindow()
	{
		GoalProgress p = new GoalProgress();
		// Kills before the event window baseline without counting...
		assertTrue(!IronsPubBingoPlugin.applyKillCount(p, "Zulrah", 500, false));
		assertTrue(!IronsPubBingoPlugin.applyKillCount(p, "Zulrah", 505, false));
		assertEquals(0, p.n);
		// ...then the window opens and only new kills count.
		assertTrue(IronsPubBingoPlugin.applyKillCount(p, "Zulrah", 506, true));
		assertEquals(1, p.n);
		// After the window closes, further kills are absorbed without counting.
		assertTrue(!IronsPubBingoPlugin.applyKillCount(p, "Zulrah", 520, false));
		assertEquals(1, p.n);
	}

	@Test
	public void boardIdAloneIsTheBoardsIdentity()
	{
		BingoBoard v1 = BingoBoard.parse(gson,
			"{\"id\":\"Summer-Bingo!\",\"version\":1,\"size\":1,\"tiles\":[{\"label\":\"a\",\"goals\":[{\"type\":\"DROP\",\"items\":[\"Bones\"],\"count\":2}]}]}");
		// Same id, everything else changed - labels, targets, even what the tile tracks:
		// hosts may tune a live event, so the id alone is the storage identity.
		BingoBoard v2 = BingoBoard.parse(gson,
			"{\"id\":\"summer-bingo\",\"version\":2,\"size\":1,\"tiles\":[{\"label\":\"edited\",\"points\":5,\"goals\":[{\"type\":\"DROP\",\"items\":[\"Ranarr weed\"],\"count\":9}]}]}");
		assertEquals("id_summer-bingo", v1.storageKey(gson));
		assertEquals(v1.storageKey(gson), v2.storageKey(gson));

		// Without an id, any edit at all produces a different key.
		BingoBoard hashed1 = BingoBoard.parse(gson, "{\"size\":1,\"tiles\":[{\"label\":\"a\"}]}");
		BingoBoard hashed2 = BingoBoard.parse(gson, "{\"size\":1,\"tiles\":[{\"label\":\"b\"}]}");
		assertTrue(!hashed1.storageKey(gson).equals(hashed2.storageKey(gson)));
	}

	@Test
	public void newGoalFieldsParse()
	{
		BingoBoard board = BingoBoard.parse(gson,
			"{\"diagonals\":false,\"size\":2,\"tiles\":[{\"label\":\"ids\",\"goals\":[{\"type\":\"DROP\",\"itemIds\":[30107]}]},{\"label\":\"purples\",\"goals\":[{\"type\":\"RAID_PURPLE\",\"distinct\":true,\"count\":2}]},{\"label\":\"chat\",\"goals\":[{\"type\":\"CHAT\",\"pattern\":\"key\",\"regions\":[6038],\"screenshot\":true}]},{\"label\":\"d\",\"goals\":[{\"type\":\"MANUAL\"}]}]}");
		assertEquals(4, board.maxLines());
		assertTrue(!board.diagonalsCount());

		BingoGoal ids = board.getTiles().get(0).goals.get(0);
		assertTrue(ids.matchesItem("Loop half of key", 30107));
		assertTrue(!ids.matchesItem("Loop half of key", 987));

		assertTrue(board.getTiles().get(1).goals.get(0).usesMatchedSet());

		BingoGoal chat = board.getTiles().get(2).goals.get(0);
		assertTrue(chat.allowsRegion(6038, -1));
		assertTrue(chat.allowsRegion(-1, 6038));
		assertTrue(!chat.allowsRegion(12850, 12851));
		assertTrue(chat.wantsScreenshot());
	}

	@Test
	public void lootKindRestrictsDropGoals()
	{
		BingoBoard board = BingoBoard.parse(gson,
			"{\"size\":2,\"tiles\":["
				+ "{\"label\":\"kills\",\"goals\":[{\"type\":\"DROP\",\"items\":[\"Bones\"],\"loot\":[\"KILL\"]}]},"
				+ "{\"label\":\"picks\",\"goals\":[{\"type\":\"DROP\",\"items\":[\"Coins\"],\"loot\":[\"pickpocket\"]}]},"
				+ "{\"label\":\"no chests\",\"goals\":[{\"type\":\"DROP\",\"items\":[\"Blood shard\"],\"loot\":[\"KILL\",\"PICKPOCKET\"]}]},"
				+ "{\"label\":\"any\",\"goals\":[{\"type\":\"DROP\",\"items\":[\"Blood shard\"]}]}]}");

		BingoGoal kills = board.getTiles().get(0).goals.get(0);
		assertTrue(kills.allowsLoot(BingoGoal.LootKind.KILL));
		assertTrue(!kills.allowsLoot(BingoGoal.LootKind.PICKPOCKET));
		assertTrue(!kills.allowsLoot(BingoGoal.LootKind.OTHER));
		assertEquals("Kill drops: Bones", kills.describe());

		BingoGoal picks = board.getTiles().get(1).goals.get(0);
		assertTrue(!picks.allowsLoot(BingoGoal.LootKind.KILL));
		assertTrue(picks.allowsLoot(BingoGoal.LootKind.PICKPOCKET));
		assertEquals("Pickpocket loot: Coins", picks.describe());

		BingoGoal noChests = board.getTiles().get(2).goals.get(0);
		assertTrue(noChests.allowsLoot(BingoGoal.LootKind.KILL));
		assertTrue(noChests.allowsLoot(BingoGoal.LootKind.PICKPOCKET));
		assertTrue(!noChests.allowsLoot(BingoGoal.LootKind.OTHER));
		assertEquals("Drops: Blood shard", noChests.describe());

		// Omitted keeps every channel, chests included.
		BingoGoal any = board.getTiles().get(3).goals.get(0);
		assertTrue(any.allowsLoot(BingoGoal.LootKind.KILL));
		assertTrue(any.allowsLoot(BingoGoal.LootKind.PICKPOCKET));
		assertTrue(any.allowsLoot(BingoGoal.LootKind.OTHER));

		// VALUE goals take the same mask - "a 4m drop from a kill, not a casket".
		BingoBoard valueBoard = BingoBoard.parse(gson,
			"{\"size\":1,\"tiles\":[{\"label\":\"big drop\",\"goals\":["
				+ "{\"type\":\"VALUE\",\"amount\":4000000,\"loot\":[\"KILL\"]}]}]}");
		BingoGoal big = valueBoard.getTiles().get(0).goals.get(0);
		assertTrue(big.allowsLoot(BingoGoal.LootKind.KILL));
		assertTrue(!big.allowsLoot(BingoGoal.LootKind.OTHER));

		try
		{
			BingoBoard.parse(gson,
				"{\"size\":1,\"tiles\":[{\"label\":\"x\",\"goals\":[{\"type\":\"DROP\",\"items\":[\"Bones\"],\"loot\":[\"stealing\"]}]}]}");
			fail("expected IllegalArgumentException");
		}
		catch (IllegalArgumentException e)
		{
			assertTrue(e.getMessage().contains("loot"));
		}
	}

	@Test
	public void trackingSignatureIgnoresTargetsAndCosmetics()
	{
		BingoBoard v1 = BingoBoard.parse(gson,
			"{\"size\":1,\"tiles\":[{\"label\":\"a\",\"points\":5,\"goals\":["
				+ "{\"type\":\"DROP\",\"items\":[\"Bones\",\"Egg\"],\"count\":10}]}]}");
		// Higher target, new label and points, reordered items: still the same tracking.
		BingoBoard v2 = BingoBoard.parse(gson,
			"{\"size\":1,\"tiles\":[{\"label\":\"renamed\",\"points\":9,\"goals\":["
				+ "{\"type\":\"DROP\",\"items\":[\"Egg\",\"Bones\"],\"count\":20,\"name\":\"x\"}]}]}");
		assertEquals(v1.getTiles().get(0).trackingSignature(), v2.getTiles().get(0).trackingSignature());

		// Tracking something else - here the tile becoming manual - is a new signature.
		BingoBoard manual = BingoBoard.parse(gson, "{\"size\":1,\"tiles\":[{\"label\":\"a\"}]}");
		assertTrue(!v1.getTiles().get(0).trackingSignature()
			.equals(manual.getTiles().get(0).trackingSignature()));

		// So is the same goal with a loot restriction added.
		BingoBoard restricted = BingoBoard.parse(gson,
			"{\"size\":1,\"tiles\":[{\"label\":\"a\",\"goals\":["
				+ "{\"type\":\"DROP\",\"items\":[\"Bones\",\"Egg\"],\"count\":10,\"loot\":[\"KILL\"]}]}]}");
		assertTrue(!v1.getTiles().get(0).trackingSignature()
			.equals(restricted.getTiles().get(0).trackingSignature()));
	}

	@Test
	public void lineAndBlackoutPointsParse()
	{
		BingoBoard board = BingoBoard.parse(gson,
			"{\"linePoints\":5,\"blackoutPoints\":50,\"size\":2,\"tiles\":["
				+ "{\"label\":\"a\"},{\"label\":\"b\"},{\"label\":\"c\"},{\"label\":\"d\"}]}");
		assertEquals(5, board.linePointsValue());
		assertEquals(50, board.blackoutPointsValue());
		assertEquals(6, board.maxLines());

		BingoBoard none = BingoBoard.parse(gson, "{\"size\":1,\"tiles\":[{\"label\":\"a\"}]}");
		assertEquals(0, none.linePointsValue());
		assertEquals(0, none.blackoutPointsValue());
	}

	@Test
	public void eventWindowParses()
	{
		BingoBoard board = BingoBoard.parse(gson,
			"{\"start\":\"2026-08-29T18:00Z\",\"end\":\"2026-09-07\",\"size\":1,\"tiles\":[{\"label\":\"a\"}]}");
		assertEquals("2026-08-29T18:00:00Z", board.startTime.toString());
		assertEquals("2026-09-07T00:00:00Z", board.endTime.toString());

		// The exact format Bingo Forge exports (milliseconds + Z)
		BingoBoard forgeStyle = BingoBoard.parse(gson,
			"{\"start\":\"2026-08-29T18:00:00.000Z\",\"size\":1,\"tiles\":[{\"label\":\"a\"}]}");
		assertEquals(board.startTime, forgeStyle.startTime);

		try
		{
			BingoBoard.parse(gson,
				"{\"start\":\"2026-09-07\",\"end\":\"2026-08-29\",\"size\":1,\"tiles\":[{\"label\":\"a\"}]}");
			fail("expected IllegalArgumentException");
		}
		catch (IllegalArgumentException e)
		{
			assertTrue(e.getMessage().contains("after"));
		}

		try
		{
			BingoBoard.parse(gson,
				"{\"start\":\"next tuesday\",\"size\":1,\"tiles\":[{\"label\":\"a\"}]}");
			fail("expected IllegalArgumentException");
		}
		catch (IllegalArgumentException e)
		{
			assertTrue(e.getMessage().contains("start"));
		}
	}

	@Test
	public void f2pTestBoardParses() throws IOException
	{
		BingoBoard board = BingoBoard.parse(gson, readResource("/test-board.json"));
		assertEquals(3, board.getSize());
		assertEquals(9, board.getTiles().size());
		// Every tile carries an icon (name or ID)
		for (BingoTile tile : board.getTiles())
		{
			assertTrue(tile.label, tile.iconItemId > 0 || tile.iconName != null);
		}
		// Coins tile got its numeric ID
		assertEquals(995, board.getTiles().get(2).iconItemId);
	}

	@Test
	public void progressionBoardParses() throws IOException
	{
		BingoBoard board = BingoBoard.parse(gson, readResource("/progression-board-8x8.json"));
		assertEquals(8, board.getSize());
		assertEquals(64, board.getTiles().size());
		int totalPoints = 0;
		for (BingoTile tile : board.getTiles())
		{
			assertTrue(tile.label, tile.iconItemId > 0 || tile.iconName != null);
			assertTrue(tile.label, tile.pointsValue() > 0);
			totalPoints += tile.pointsValue();
		}
		assertTrue(totalPoints > 300);
	}

	@Test
	public void memberStateAppliesLastWriteWins()
	{
		TeamMemberState cached = new TeamMemberState();

		TileProgress first = new TileProgress();
		first.goal(0, 1).n = 40;
		first.ts = 1000L;
		assertTrue(cached.apply("Alice", java.util.Map.of(3, first), 9));
		assertEquals(40, cached.tilesMap().get(3).goal(0, 1).n);

		// Older relayed copy must not overwrite the fresher one
		TileProgress stale = new TileProgress();
		stale.goal(0, 1).n = 20;
		stale.ts = 500L;
		assertTrue(!cached.apply("Alice", java.util.Map.of(3, stale), 9));
		assertEquals(40, cached.tilesMap().get(3).goal(0, 1).n);

		// Newer state wins, including resets to lower values
		TileProgress newer = new TileProgress();
		newer.goal(0, 1).n = 0;
		newer.ts = 2000L;
		assertTrue(cached.apply("Alice", java.util.Map.of(3, newer), 9));
		assertEquals(0, cached.tilesMap().get(3).goal(0, 1).n);

		// Out-of-range tiles are ignored
		TileProgress bogus = new TileProgress();
		bogus.ts = 3000L;
		assertTrue(!cached.apply("Alice", java.util.Map.of(99, bogus), 9));
	}

	@Test
	public void matchedNamesKeepGameCasingAndDedupeIgnoringCase()
	{
		GoalProgress p = new GoalProgress();
		assertTrue(p.addName("Raw chicken"));
		assertTrue(!p.addName("raw chicken"));
		assertEquals(1, p.matchedSet().size());
		assertEquals("Raw chicken", p.matchedSet().iterator().next());

		// Progress saved by an older version stored lowercase; it must not count twice,
		// and the properly cased name wins for display.
		GoalProgress legacy = new GoalProgress();
		legacy.matchedSet().add("feather");
		assertTrue(!legacy.addName("Feather"));
		assertEquals(1, legacy.matchedSet().size());
		assertEquals("Feather", legacy.matchedSet().iterator().next());
	}

	@Test
	public void adminCreditedMemberIdsAreAccepted()
	{
		assertTrue(IronsPubBingoPlugin.isAdminMember("admin:kaosrichie"));
		assertTrue(!IronsPubBingoPlugin.isAdminMember("b24aa30a64cf7ec1"));
		assertTrue(!IronsPubBingoPlugin.isAdminMember("admin:"));
		assertTrue(!IronsPubBingoPlugin.isAdminMember(null));
	}

	@Test
	public void adminCreditAddsToTeamProgressLikeAnyMember()
	{
		// A mobile player's screenshots credited by an admin (two batches: 40 then 60)
		// arrive as one synthetic member and must add to what clients tracked.
		TileProgress tracked = new TileProgress();
		tracked.goal(0, 1).n = 25;
		TileProgress credited = new TileProgress();
		credited.goal(0, 1).n = 100;

		TileProgress merged = TileProgress.merge(1, java.util.Arrays.asList(tracked, credited));
		assertEquals(125, merged.goal(0, 1).n);

		// An admin ticking the tile complete counts as a manual completion for the team.
		TileProgress completedByAdmin = new TileProgress();
		completedByAdmin.manual = true;
		assertTrue(TileProgress.merge(1, java.util.Arrays.asList(tracked, completedByAdmin)).manual);
	}

	@Test
	public void adminCreditIsReplacedWholesaleByNewerState()
	{
		// The store regenerates admin credit with a fresh timestamp on every sync, so a
		// corrected (or withdrawn) amount always wins over the cached copy.
		TeamMemberState cached = new TeamMemberState();
		TileProgress first = new TileProgress();
		first.goal(0, 1).n = 100;
		first.ts = 1000L;
		cached.apply("Bob (verified)", java.util.Map.of(2, first), 9);
		assertEquals(100, cached.tilesMap().get(2).goal(0, 1).n);

		TileProgress corrected = new TileProgress();
		corrected.goal(0, 1).n = 40;
		corrected.ts = 2000L;
		assertTrue(cached.apply("Bob (verified)", java.util.Map.of(2, corrected), 9));
		assertEquals(40, cached.tilesMap().get(2).goal(0, 1).n);
	}

	@Test
	public void teamMergeSumsCountsAndUnionsDistinct()
	{
		// Player A: one unique + an imp champion scroll. Player B: one unique + the same
		// imp scroll and a goblin scroll, plus a manual tick.
		TileProgress a = new TileProgress();
		a.goal(0, 2).n = 1;
		a.goal(1, 2).matchedSet().add("imp champion scroll");
		TileProgress b = new TileProgress();
		b.goal(0, 2).n = 1;
		b.goal(1, 2).matchedSet().add("imp champion scroll");
		b.goal(1, 2).matchedSet().add("goblin champion scroll");
		b.manual = true;

		TileProgress merged = TileProgress.merge(2, java.util.Arrays.asList(a, b));
		assertEquals(2, merged.goal(0, 2).n);
		assertEquals(2, merged.goal(1, 2).matchedSet().size());
		assertTrue(merged.manual);
	}

	@Test
	public void shareStripsPerMemberInternals()
	{
		TileProgress p = new TileProgress();
		p.manual = true;
		GoalProgress g = p.goal(0, 1);
		g.n = 7;
		g.baseline = 123456L;
		g.kcMap().put("zulrah", new long[]{100, 107});
		g.matchedSet().add("tanzanite fang");

		TileProgress share = p.toShare(1);
		assertTrue(share.manual);
		assertEquals(7, share.goal(0, 1).n);
		assertEquals(1, share.goal(0, 1).matchedSet().size());
		assertEquals(null, share.goal(0, 1).baseline);
		assertEquals(null, share.goal(0, 1).kc);
	}

	@Test
	public void tileIconParses()
	{
		BingoBoard board = BingoBoard.parse(gson,
			"{\"size\":2,\"tiles\":["
				+ "{\"label\":\"id icon\",\"icon\":20997},"
				+ "{\"label\":\"name icon\",\"icon\":\"Twisted bow\"},"
				+ "{\"label\":\"numeric string\",\"icon\":\"11832\"},"
				+ "{\"label\":\"none\"}]}");
		assertEquals(20997, board.getTiles().get(0).iconItemId);
		assertEquals("Twisted bow", board.getTiles().get(1).iconName);
		assertEquals(11832, board.getTiles().get(2).iconItemId);
		assertEquals(-1, board.getTiles().get(3).iconItemId);
	}

	@Test
	public void chatPatternsReadAsPlainText()
	{
		assertEquals("Corrupted challenge duration",
			BingoGoal.readablePattern("Corrupted challenge duration: [0-6]:[0-5][0-9]"));
		assertEquals("You have completed ... elite Treasure Trails",
			BingoGoal.readablePattern("You have completed [0-9,]+ elite Treasure Trails"));
		assertEquals("You bury the bones", BingoGoal.readablePattern("You bury the bones"));
		// Nothing readable left
		assertEquals(null, BingoGoal.readablePattern("[0-9]+"));
	}

	@Test
	public void goalLabelsDropWildcardsAndUseNameOverride()
	{
		BingoBoard board = BingoBoard.parse(gson,
			"{\"size\":2,\"tiles\":["
				+ "{\"label\":\"a\",\"goals\":[{\"type\":\"DROP\",\"items\":[\"3rd age*\"]}]},"
				+ "{\"label\":\"b\",\"goals\":[{\"type\":\"KC\",\"npcs\":[\"*Corrupted Gauntlet*\"]}]},"
				+ "{\"label\":\"c\",\"goals\":[{\"type\":\"CHAT\",\"pattern\":\"You bury the bones\"}]},"
				+ "{\"label\":\"d\",\"goals\":[{\"type\":\"CHAT\",\"name\":\"Sub-7 Corrupted Gauntlet\","
				+ "\"pattern\":\"Corrupted challenge duration: [0-6]:[0-5][0-9]\"}]}]}");
		assertEquals("Drops: 3rd age", board.getTiles().get(0).goals.get(0).shortDescribe());
		assertEquals("Kills: Corrupted Gauntlet", board.getTiles().get(1).goals.get(0).shortDescribe());
		assertEquals("You bury the bones", board.getTiles().get(2).goals.get(0).shortDescribe());
		assertEquals("Sub-7 Corrupted Gauntlet", board.getTiles().get(3).goals.get(0).shortDescribe());
		// The generated description stays available behind the details toggle
		assertTrue(board.getTiles().get(3).goals.get(0).hasExtraDetail());
	}

	@Test
	public void lapGoalsResolveCoursesLeniently()
	{
		BingoBoard board = BingoBoard.parse(gson,
			"{\"size\":2,\"tiles\":["
				+ "{\"label\":\"a\",\"goals\":[{\"type\":\"LAP\",\"course\":\"CANIFIS\",\"count\":100}]},"
				+ "{\"label\":\"b\",\"goals\":[{\"type\":\"LAP\",\"course\":\"Seers Village\"}]},"
				+ "{\"label\":\"c\",\"goals\":[{\"type\":\"LAP\",\"course\":\"relleka\"}]},"
				+ "{\"label\":\"d\",\"goals\":[{\"type\":\"LAP\",\"course\":\"prif\"}]}]}");
		assertEquals(BingoCourse.CANIFIS, board.getTiles().get(0).goals.get(0).courseEnum);
		assertEquals(BingoCourse.SEERS, board.getTiles().get(1).goals.get(0).courseEnum);
		assertEquals(BingoCourse.RELLEKKA, board.getTiles().get(2).goals.get(0).courseEnum);
		assertEquals(BingoCourse.PRIFDDINAS, board.getTiles().get(3).goals.get(0).courseEnum);
		assertEquals("Canifis course laps", board.getTiles().get(0).goals.get(0).shortDescribe());
		assertEquals(100, board.getTiles().get(0).goals.get(0).target());

		try
		{
			BingoBoard.parse(gson,
				"{\"size\":1,\"tiles\":[{\"label\":\"x\",\"goals\":[{\"type\":\"LAP\",\"course\":\"lumbridge\"}]}]}");
			fail("expected IllegalArgumentException");
		}
		catch (IllegalArgumentException e)
		{
			assertTrue(e.getMessage().contains("unknown agility course"));
		}
	}

	@Test
	public void killGoalsParseAndDescribe()
	{
		BingoBoard board = BingoBoard.parse(gson,
			"{\"size\":1,\"tiles\":[{\"label\":\"500 men\",\"goals\":["
				+ "{\"type\":\"KILL\",\"npcs\":[\"Man\",\"Woman\"],\"count\":500}]}]}");
		BingoGoal goal = board.getTiles().get(0).goals.get(0);
		assertEquals(GoalType.KILL, goal.goalType);
		assertEquals(500, goal.target());
		assertEquals("Kills: Man, Woman", goal.describe());
		assertTrue(Wildcards.anyMatch(goal.npcPatterns, "Man"));
		assertTrue(!Wildcards.anyMatch(goal.npcPatterns, "Manticore"));

		try
		{
			BingoBoard.parse(gson, "{\"size\":1,\"tiles\":[{\"label\":\"x\",\"goals\":[{\"type\":\"KILL\"}]}]}");
			fail("expected IllegalArgumentException");
		}
		catch (IllegalArgumentException e)
		{
			assertTrue(e.getMessage().contains("npcs"));
		}
	}

	@Test
	public void countdownFormatsAsDaysHoursMinutesSeconds()
	{
		assertEquals("2:13:45:09", IronsPubBingoPlugin.formatCountdown(
			((2L * 86400 + 13 * 3600 + 45 * 60 + 9) * 1000) + 500));
		assertEquals("0:00:00:00", IronsPubBingoPlugin.formatCountdown(0));
		assertEquals("0:00:00:00", IronsPubBingoPlugin.formatCountdown(-5000));
		assertEquals("0:00:00:59", IronsPubBingoPlugin.formatCountdown(59_999));
	}

	@Test
	public void lapDetectionMatchesCourseEndTiles()
	{
		assertEquals(BingoCourse.CANIFIS, BingoCourse.forRegion(13878));
		assertTrue(BingoCourse.CANIFIS.isEndPoint(new net.runelite.api.coords.WorldPoint(3510, 3485, 0)));
		assertTrue(!BingoCourse.CANIFIS.isEndPoint(new net.runelite.api.coords.WorldPoint(3510, 3486, 0)));
		assertEquals(null, BingoCourse.forRegion(12850)); // Lumbridge: not a course
	}

	@Test
	public void wildcardMatching()
	{
		assertTrue(Wildcards.compile("Ancient page*").matcher("Ancient page 3").matches());
		assertTrue(Wildcards.compile("*champion scroll*").matcher("Imp champion scroll").matches());
		assertTrue(!Wildcards.compile("Long bone").matcher("Curved bone").matches());
	}

	private String readResource(String path) throws IOException
	{
		try (InputStream in = BingoBoardTest.class.getResourceAsStream(path))
		{
			assertNotNull(path + " missing from test resources", in);
			return new String(in.readAllBytes(), StandardCharsets.UTF_8);
		}
	}
}

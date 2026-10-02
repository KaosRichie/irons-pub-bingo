package com.ironspubbingo;

import com.google.gson.Gson;
import java.util.Arrays;
import java.util.Collections;
import java.util.Map;
import org.junit.Test;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

public class BingoProgressHistoryTest
{
	// An ANY tile: goal 0 needs 10 kills, goal 1 needs 5.
	private final BingoTile tile = BingoBoard.parse(new Gson(),
		"{\"size\":1,\"tiles\":[{\"label\":\"Either\",\"mode\":\"ANY\",\"goals\":["
			+ "{\"type\":\"KILL\",\"npcs\":[\"Man\"],\"count\":10},"
			+ "{\"type\":\"KILL\",\"npcs\":[\"Goblin\"],\"count\":5}]}]}").getTiles().get(0);

	private static TileProgress state(long ts, long a, long b)
	{
		TileProgress tp = new TileProgress();
		tp.ts = ts;
		tp.goal(0, 2).n = a;
		tp.goal(1, 2).n = b;
		return tp;
	}

	private static long n(Map<String, TileProgress> snapshot, String member, int goal)
	{
		return snapshot.get(member).goal(goal, 2).n;
	}

	@Test
	public void freezesWhereTheTeamCompletedTheTile()
	{
		BingoProgressHistory history = new BingoProgressHistory();
		history.record(0, "y", state(1_000_000, 0, 2), 2);
		history.record(0, "x", state(2_000_000, 10, 0), 2); // x completes goal 0
		history.record(0, "y", state(3_000_000, 0, 4), 2);  // y keeps counting afterwards
		Map<String, TileProgress> snapshot = history.snapshot(0, tile, Arrays.asList("x", "y"));
		assertEquals(10, n(snapshot, "x", 0));
		assertEquals("the other goal as it stood at completion", 2, n(snapshot, "y", 1));
	}

	@Test
	public void withoutTheMemberWhoLeftItFreezesWhereTheRestCompletedIt()
	{
		BingoProgressHistory history = new BingoProgressHistory();
		history.record(0, "y", state(1_000_000, 0, 2), 2);
		history.record(0, "x", state(2_000_000, 10, 0), 2);
		history.record(0, "y", state(3_000_000, 0, 5), 2);  // y completes goal 1 later
		history.record(0, "y", state(4_000_000, 0, 7), 2);
		Map<String, TileProgress> snapshot = history.snapshot(0, tile, Collections.singletonList("y"));
		assertEquals("frozen when y reached the target, not at 7", 5, n(snapshot, "y", 1));
	}

	@Test
	public void twoGoalsCrossingAtOnceCompleteOnlyOne()
	{
		BingoProgressHistory history = new BingoProgressHistory();
		history.record(0, "y", state(1_000_000, 3, 1), 2);
		history.record(0, "y", state(2_000_000, 12, 6), 2); // both past their targets at once
		Map<String, TileProgress> snapshot = history.snapshot(0, tile, Collections.singletonList("y"));
		assertEquals(12, n(snapshot, "y", 0));
		assertEquals("the second goal shows where it stood just before", 1, n(snapshot, "y", 1));
	}

	@Test
	public void aResetStartsANewCompletion()
	{
		BingoProgressHistory history = new BingoProgressHistory();
		history.record(0, "y", state(1_000_000, 10, 0), 2);
		history.record(0, "y", state(2_000_000, 0, 0), 2);  // reset
		history.record(0, "y", state(3_000_000, 2, 5), 2);  // completed again by goal 1
		Map<String, TileProgress> snapshot = history.snapshot(0, tile, Collections.singletonList("y"));
		assertEquals(5, n(snapshot, "y", 1));
		// Goal 0 moved in that same record, so it shows where it stood just before.
		assertEquals(0, n(snapshot, "y", 0));
	}

	@Test
	public void noCompletionInTheHistoryGivesNoSnapshot()
	{
		BingoProgressHistory history = new BingoProgressHistory();
		history.record(0, "y", state(1_000_000, 3, 1), 2);
		assertNull(history.snapshot(0, tile, Collections.singletonList("y")));
	}

	@Test
	public void survivesASaveAndLoad()
	{
		Gson gson = new Gson();
		BingoProgressHistory history = new BingoProgressHistory();
		history.record(0, "y", state(1_000_000, 0, 2), 2);
		history.record(0, "y", state(2_000_000, 0, 5), 2);
		BingoProgressHistory loaded = BingoProgressHistory.fromJson(gson, gson.toJson(history));
		BingoProgressHistory session = new BingoProgressHistory();
		session.record(0, "y", state(3_000_000, 0, 6), 2);
		session.absorb(loaded);
		assertEquals(5, n(session.snapshot(0, tile, Collections.singletonList("y")), "y", 1));
	}
}

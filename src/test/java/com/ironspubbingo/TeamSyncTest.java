package com.ironspubbingo;

import java.util.HashMap;
import java.util.Map;
import org.junit.Test;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Client-side merge semantics: the same last-write-wins rules the store enforces
 * (cloudflare-store/test/store-tests.mjs) must hold in the plugin's own team cache, or a stale
 * relay could resurrect progress locally that the store already dropped.
 */
public class TeamSyncTest
{
	private static Map<Integer, TileProgress> share(int tileIndex, long ts, long n)
	{
		TileProgress p = new TileProgress();
		p.ts = ts;
		p.goal(0, 1).n = n;
		Map<Integer, TileProgress> tiles = new HashMap<>();
		tiles.put(tileIndex, p);
		return tiles;
	}

	private static long count(TeamMemberState member, int tileIndex)
	{
		return member.tilesMap().get(tileIndex).goal(0, 1).n;
	}

	@Test
	public void newerOwnerTimestampWins()
	{
		TeamMemberState member = new TeamMemberState();
		assertTrue(member.apply("Alice", share(0, 1000, 5), 9));
		assertEquals(5, count(member, 0));

		assertFalse(member.apply("Alice", share(0, 500, 99), 9));
		assertEquals("stale relay must not overwrite fresher data", 5, count(member, 0));

		assertTrue(member.apply("Alice", share(0, 2000, 7), 9));
		assertEquals(7, count(member, 0));
	}

	@Test
	public void timestampedResetBeatsStaleRelay()
	{
		TeamMemberState member = new TeamMemberState();
		member.apply("Alice", share(0, 1000, 13), 9);
		// The owner reset: empty progress with a fresh timestamp (resetOwnProgress()).
		member.apply("Alice", share(0, 3000, 0), 9);
		assertEquals(0, count(member, 0));
		// An old cache relays the pre-reset progress - it must lose.
		assertFalse(member.apply("Alice", share(0, 1000, 13), 9));
		assertEquals("stale relay must not resurrect wiped progress", 0, count(member, 0));
	}

	@Test
	public void outOfRangeTilesAreIgnored()
	{
		TeamMemberState member = new TeamMemberState();
		assertFalse(member.apply(null, share(7, 1000, 5), 3));
		assertTrue(member.tilesMap().isEmpty());
	}

	@Test
	public void changesAlwaysStampPastThePreviousTimestamp()
	{
		// An adopted store copy may be stamped ahead of this clock (admin wipes are).
		assertEquals(1000, IronsPubBingoPlugin.nextTs(null, 1000));
		assertEquals(1000, IronsPubBingoPlugin.nextTs(500L, 1000));
		assertEquals(5001, IronsPubBingoPlugin.nextTs(5000L, 1000));
	}
}

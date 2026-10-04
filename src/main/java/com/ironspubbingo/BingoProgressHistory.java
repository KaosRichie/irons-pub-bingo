package com.ironspubbingo;

import com.google.gson.Gson;
import com.google.gson.JsonSyntaxException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

/**
 * When each member's progress on each tile changed, so a completed tile can be frozen
 * at the moment it completed, worked out again for whoever is on the team now. A member
 * who leaves is simply left out of the replay, and the tile freezes at the first moment
 * the remaining members completed it.
 *
 * Kept small: a record is added only when a value changes, records closer together than
 * a minute are merged, and each member keeps at most MAX_SNAPS records per tile (the
 * closest pairs merge first). A record that may stand for several steps (a merged one, or
 * a teammate's state as it arrived in a sync) is marked stepped: when it is the one that
 * completes the tile, the replay takes that member only as far as the target needed.
 * Client thread only.
 */
class BingoProgressHistory
{
	private static final long COALESCE_MS = 60_000;
	private static final int MAX_SNAPS = 120;

	/** One member's tile state from time t on. */
	static class Snap
	{
		long t;
		/** Per goal: the plain counter. */
		long[] n;
		/** Per goal: item or pet names first seen here (distinct goals), or null. */
		List<List<String>> add;
		boolean manual;
		/** May stand for several steps, so the moment it crossed a target is not known. */
		boolean stepped;
	}

	/** A member's state at some moment, rebuilt from their snaps. */
	private static class State
	{
		long[] n;
		List<Map<String, String>> names; // per goal: lowercase -> as received
		boolean manual;
	}

	/** tile -> member id -> snaps, oldest first. */
	Map<Integer, Map<String, List<Snap>>> tiles = new HashMap<>();
	transient boolean dirty;

	/** Records a member's current state of a tile, if it differs from the last record. */
	void record(int tile, String member, TileProgress progress, int goalCount)
	{
		record(tile, member, progress, goalCount, false);
	}

	/** @param stepped the change may stand for several steps (a teammate's synced state) */
	void record(int tile, String member, TileProgress progress, int goalCount, boolean stepped)
	{
		List<Snap> snaps = tiles.computeIfAbsent(tile, k -> new HashMap<>())
			.computeIfAbsent(member, k -> new ArrayList<>());
		State current = stateAt(snaps, Long.MAX_VALUE, goalCount);
		long[] n = new long[goalCount];
		List<List<String>> add = null;
		boolean changed = progress.manual != current.manual;
		for (int g = 0; g < goalCount; g++)
		{
			GoalProgress p = progress.goal(g, goalCount);
			n[g] = p.n;
			changed |= n[g] != current.n[g];
			if (p.matched == null)
			{
				continue;
			}
			for (String name : p.matched)
			{
				if (name != null && !current.names.get(g).containsKey(name.toLowerCase(Locale.ROOT)))
				{
					if (add == null)
					{
						add = new ArrayList<>();
					}
					while (add.size() < goalCount)
					{
						add.add(null);
					}
					if (add.get(g) == null)
					{
						add.set(g, new ArrayList<>());
					}
					add.get(g).add(name);
					changed = true;
				}
			}
		}
		if (!changed)
		{
			return;
		}
		long t = progress.ts == null ? System.currentTimeMillis() : progress.ts;
		Snap last = snaps.isEmpty() ? null : snaps.get(snaps.size() - 1);
		if (last != null && t < last.t)
		{
			t = last.t; // a record never goes back in time
		}
		if (last != null && snaps.size() > 1 && t - last.t < COALESCE_MS)
		{
			last.t = t;
			last.n = n;
			last.manual = progress.manual;
			last.add = mergeNames(last.add, add, goalCount);
			last.stepped = true;
		}
		else
		{
			Snap snap = new Snap();
			snap.t = t;
			snap.n = n;
			snap.add = add;
			snap.manual = progress.manual;
			snap.stepped = stepped;
			snaps.add(snap);
			while (snaps.size() > MAX_SNAPS)
			{
				mergeClosestPair(snaps, goalCount);
			}
		}
		dirty = true;
	}

	/**
	 * The members' states at the start of the tile's current, unbroken completion, or
	 * null when the history never shows the tile complete. On an ANY tile exactly one
	 * goal completes it: when several crossed their target at the same recorded moment,
	 * the others keep the values they had just before.
	 */
	Map<String, TileProgress> snapshot(int tile, BingoTile definition, Collection<String> members)
	{
		Map<String, List<Snap>> byMember = tiles.get(tile);
		if (byMember == null)
		{
			return null;
		}
		int goalCount = definition.goals.size();
		TreeSet<Long> times = new TreeSet<>();
		for (String member : members)
		{
			for (Snap snap : byMember.getOrDefault(member, new ArrayList<>()))
			{
				times.add(snap.t);
			}
		}
		long runStart = Long.MIN_VALUE;
		long beforeRun = Long.MIN_VALUE;
		long previous = Long.MIN_VALUE;
		boolean inRun = false;
		for (long t : times)
		{
			boolean complete = definition.isComplete(merge(statesAt(byMember, members, t, goalCount), goalCount));
			if (complete && !inRun)
			{
				runStart = t;
				beforeRun = previous;
			}
			inRun = complete;
			previous = t;
		}
		if (!inRun)
		{
			return null;
		}
		Map<String, TileProgress> at = statesAt(byMember, members, runStart, goalCount);
		Map<String, TileProgress> before = statesAt(byMember, members, beforeRun, goalCount);
		if (definition.anyMode)
		{
			TileProgress mergedAt = merge(at, goalCount);
			TileProgress mergedBefore = merge(before, goalCount);
			int chosen = -1;
			for (int g = 0; g < goalCount && chosen < 0; g++)
			{
				BingoGoal goal = definition.goals.get(g);
				if (goal.goalType != GoalType.MANUAL && goal.isComplete(mergedAt.goal(g, goalCount))
					&& !goal.isComplete(mergedBefore.goal(g, goalCount)))
				{
					chosen = g;
				}
			}
			if (chosen >= 0 || mergedAt.manual)
			{
				// Every goal but the one that completed the tile (all of them, when a
				// manual tick did) shows where it stood just before.
				for (Map.Entry<String, TileProgress> entry : at.entrySet())
				{
					TileProgress was = before.get(entry.getKey());
					for (int g = 0; g < goalCount; g++)
					{
						if (g != chosen)
						{
							GoalProgress into = entry.getValue().goal(g, goalCount);
							GoalProgress from = was.goal(g, goalCount);
							into.n = from.n;
							into.matched = from.matched;
						}
					}
				}
			}
		}
		trimSteppedCrossings(byMember, definition, at, before, runStart, goalCount);
		return at;
	}

	/**
	 * A goal that crossed its target in a stepped record crossed it somewhere inside those
	 * steps: the members whose stepped record it was are taken back toward where they stood
	 * before, only as far as the target needed. Exact records are left as they are.
	 */
	private static void trimSteppedCrossings(Map<String, List<Snap>> byMember, BingoTile definition,
		Map<String, TileProgress> at, Map<String, TileProgress> before, long runStart, int goalCount)
	{
		TileProgress mergedAt = merge(at, goalCount);
		TileProgress mergedBefore = merge(before, goalCount);
		for (int g = 0; g < goalCount; g++)
		{
			BingoGoal goal = definition.goals.get(g);
			if (goal.goalType == GoalType.MANUAL || goal.usesMatchedSet()
				|| !goal.isComplete(mergedAt.goal(g, goalCount)) || goal.isComplete(mergedBefore.goal(g, goalCount)))
			{
				continue;
			}
			long excess = mergedAt.goal(g, goalCount).n - goal.target();
			for (Map.Entry<String, TileProgress> entry : at.entrySet())
			{
				if (excess <= 0)
				{
					break;
				}
				if (!steppedAt(byMember.get(entry.getKey()), runStart))
				{
					continue;
				}
				GoalProgress now = entry.getValue().goal(g, goalCount);
				long cut = Math.min(excess, now.n - before.get(entry.getKey()).goal(g, goalCount).n);
				if (cut > 0)
				{
					now.n -= cut;
					excess -= cut;
				}
			}
		}
	}

	private static boolean steppedAt(List<Snap> snaps, long t)
	{
		for (Snap snap : snaps == null ? new ArrayList<Snap>() : snaps)
		{
			if (snap.t == t)
			{
				return snap.stepped;
			}
		}
		return false;
	}

	/** Adds records read from disk that are older than anything recorded since. */
	void absorb(BingoProgressHistory older)
	{
		if (older == null || older.tiles == null)
		{
			return;
		}
		for (Map.Entry<Integer, Map<String, List<Snap>>> tile : older.tiles.entrySet())
		{
			Map<String, List<Snap>> mine = tiles.computeIfAbsent(tile.getKey(), k -> new HashMap<>());
			for (Map.Entry<String, List<Snap>> member : tile.getValue().entrySet())
			{
				List<Snap> current = mine.get(member.getKey());
				List<Snap> combined = new ArrayList<>();
				long firstNew = current == null || current.isEmpty() ? Long.MAX_VALUE : current.get(0).t;
				for (Snap snap : member.getValue())
				{
					if (snap != null && snap.n != null && snap.t < firstNew)
					{
						combined.add(snap);
					}
				}
				if (current != null)
				{
					combined.addAll(current);
				}
				mine.put(member.getKey(), combined);
			}
		}
	}

	static BingoProgressHistory fromJson(Gson gson, String json)
	{
		try
		{
			BingoProgressHistory history = gson.fromJson(json, BingoProgressHistory.class);
			return history == null || history.tiles == null ? new BingoProgressHistory() : history;
		}
		catch (JsonSyntaxException e)
		{
			return new BingoProgressHistory();
		}
	}

	private static Map<String, TileProgress> statesAt(Map<String, List<Snap>> byMember,
		Collection<String> members, long t, int goalCount)
	{
		Map<String, TileProgress> out = new LinkedHashMap<>();
		for (String member : members)
		{
			State state = stateAt(byMember.getOrDefault(member, new ArrayList<>()), t, goalCount);
			TileProgress progress = new TileProgress();
			progress.manual = state.manual;
			for (int g = 0; g < goalCount; g++)
			{
				GoalProgress p = progress.goal(g, goalCount);
				p.n = state.n[g];
				if (!state.names.get(g).isEmpty())
				{
					p.matched = new HashSet<>(state.names.get(g).values());
				}
			}
			out.put(member, progress);
		}
		return out;
	}

	private static State stateAt(List<Snap> snaps, long t, int goalCount)
	{
		State state = new State();
		state.n = new long[goalCount];
		state.names = new ArrayList<>();
		for (int g = 0; g < goalCount; g++)
		{
			state.names.add(new HashMap<>());
		}
		for (Snap snap : snaps)
		{
			if (snap.t > t)
			{
				break;
			}
			for (int g = 0; g < goalCount; g++)
			{
				state.n[g] = snap.n != null && g < snap.n.length ? snap.n[g] : 0;
				if (snap.add != null && g < snap.add.size() && snap.add.get(g) != null)
				{
					for (String name : snap.add.get(g))
					{
						state.names.get(g).putIfAbsent(name.toLowerCase(Locale.ROOT), name);
					}
				}
			}
			state.manual = snap.manual;
		}
		return state;
	}

	private static TileProgress merge(Map<String, TileProgress> states, int goalCount)
	{
		return TileProgress.merge(goalCount, states.values());
	}

	private static List<List<String>> mergeNames(List<List<String>> a, List<List<String>> b, int goalCount)
	{
		if (a == null)
		{
			return b;
		}
		if (b == null)
		{
			return a;
		}
		List<List<String>> out = new ArrayList<>();
		for (int g = 0; g < goalCount; g++)
		{
			Set<String> names = new java.util.LinkedHashSet<>();
			if (g < a.size() && a.get(g) != null)
			{
				names.addAll(a.get(g));
			}
			if (g < b.size() && b.get(g) != null)
			{
				names.addAll(b.get(g));
			}
			out.add(names.isEmpty() ? null : new ArrayList<>(names));
		}
		return out;
	}

	/** Folds the earlier of the two closest records (never the first) into the later one. */
	private static void mergeClosestPair(List<Snap> snaps, int goalCount)
	{
		int best = 1;
		long bestGap = Long.MAX_VALUE;
		for (int i = 1; i < snaps.size() - 1; i++)
		{
			long gap = snaps.get(i + 1).t - snaps.get(i).t;
			if (gap < bestGap)
			{
				bestGap = gap;
				best = i;
			}
		}
		Snap dropped = snaps.remove(best);
		Snap next = snaps.get(best);
		next.add = mergeNames(dropped.add, next.add, goalCount);
		next.stepped = true;
	}
}

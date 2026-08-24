package com.ironspubbingo;

import java.util.ArrayList;
import java.util.Collection;
import java.util.HashSet;
import java.util.List;

/**
 * Saved progress for one tile. Serialized to profile config keyed by the board hash,
 * so each account tracks its own progress per board.
 */
public class TileProgress
{
	List<GoalProgress> goals;
	/** Player ticked the tile off by hand (manual tiles, or host-approved overrides). */
	boolean manual;
	/**
	 * When the OWNER of this progress last changed it (epoch ms). Stamped only by the owning
	 * client, so relayed/stored copies can be compared last-write-wins without clock skew
	 * issues between players.
	 */
	Long ts;

	/**
	 * A copy safe to broadcast to teammates: counters, distinct item names, the manual
	 * flag and the owner timestamp, without per-member internals (XP/kill count baselines).
	 */
	TileProgress toShare(int goalCount)
	{
		TileProgress share = new TileProgress();
		share.manual = manual;
		share.ts = ts;
		for (int g = 0; g < goalCount; g++)
		{
			GoalProgress own = goal(g, goalCount);
			GoalProgress copy = share.goal(g, goalCount);
			copy.n = own.n;
			if (own.matched != null && !own.matched.isEmpty())
			{
				copy.matched = new HashSet<>(own.matched);
			}
		}
		return share;
	}

	/**
	 * Combines the progress of several team members into one team view:
	 * counters sum ("2 uniques" = one each from two people), distinct item sets union
	 * (the same champion scroll found twice still counts once), manual ticks OR.
	 */
	static TileProgress merge(int goalCount, Collection<TileProgress> members)
	{
		TileProgress merged = new TileProgress();
		for (TileProgress member : members)
		{
			merged.manual |= member.manual;
			for (int g = 0; g < goalCount; g++)
			{
				GoalProgress from = member.goal(g, goalCount);
				GoalProgress into = merged.goal(g, goalCount);
				into.n += from.n;
				if (from.matched != null)
				{
					for (String name : from.matched)
					{
						into.addName(name);
					}
				}
			}
		}
		return merged;
	}

	/**
	 * Returns the progress slot for a goal, growing the list to the tile's goal count
	 * so boards edited between sessions do not cause index errors.
	 */
	GoalProgress goal(int index, int goalCount)
	{
		if (goals == null)
		{
			goals = new ArrayList<>();
		}
		while (goals.size() < goalCount)
		{
			goals.add(new GoalProgress());
		}
		GoalProgress p = goals.get(index);
		if (p == null)
		{
			p = new GoalProgress();
			goals.set(index, p);
		}
		return p;
	}
}

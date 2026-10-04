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
	 * This member's share of the tile as it stood the moment the tile completed, worked out
	 * and published by the owner's client, which watched it happen. Teammates who only see
	 * the tile later freeze these numbers instead of guessing. Null while the tile is not
	 * complete, or before the owner's client has seen it complete.
	 */
	TileProgress completedAt;
	/**
	 * On a published share: the member ids the owner worked it out with. A share only holds
	 * while all of them are still on the team; once one leaves, the tile completed at a
	 * different moment and the owner publishes again.
	 */
	List<String> with;

	/**
	 * A copy safe to broadcast to teammates: counters, distinct item names, the manual
	 * flag and the owner timestamp, without per-member internals (XP/kill count baselines).
	 */
	TileProgress toShare(int goalCount)
	{
		TileProgress share = new TileProgress();
		share.manual = manual;
		share.ts = ts;
		if (completedAt != null)
		{
			share.completedAt = completedAt.counts(goalCount);
			share.completedAt.with = completedAt.with == null ? null : new ArrayList<>(completedAt.with);
		}
		for (int g = 0; g < goalCount; g++)
		{
			GoalProgress own = goal(g, goalCount);
			GoalProgress copy = share.goal(g, goalCount);
			copy.n = own.n;
			if (own.matched != null && !own.matched.isEmpty())
			{
				copy.matched = new HashSet<>(own.matched);
			}
			if (own.got != null && !own.got.isEmpty())
			{
				copy.got = new java.util.LinkedHashMap<>(own.got);
			}
		}
		return share;
	}

	/** Just the numbers: counters, distinct names and the manual tick. */
	TileProgress counts(int goalCount)
	{
		TileProgress copy = new TileProgress();
		copy.manual = manual;
		for (int g = 0; g < goalCount; g++)
		{
			GoalProgress own = goal(g, goalCount);
			GoalProgress into = copy.goal(g, goalCount);
			into.n = own.n;
			if (own.matched != null && !own.matched.isEmpty())
			{
				into.matched = new HashSet<>(own.matched);
			}
		}
		return copy;
	}

	/** Whether there is any progress at all: a count, a name or a tick. */
	boolean hasProgress()
	{
		if (manual)
		{
			return true;
		}
		for (GoalProgress p : goals == null ? new ArrayList<GoalProgress>() : goals)
		{
			if (p != null && (p.n != 0 || p.matched != null && !p.matched.isEmpty()))
			{
				return true;
			}
		}
		return false;
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
				if (from.got != null)
				{
					for (java.util.Map.Entry<String, Long> entry : from.got.entrySet())
					{
						into.addGot(entry.getKey(), entry.getValue() == null ? 0 : entry.getValue());
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

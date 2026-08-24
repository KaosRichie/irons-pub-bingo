package com.ironspubbingo;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * One tile on the bingo board, deserialized from the board JSON.
 */
public class BingoTile
{
	/** Short label shown on the board, e.g. "5x Ancient Pages from Mith Drags". */
	String label;
	/** Optional longer rules text shown in the tile detail view. */
	String description;
	/** "ALL" (default) = every goal must complete; "ANY" = one goal is enough (for "X or Y" tiles). */
	String mode;
	/** Optional tile icon: an item ID (number) or an exact item name (string, tradeables only). */
	Object icon;
	/** Optional points awarded for completing this tile. */
	Integer points;
	List<BingoGoal> goals;

	transient boolean anyMode;
	/** Item ID given directly in the board file, or -1. */
	transient int iconItemId = -1;
	/** Item name still to be resolved to an ID at render time, or null. */
	transient String iconName;
	/** Cached result of resolving {@link #iconName}: 0 = not tried, -1 = not found. */
	transient int resolvedIconId;

	String validate(int tileIndex)
	{
		String where = "tile " + (tileIndex + 1);
		if (label == null || label.trim().isEmpty())
		{
			return where + ": missing label";
		}
		if (mode != null)
		{
			String m = mode.trim().toUpperCase(Locale.ROOT);
			if (!m.equals("ALL") && !m.equals("ANY"))
			{
				return where + ": mode must be ALL or ANY";
			}
			anyMode = m.equals("ANY");
		}
		if (points != null && points < 0)
		{
			return where + ": points must not be negative";
		}
		if (icon instanceof Number)
		{
			iconItemId = ((Number) icon).intValue();
		}
		else if (icon instanceof String)
		{
			String s = ((String) icon).trim();
			if (!s.isEmpty())
			{
				try
				{
					iconItemId = Integer.parseInt(s);
				}
				catch (NumberFormatException e)
				{
					iconName = s;
				}
			}
		}
		if (goals == null || goals.isEmpty())
		{
			// A tile without goals is a manual tile.
			goals = new ArrayList<>();
			BingoGoal manual = new BingoGoal();
			manual.type = "MANUAL";
			goals.add(manual);
		}
		for (int g = 0; g < goals.size(); g++)
		{
			BingoGoal goal = goals.get(g);
			if (goal == null)
			{
				return where + ", goal " + (g + 1) + ": empty goal";
			}
			String err = goal.validate();
			if (err != null)
			{
				return where + " (\"" + label + "\"), goal " + (g + 1) + ": " + err;
			}
		}
		return null;
	}

	int pointsValue()
	{
		return points == null || points < 0 ? 0 : points;
	}

	boolean isComplete(TileProgress progress)
	{
		if (progress.manual)
		{
			return true;
		}
		boolean sawManual = false;
		for (int i = 0; i < goals.size(); i++)
		{
			BingoGoal goal = goals.get(i);
			if (goal.goalType == GoalType.MANUAL)
			{
				sawManual = true;
				continue;
			}
			boolean done = goal.isComplete(progress.goal(i, goals.size()));
			if (anyMode && done)
			{
				return true;
			}
			if (!anyMode && !done)
			{
				return false;
			}
		}
		// ALL mode: complete unless a MANUAL goal is present (those require the manual tick).
		// ANY mode: nothing matched.
		return !anyMode && !sawManual;
	}
}

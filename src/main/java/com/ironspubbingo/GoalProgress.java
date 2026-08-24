package com.ironspubbingo;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * Saved progress for one goal. Serialized to profile config as part of {@link TileProgress}.
 */
public class GoalProgress
{
	/** Generic counter: drops received, purples, kills, pets, chat matches, or XP gained. */
	long n;
	/** Distinct item names received (lowercase), for distinct DROP goals. */
	Set<String> matched;
	/** XP goals: last XP seen for the skill; gains between sightings are accumulated into n. */
	Long baseline;
	/**
	 * KC goals: per boss (lowercase), [0] the kill count baselined at first sighting after
	 * board import and [1] the latest reported count, so n = sum of (latest - baseline).
	 */
	Map<String, long[]> kc;

	Set<String> matchedSet()
	{
		if (matched == null)
		{
			matched = new HashSet<>();
		}
		return matched;
	}

	/**
	 * Records a distinct item/pet name, keeping the game's own capitalisation for display.
	 * Names are compared case-insensitively so a teammate (or older saved progress, which
	 * stored lowercase) can't make the same item count twice.
	 *
	 * @return whether the name was new
	 */
	boolean addName(String name)
	{
		Set<String> names = matchedSet();
		String existing = null;
		for (String candidate : names)
		{
			if (candidate.equalsIgnoreCase(name))
			{
				existing = candidate;
				break;
			}
		}
		if (existing == null)
		{
			names.add(name);
			return true;
		}
		// Upgrade a lowercase entry to the properly cased name.
		if (!existing.equals(name) && betterCased(name, existing))
		{
			names.remove(existing);
			names.add(name);
		}
		return false;
	}

	private static boolean betterCased(String candidate, String existing)
	{
		return !candidate.isEmpty() && Character.isUpperCase(candidate.charAt(0))
			&& (existing.isEmpty() || !Character.isUpperCase(existing.charAt(0)));
	}

	Map<String, long[]> kcMap()
	{
		if (kc == null)
		{
			kc = new HashMap<>();
		}
		return kc;
	}
}

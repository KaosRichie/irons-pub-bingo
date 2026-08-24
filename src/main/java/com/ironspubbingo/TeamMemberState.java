package com.ironspubbingo;

import java.util.HashMap;
import java.util.Map;

/**
 * Everything known about one team member's progress: display name and their tile shares.
 * Keyed by the member's account hash in the team cache, party messages and the team store,
 * so display name changes don't split a member's contribution.
 */
class TeamMemberState
{
	String name;
	Map<Integer, TileProgress> tiles;

	Map<Integer, TileProgress> tilesMap()
	{
		if (tiles == null)
		{
			tiles = new HashMap<>();
		}
		return tiles;
	}

	/**
	 * Applies incoming tile shares last-write-wins by the owner's timestamp.
	 *
	 * @return whether anything changed
	 */
	boolean apply(String newName, Map<Integer, TileProgress> incoming, int maxTiles)
	{
		boolean changed = false;
		if (newName != null && !newName.isEmpty() && !newName.equals(name))
		{
			name = newName;
			changed = true;
		}
		if (incoming == null)
		{
			return changed;
		}
		for (Map.Entry<Integer, TileProgress> entry : incoming.entrySet())
		{
			Integer tile = entry.getKey();
			TileProgress share = entry.getValue();
			if (tile == null || share == null || tile < 0 || tile >= maxTiles)
			{
				continue;
			}
			TileProgress current = tilesMap().get(tile);
			if (current == null || ts(share) > ts(current))
			{
				tilesMap().put(tile, share);
				changed = true;
			}
		}
		return changed;
	}

	private static long ts(TileProgress p)
	{
		return p.ts == null ? 0 : p.ts;
	}
}

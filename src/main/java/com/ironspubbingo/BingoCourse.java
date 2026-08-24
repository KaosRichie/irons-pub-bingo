package com.ironspubbingo;

import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import net.runelite.api.coords.WorldPoint;

/**
 * Agility courses whose laps can be counted: a lap completes when Agility XP lands while
 * the player stands on the course's end tile(s), with the course identified by map region —
 * the same detection RuneLite's own Agility plugin uses.
 *
 * Region ids and end tiles adapted from RuneLite's agility plugin Courses
 * (BSD-2, Copyright (c) 2018, Seth <http://github.com/sethtroll>).
 */
enum BingoCourse
{
	GNOME("Gnome Stronghold", 9781, point(2484, 3437, 0), point(2487, 3437, 0)),
	SHAYZIEN_BASIC("Shayzien Basic", 6200, point(1554, 3640, 0)),
	DRAYNOR("Draynor Village", 12338, point(3103, 3261, 0)),
	AL_KHARID("Al Kharid", 13105, point(3299, 3194, 0)),
	PYRAMID("Agility Pyramid", 13356, point(3364, 2830, 0)),
	VARROCK("Varrock", 12853, point(3236, 3417, 0)),
	PENGUIN("Penguin", 10559, point(2652, 4039, 1)),
	BARBARIAN("Barbarian Outpost", 10039, point(2543, 3553, 0)),
	CANIFIS("Canifis", 13878, point(3510, 3485, 0)),
	APE_ATOLL("Ape Atoll", 11050, point(2770, 2747, 0)),
	SHAYZIEN_ADVANCED("Shayzien Advanced", 5944, point(1522, 3625, 0)),
	FALADOR("Falador", 12084,
		point(3029, 3332, 0), point(3029, 3333, 0), point(3029, 3334, 0), point(3029, 3335, 0)),
	WILDERNESS("Wilderness", 11837,
		point(2993, 3933, 0), point(2994, 3933, 0), point(2995, 3933, 0)),
	WEREWOLF("Werewolf", 14234, point(3528, 9873, 0)),
	SEERS("Seers' Village", 10806, point(2704, 3464, 0)),
	POLLNIVNEACH("Pollnivneach", 13358, point(3363, 2998, 0)),
	RELLEKKA("Rellekka", 10553, point(2653, 3676, 0)),
	PRIFDDINAS("Prifddinas", 12895, point(3240, 6109, 0)),
	ARDOUGNE("Ardougne", 10547, point(2668, 3297, 0));

	private static final Map<Integer, BingoCourse> BY_REGION = new HashMap<>();
	private static final Map<String, BingoCourse> BY_NAME = new HashMap<>();

	private final String displayName;
	private final int regionId;
	private final WorldPoint[] endPoints;

	static
	{
		for (BingoCourse course : values())
		{
			BY_REGION.put(course.regionId, course);
			BY_NAME.put(normalize(course.name()), course);
			BY_NAME.put(normalize(course.displayName), course);
		}
		// Common spellings and shorthands hosts will type
		BY_NAME.put(normalize("Gnome"), GNOME);
		BY_NAME.put(normalize("Draynor"), DRAYNOR);
		BY_NAME.put(normalize("Seers"), SEERS);
		BY_NAME.put(normalize("Seers Village"), SEERS);
		BY_NAME.put(normalize("Relleka"), RELLEKKA);
		BY_NAME.put(normalize("Prif"), PRIFDDINAS);
		BY_NAME.put(normalize("Barbarian"), BARBARIAN);
		BY_NAME.put(normalize("Pyramid"), PYRAMID);
	}

	BingoCourse(String displayName, int regionId, WorldPoint... endPoints)
	{
		this.displayName = displayName;
		this.regionId = regionId;
		this.endPoints = endPoints;
	}

	private static WorldPoint point(int x, int y, int plane)
	{
		return new WorldPoint(x, y, plane);
	}

	private static String normalize(String value)
	{
		return value.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]", "");
	}

	static BingoCourse fromName(String name)
	{
		return name == null ? null : BY_NAME.get(normalize(name));
	}

	static BingoCourse forRegion(int regionId)
	{
		return BY_REGION.get(regionId);
	}

	boolean isEndPoint(WorldPoint location)
	{
		for (WorldPoint end : endPoints)
		{
			if (end.equals(location))
			{
				return true;
			}
		}
		return false;
	}

	String getDisplayName()
	{
		return displayName;
	}
}

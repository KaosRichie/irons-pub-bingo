package com.ironspubbingo;

import com.google.common.collect.ImmutableSet;
import java.util.Locale;
import java.util.Set;

/**
 * The three raids and their unique ("purple") drop tables, used to detect purples
 * from loot tracker events for the raid reward chests.
 */
public enum Raid
{
	COX("chambers of xeric", ImmutableSet.of(
		"twisted bow",
		"elder maul",
		"kodai insignia",
		"dragon claws",
		"ancestral hat",
		"ancestral robe top",
		"ancestral robe bottom",
		"dinh's bulwark",
		"dexterous prayer scroll",
		"arcane prayer scroll",
		"dragon hunter crossbow",
		"twisted buckler"
	)),
	TOB("theatre of blood", ImmutableSet.of(
		"scythe of vitur",
		"ghrazi rapier",
		"sanguinesti staff",
		"justiciar faceguard",
		"justiciar chestguard",
		"justiciar legguards",
		"avernic defender hilt"
	)),
	TOA("tombs of amascut", ImmutableSet.of(
		"tumeken's shadow",
		"elidinis' ward",
		"masori mask",
		"masori body",
		"masori chaps",
		"lightbearer",
		"osmumten's fang"
	));

	private final String lootSourcePrefix;
	private final Set<String> uniques;

	Raid(String lootSourcePrefix, Set<String> uniques)
	{
		this.lootSourcePrefix = lootSourcePrefix;
		this.uniques = uniques;
	}

	/**
	 * Maps a loot tracker event source name (e.g. "Chambers of Xeric: Challenge Mode")
	 * to the raid it belongs to, or null if the source is not a raid chest.
	 */
	static Raid fromLootSource(String source)
	{
		if (source == null)
		{
			return null;
		}
		String s = source.toLowerCase(Locale.ROOT);
		for (Raid raid : values())
		{
			if (s.startsWith(raid.lootSourcePrefix))
			{
				return raid;
			}
		}
		return null;
	}

	/**
	 * Whether the given item name is one of this raid's uniques. Matched by prefix so
	 * charge variants like "Scythe of vitur (uncharged)" also count.
	 */
	boolean isUnique(String itemName)
	{
		String name = itemName.toLowerCase(Locale.ROOT);
		for (String unique : uniques)
		{
			if (name.startsWith(unique))
			{
				return true;
			}
		}
		return false;
	}
}

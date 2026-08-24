package com.ironspubbingo;

import java.util.ArrayList;
import java.util.EnumSet;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;
import net.runelite.api.Skill;

/**
 * One trackable condition inside a bingo tile, deserialized from the board JSON.
 * Which fields are relevant depends on {@link #type}; see the README for the schema.
 */
public class BingoGoal
{
	// -- deserialized from board JSON --
	/** Goal type name, case-insensitive; see {@link GoalType}. */
	String type;
	/** Optional label shown on the goal's progress bar instead of the generated one. */
	String name;
	/** DROP: item name globs to match. Empty/omitted = any item (rarely useful). */
	List<String> items;
	/** DROP/VALUE: loot source name globs (NPC or event name). Empty/omitted = any source. */
	List<String> sources;
	/** Target count (drops, purples, kills, pets, chat matches, qualifying value drops). Default 1. */
	Integer count;
	/** DROP: when true, each distinct item name counts once ("5 unique GWD drops"). */
	Boolean distinct;
	/** RAID_PURPLE: which raids count (COX/TOB/TOA). Empty/omitted = all three. */
	List<String> raids;
	/** KC: boss name globs matched against kill count chat messages. */
	List<String> npcs;
	/** PET: specific pet item name globs, matched via collection log messages. Empty/omitted = any pet. */
	List<String> pets;
	/** XP: skill name, e.g. "SLAYER". */
	String skill;
	/** LAP: agility course name, e.g. "Canifis". */
	String course;
	/** XP: experience to gain. VALUE: minimum GE value of a single loot pile, in gp. */
	Long amount;
	/** CHAT: regex matched against game messages. */
	String pattern;

	// -- resolved during validation --
	transient GoalType goalType;
	transient List<Pattern> itemPatterns;
	transient List<Pattern> sourcePatterns;
	transient List<Pattern> npcPatterns;
	transient List<Pattern> petPatterns;
	transient Pattern chatPattern;
	transient EnumSet<Raid> raidSet;
	transient Skill skillEnum;
	transient BingoCourse courseEnum;

	/**
	 * Resolves string fields into their typed forms.
	 *
	 * @return an error message, or null if the goal is valid
	 */
	String validate()
	{
		if (type == null || type.trim().isEmpty())
		{
			return "missing goal type";
		}
		try
		{
			goalType = GoalType.valueOf(type.trim().toUpperCase(Locale.ROOT));
		}
		catch (IllegalArgumentException e)
		{
			return "unknown goal type '" + type + "'";
		}

		itemPatterns = Wildcards.compileAll(items);
		sourcePatterns = Wildcards.compileAll(sources);
		npcPatterns = Wildcards.compileAll(npcs);
		petPatterns = Wildcards.compileAll(pets);

		switch (goalType)
		{
			case DROP:
				if (itemPatterns.isEmpty())
				{
					return "DROP goal needs at least one entry in 'items'";
				}
				break;
			case KC:
				if (npcPatterns.isEmpty())
				{
					return "KC goal needs at least one entry in 'npcs'";
				}
				break;
			case KILL:
				if (npcPatterns.isEmpty())
				{
					return "KILL goal needs at least one entry in 'npcs'";
				}
				break;
			case RAID_PURPLE:
				raidSet = EnumSet.noneOf(Raid.class);
				if (raids == null || raids.isEmpty())
				{
					raidSet = EnumSet.allOf(Raid.class);
				}
				else
				{
					for (String r : raids)
					{
						try
						{
							raidSet.add(Raid.valueOf(r.trim().toUpperCase(Locale.ROOT)));
						}
						catch (IllegalArgumentException e)
						{
							return "unknown raid '" + r + "' (use COX, TOB or TOA)";
						}
					}
				}
				break;
			case XP:
				if (skill == null)
				{
					return "XP goal needs a 'skill'";
				}
				try
				{
					skillEnum = Skill.valueOf(skill.trim().toUpperCase(Locale.ROOT));
				}
				catch (IllegalArgumentException e)
				{
					return "unknown skill '" + skill + "'";
				}
				if (amount == null || amount <= 0)
				{
					return "XP goal needs a positive 'amount'";
				}
				break;
			case VALUE:
				if (amount == null || amount <= 0)
				{
					return "VALUE goal needs a positive 'amount' (gp)";
				}
				break;
			case LAP:
				if (course == null || course.trim().isEmpty())
				{
					return "LAP goal needs a 'course'";
				}
				courseEnum = BingoCourse.fromName(course);
				if (courseEnum == null)
				{
					return "unknown agility course '" + course + "'";
				}
				break;
			case CHAT:
				if (pattern == null || pattern.trim().isEmpty())
				{
					return "CHAT goal needs a 'pattern'";
				}
				try
				{
					chatPattern = Pattern.compile(pattern, Pattern.CASE_INSENSITIVE);
				}
				catch (PatternSyntaxException e)
				{
					return "invalid regex in 'pattern': " + e.getDescription();
				}
				break;
			case PET:
			case MANUAL:
				break;
		}
		if (count != null && count <= 0)
		{
			return "'count' must be positive";
		}
		return null;
	}

	boolean isDistinct()
	{
		return distinct != null && distinct;
	}

	/** The value {@link GoalProgress} must reach for this goal to be complete. */
	long target()
	{
		if (goalType == GoalType.XP)
		{
			return amount;
		}
		if (goalType == GoalType.MANUAL)
		{
			return 1;
		}
		return count == null ? 1 : count;
	}

	/** Whether this goal counts distinct names via the matched set rather than the plain counter. */
	boolean usesMatchedSet()
	{
		return (goalType == GoalType.DROP && isDistinct())
			|| (goalType == GoalType.PET && !petPatterns.isEmpty());
	}

	long progressOf(GoalProgress p)
	{
		if (usesMatchedSet())
		{
			return p.matched == null ? 0 : p.matched.size();
		}
		return p.n;
	}

	boolean isComplete(GoalProgress p)
	{
		return goalType != GoalType.MANUAL && progressOf(p) >= target();
	}

	/** Longest goal label shown in full; longer ones compact and move detail behind the toggle. */
	private static final int MAX_LABEL_LENGTH = 46;

	/**
	 * Goal label for the panel. Short goals ("Drops: Egg") are shown in full; only long
	 * ones compact to a summary ("Distinct drops from Chicken") and move their item and
	 * source lists into the collapsible details box.
	 */
	String shortDescribe()
	{
		if (name != null && !name.trim().isEmpty())
		{
			return name.trim();
		}
		String full = describe();
		if (full.length() <= MAX_LABEL_LENGTH)
		{
			return full;
		}
		switch (goalType)
		{
			case DROP:
				return (isDistinct() ? "Distinct drops" : "Drops") + fromSources();
			case RAID_PURPLE:
				return "Raid purples (" + raidSet.toString().replaceAll("[\\[\\]]", "") + ")";
			case KC:
			case KILL:
				return npcs.size() == 1 ? "Kills: " + pretty(npcs.get(0)) : "Kills (" + npcs.size() + " targets)";
			case PET:
				return petPatterns.isEmpty() ? "Any pet"
					: pets.size() == 1 ? "Pet: " + pretty(pets.get(0)) : "Pets (" + pets.size() + ")";
			case XP:
				return skillEnum.getName() + " XP";
			case LAP:
				return courseEnum.getDisplayName() + " laps";
			case VALUE:
				return "Big drop" + fromSources();
			case CHAT:
				return "Game message";
			case MANUAL:
			default:
				return "Manual tile";
		}
	}

	/** Whether the full description says more than the label already shows. */
	boolean hasExtraDetail()
	{
		return !describe().equals(shortDescribe());
	}

	private String fromSources()
	{
		if (sources == null || sources.isEmpty())
		{
			return "";
		}
		return sources.size() == 1 ? " from " + pretty(sources.get(0)) : " from " + sources.size() + " sources";
	}

	/** Full human-readable description of the goal, for the details box and tooltips. */
	String describe()
	{
		switch (goalType)
		{
			case DROP:
				return (isDistinct() ? "Distinct drops: " : "Drops: ") + prettyJoin(items)
					+ (sources == null || sources.isEmpty() ? "" : " from " + prettyJoin(sources));
			case RAID_PURPLE:
				return "Raid purples (" + raidSet.toString().replaceAll("[\\[\\]]", "") + ")";
			case KC:
			case KILL:
				return "Kills: " + prettyJoin(npcs);
			case PET:
				return petPatterns.isEmpty() ? "Any pet" : "Pets: " + prettyJoin(pets);
			case XP:
				return String.format("%,d %s XP", amount, skillEnum.getName());
			case LAP:
				return courseEnum.getDisplayName() + " course laps";
			case VALUE:
				return String.format("Drop worth %,d+ gp", amount)
					+ (sources == null || sources.isEmpty() ? "" : " from " + prettyJoin(sources));
			case CHAT:
				String readable = readablePattern(pattern);
				return readable != null ? readable : "Game message";
			case MANUAL:
			default:
				return "Manual (tick off by hand)";
		}
	}

	/** Name globs read better without their wildcards: "3rd age*" -> "3rd age". */
	private static String pretty(String glob)
	{
		return glob.replace("*", " ").replaceAll("\\s+", " ").trim();
	}

	private static String prettyJoin(List<String> values)
	{
		List<String> cleaned = new ArrayList<>();
		for (String value : values)
		{
			String clean = pretty(value);
			if (!clean.isEmpty())
			{
				cleaned.add(clean);
			}
		}
		return String.join(", ", cleaned);
	}

	/**
	 * Turns a chat regex into something a player can read, by keeping its literal text and
	 * marking where the variable parts are: "You have completed [0-9,]+ elite Treasure
	 * Trails" becomes "You have completed ... elite Treasure Trails". Returns null when
	 * nothing readable is left.
	 */
	static String readablePattern(String regex)
	{
		String[] parts = regex.split("\\[[^\\]]*\\][*+?]?|\\([^)]*\\)[*+?]?|\\\\[a-zA-Z]|\\{\\d+(,\\d+)?\\}|[.*+?^$|]");
		List<String> literals = new ArrayList<>();
		for (String part : parts)
		{
			String cleaned = part.replaceAll("\\\\(.)", "$1")
				.replaceAll("\\s+", " ")
				.replaceAll("^[\\s:;,\\-]+|[\\s:;,\\-]+$", "");
			if (cleaned.length() >= 4)
			{
				literals.add(cleaned);
			}
		}
		return literals.isEmpty() ? null : String.join(" ... ", literals);
	}
}

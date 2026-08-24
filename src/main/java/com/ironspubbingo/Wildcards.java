package com.ironspubbingo;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/**
 * Case-insensitive glob matching for item/NPC names in board files.
 * "*" matches any run of characters, so "Ancient page*" matches "Ancient page 1".
 */
final class Wildcards
{
	private Wildcards()
	{
	}

	static Pattern compile(String glob)
	{
		String[] parts = glob.split("\\*", -1);
		StringBuilder sb = new StringBuilder();
		for (int i = 0; i < parts.length; i++)
		{
			if (i > 0)
			{
				sb.append(".*");
			}
			if (!parts[i].isEmpty())
			{
				sb.append(Pattern.quote(parts[i]));
			}
		}
		return Pattern.compile(sb.toString(), Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);
	}

	static List<Pattern> compileAll(List<String> globs)
	{
		List<Pattern> patterns = new ArrayList<>();
		if (globs != null)
		{
			for (String glob : globs)
			{
				if (glob != null && !glob.trim().isEmpty())
				{
					patterns.add(compile(glob.trim()));
				}
			}
		}
		return patterns;
	}

	/**
	 * True if any pattern fully matches the value. An empty pattern list matches everything,
	 * so omitting e.g. "sources" on a drop goal means "from anywhere".
	 */
	static boolean anyMatch(List<Pattern> patterns, String value)
	{
		if (patterns == null || patterns.isEmpty())
		{
			return true;
		}
		if (value == null)
		{
			return false;
		}
		for (Pattern p : patterns)
		{
			if (p.matcher(value).matches())
			{
				return true;
			}
		}
		return false;
	}
}

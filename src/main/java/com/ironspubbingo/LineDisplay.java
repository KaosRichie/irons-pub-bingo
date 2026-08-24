package com.ironspubbingo;

/**
 * How completed bingo lines are shown on the board.
 */
public enum LineDisplay
{
	LINES("Lines"),
	HIGHLIGHT("Highlight");

	private final String name;

	LineDisplay(String name)
	{
		this.name = name;
	}

	@Override
	public String toString()
	{
		return name;
	}
}

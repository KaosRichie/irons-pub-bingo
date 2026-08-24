package com.ironspubbingo;

/**
 * The kinds of automatically (or manually) trackable goals a bingo tile can contain.
 */
public enum GoalType
{
	/** Receive specific item drops, optionally restricted to certain sources. */
	DROP,
	/** Receive rare "purple" uniques from raids. */
	RAID_PURPLE,
	/** Gain kill count on bosses/activities that print kill count chat messages. */
	KC,
	/** Kill any NPC (including regular monsters): counts deaths of NPCs you damaged. */
	KILL,
	/** Receive pets (any pet, or specific ones via collection log messages). */
	PET,
	/** Gain a set amount of experience in a skill. */
	XP,
	/** Complete laps of a rooftop/agility course (detected like RuneLite's lap counter). */
	LAP,
	/** Receive a single drop/loot pile worth at least a set GE value. */
	VALUE,
	/** Match a game chat message against a regex (speed times, delve levels, quest completions, ...). */
	CHAT,
	/** Not automatically trackable; the player ticks the tile off by hand. */
	MANUAL,
}

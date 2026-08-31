package com.ironspubbingo;

import com.google.gson.Gson;
import com.google.gson.JsonSyntaxException;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeParseException;
import java.util.List;
import java.util.Locale;

/**
 * A bingo board, deserialized from the shareable board JSON.
 */
public class BingoBoard
{
	String name;
	/**
	 * Optional stable identifier. Boards sharing an id share progress and team sync, so a
	 * host can edit the board mid-event without resetting anyone — labels, icons, points,
	 * targets, even what a tile tracks — as long as tiles keep their position (edit in
	 * place, don't insert or reorder). Only a new id (or removing it) is a new board.
	 */
	String id;
	/** Optional board revision, shown next to the board name. */
	Integer version;
	/** Optional event start (ISO 8601, e.g. "2026-08-29T18:00Z"). Tracking only counts after it. */
	String start;
	/** Optional event end. Tracking stops counting once passed. */
	String end;
	/** Optional bonus points per completed bingo line (row, column or diagonal). */
	Integer linePoints;
	/** Whether the two diagonals count as bingo lines. Default true. */
	Boolean diagonals;
	/** Optional bonus points for completing the whole board. */
	Integer blackoutPoints;
	int size;
	List<BingoTile> tiles;

	transient String normalizedId;
	transient Instant startTime;
	transient Instant endTime;

	/**
	 * Parses and validates a board.
	 *
	 * @return the parsed board
	 * @throws IllegalArgumentException with a user-facing message when invalid
	 */
	static BingoBoard parse(Gson gson, String json)
	{
		BingoBoard board;
		try
		{
			board = gson.fromJson(json, BingoBoard.class);
		}
		catch (JsonSyntaxException e)
		{
			throw new IllegalArgumentException("Not valid JSON: " + e.getMessage());
		}
		if (board == null)
		{
			throw new IllegalArgumentException("Board is empty");
		}
		String err = board.validate();
		if (err != null)
		{
			throw new IllegalArgumentException(err);
		}
		return board;
	}

	private String validate()
	{
		if (name == null || name.trim().isEmpty())
		{
			name = "Irons Pub Bingo";
		}
		if (id != null && !id.trim().isEmpty())
		{
			String normalized = id.trim().toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9-_]", "");
			if (normalized.isEmpty())
			{
				return "Board id must contain letters, numbers, '-' or '_'";
			}
			if (normalized.length() > 40)
			{
				return "Board id is too long (max 40 characters)";
			}
			normalizedId = normalized;
		}
		if (version != null && version < 0)
		{
			return "'version' must not be negative";
		}
		if (start != null && !start.trim().isEmpty())
		{
			try
			{
				startTime = parseTime(start);
			}
			catch (DateTimeParseException e)
			{
				return "Could not read 'start' (" + start + ") - use e.g. 2026-08-29T18:00Z";
			}
		}
		if (end != null && !end.trim().isEmpty())
		{
			try
			{
				endTime = parseTime(end);
			}
			catch (DateTimeParseException e)
			{
				return "Could not read 'end' (" + end + ") - use e.g. 2026-09-07T20:00Z";
			}
		}
		if (startTime != null && endTime != null && !endTime.isAfter(startTime))
		{
			return "'end' must be after 'start'";
		}
		if (linePoints != null && linePoints < 0)
		{
			return "'linePoints' must not be negative";
		}
		if (blackoutPoints != null && blackoutPoints < 0)
		{
			return "'blackoutPoints' must not be negative";
		}
		if (size < 1 || size > 10)
		{
			return "Board size must be between 1 and 10 (got " + size + ")";
		}
		if (tiles == null || tiles.size() != size * size)
		{
			return "A " + size + "x" + size + " board needs exactly " + (size * size)
				+ " tiles (got " + (tiles == null ? 0 : tiles.size()) + ")";
		}
		for (int i = 0; i < tiles.size(); i++)
		{
			BingoTile tile = tiles.get(i);
			if (tile == null)
			{
				return "tile " + (i + 1) + ": empty tile";
			}
			String err = tile.validate(i);
			if (err != null)
			{
				return err;
			}
		}
		return null;
	}

	/**
	 * Accepts ISO 8601 instants leniently: "2026-08-29" (midnight UTC), "2026-08-29T18:00Z"
	 * (seconds optional, UTC assumed when no zone given) and explicit offsets.
	 */
	static Instant parseTime(String raw)
	{
		String v = raw.trim();
		if (v.matches("\\d{4}-\\d{2}-\\d{2}"))
		{
			return LocalDate.parse(v).atStartOfDay(ZoneOffset.UTC).toInstant();
		}
		if (v.matches(".*T\\d{2}:\\d{2}"))
		{
			v += ":00";
		}
		else if (v.matches(".*T\\d{2}:\\d{2}Z"))
		{
			v = v.substring(0, v.length() - 1) + ":00Z";
		}
		if (!v.endsWith("Z") && !v.matches(".*[+-]\\d{2}:?\\d{2}$"))
		{
			v += "Z";
		}
		try
		{
			return Instant.parse(v);
		}
		catch (DateTimeParseException e)
		{
			return OffsetDateTime.parse(v).toInstant();
		}
	}

	/**
	 * The key progress and team sync are stored under. Without an id, any edit at all is a
	 * new board. With one, the id IS the board: hosts may tune tiles mid-event without a
	 * reset. Tampering is not this key's job - the store rejects any client whose exact
	 * board code differs from the host's, and that gate is what keeps store events honest.
	 */
	String storageKey(Gson gson)
	{
		if (normalizedId == null)
		{
			return Integer.toHexString(gson.toJson(this).hashCode());
		}
		return identityKey();
	}

	/** The board's identity across revisions (its host-set id), or null when it has none. */
	String identityKey()
	{
		return normalizedId == null ? null : "id_" + normalizedId;
	}

	int linePointsValue()
	{
		return linePoints == null || linePoints < 0 ? 0 : linePoints;
	}

	int blackoutPointsValue()
	{
		return blackoutPoints == null || blackoutPoints < 0 ? 0 : blackoutPoints;
	}

	/** Rows + columns, plus both diagonals when they count. */
	int maxLines()
	{
		return 2 * size + (diagonalsCount() ? 2 : 0);
	}

	boolean diagonalsCount()
	{
		return diagonals == null || diagonals;
	}

	String getName()
	{
		return name;
	}

	int getSize()
	{
		return size;
	}

	List<BingoTile> getTiles()
	{
		return tiles;
	}
}

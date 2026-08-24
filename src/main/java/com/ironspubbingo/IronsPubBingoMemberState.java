package com.ironspubbingo;

import java.util.Map;
import net.runelite.client.party.messages.PartyMemberMessage;

/**
 * Party message carrying (a chunk of) one member's tile progress. Sent for the local
 * player's own changes, and also as a relay of cached teammate state when answering sync
 * requests — so progress spreads through any chain of online members (gossip). The
 * {@code member}/{@code name} fields identify the progress OWNER, not the sender; each
 * tile share carries the owner's own timestamp for last-write-wins merging.
 */
class IronsPubBingoMemberState extends PartyMemberMessage
{
	/** Board key, so members on a different or outdated board ignore the update. */
	String board;
	/** The sender's board revision, so members on an outdated revision can be told. */
	Integer boardVersion;
	/** Account hash of the member this progress belongs to. */
	String member;
	/** That member's display name, for the UI. */
	String name;
	Map<Integer, TileProgress> tiles;

	IronsPubBingoMemberState(String board, Integer boardVersion, String member, String name, Map<Integer, TileProgress> tiles)
	{
		this.board = board;
		this.boardVersion = boardVersion;
		this.member = member;
		this.name = name;
		this.tiles = tiles;
	}
}

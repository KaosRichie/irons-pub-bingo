package com.ironspubbingo;

import net.runelite.client.party.messages.PartyMemberMessage;

/**
 * Party message asking teammates to re-broadcast their progress (sent on joining the
 * team party and from the panel's "Sync team" button).
 */
class IronsPubBingoSyncRequest extends PartyMemberMessage
{
	String board;

	IronsPubBingoSyncRequest(String board)
	{
		this.board = board;
	}
}

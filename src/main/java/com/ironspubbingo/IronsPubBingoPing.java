package com.ironspubbingo;

import net.runelite.client.party.messages.PartyMemberMessage;

/**
 * Lightweight presence heartbeat, sent every couple of minutes. Liveness is judged by
 * when a session last spoke, so a dead websocket lingering on the party server (which
 * can never speak) drops out of the connected count instead of haunting it.
 */
class IronsPubBingoPing extends PartyMemberMessage
{
	String board;

	IronsPubBingoPing(String board)
	{
		this.board = board;
	}
}

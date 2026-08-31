package com.ironspubbingo;

import com.google.gson.Gson;
import com.google.gson.JsonSyntaxException;
import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.function.BiConsumer;
import javax.inject.Inject;
import javax.inject.Singleton;
import lombok.extern.slf4j.Slf4j;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.HttpUrl;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * Optional persistent team store (Layer 3 of team sync): POSTs everything this client
 * knows about the team to a host-configured URL and receives the server's merged view
 * back in the same call, so members whose play times never overlap still exchange
 * progress. The reference backend is a Google Apps Script the bingo host
 * deploys (see docs/apps-script-store.gs); any server honoring the same tiny contract
 * works. Opt-in: nothing is sent unless a URL is set and the toggle is enabled.
 */
@Slf4j
@Singleton
class BingoTeamStore
{
	private static final MediaType JSON = MediaType.parse("application/json; charset=utf-8");
	/**
	 * Generous timeout: an Apps Script deployment that has not been used for a while has to
	 * cold start, which regularly takes longer than the client's default timeouts.
	 */
	private static final long TIMEOUT_SECONDS = 30;

	@Inject
	private OkHttpClient okHttpClient;

	private OkHttpClient storeClient;

	@Inject
	private Gson gson;

	@Inject
	private IronsPubBingoConfig config;

	/** One host-defined team from the sheet's Teams tab. */
	static class TeamInfo
	{
		String code;
		String name;
		/** Display names signed up under this team on the client's board, for the picker. */
		List<String> members;
	}

	/** One team's score on the shared board, for the placement display. */
	static class Standing
	{
		String team;
		Integer points;
	}

	/** A member's plea for admin credit; lands on the sheet's Requests tab for review. */
	static class CreditRequest
	{
		String member;
		String player;
		int tile;       // 1-based, as shown on the Board tab
		Integer goal;   // 1-based, null for single-goal tiles
		Long add;
		boolean complete;
		String note;
		/** Link(s) to screenshot proof (Discord/Imgur), whitespace separated. */
		String links;
	}

	/** Wire format: request and response bodies are both this shape (unused fields null). */
	static class StorePayload
	{
		String board;
		Map<String, TeamMemberState> members;
		/** Board definition (labels, targets), so the store can render a readable view. */
		Object meta;
		/** Request: member ids to evict from this board scope (player left the team). */
		List<String> remove;
		/** Response: every id evicted from this board scope; clients must drop these. */
		List<String> removed;
		/** Response: the host-defined team list (empty/absent = host allows any code). */
		List<TeamInfo> teams;
		/** Request: only fetch the team list, no board data. */
		Boolean teamsOnly;
		/** Request: fetch the board code the host pasted on the sheet. */
		Boolean fetchBoard;
		/** Response to fetchBoard: the board code, ready for the normal import path. */
		String boardJson;
		/**
		 * Request: the sender's own member id. Clears any "left the team" tombstone for it
		 * in this scope, so someone who switches back to a team they left heals themselves —
		 * admin-added (hand-written) tombstones are not cleared by this.
		 */
		String rejoin;
		/** Request: a credit request for the admins' Requests tab. */
		CreditRequest request;
		/** Response: host-set seconds between store polls (Settings tab); 0/null = default. */
		Integer pollSeconds;
		/** Response: the store's generation, bumped whenever the host resets it. */
		Integer epoch;
		/** Request: this team's current total points, for the cross-team standings. */
		Integer teamPoints;
		/** Request: fingerprint of the sender's board code; must match the host's, if set. */
		String boardHash;
		/** Request: the sender's board version, so an outdated client is told to update. */
		Integer boardVersion;
		/** Response: every team's points on this board, sorted best first. */
		List<Standing> standings;
		/** Response: why the push was rejected (e.g. a team code the host didn't define). */
		String error;
		/** Response beside a "Board updated" rejection: the version the host pasted. */
		Integer newerVersion;

		StorePayload(String board, Map<String, TeamMemberState> members, Object meta)
		{
			this.board = board;
			this.members = members;
			this.meta = meta;
		}
	}

	/** The client's OkHttp instance with timeouts raised for cold starts. */
	private OkHttpClient client()
	{
		if (storeClient == null)
		{
			storeClient = okHttpClient.newBuilder()
				.connectTimeout(TIMEOUT_SECONDS, TimeUnit.SECONDS)
				.readTimeout(TIMEOUT_SECONDS, TimeUnit.SECONDS)
				.writeTimeout(TIMEOUT_SECONDS, TimeUnit.SECONDS)
				.callTimeout(TIMEOUT_SECONDS, TimeUnit.SECONDS)
				.build();
		}
		return storeClient;
	}

	boolean isConfigured()
	{
		return config.teamStoreEnabled() && hasUrl();
	}

	/** Whether a store URL is set, regardless of the sync toggle. */
	boolean hasUrl()
	{
		return HttpUrl.parse(config.teamSyncUrl().trim()) != null;
	}

	/**
	 * Pushes the given state and hands the server's reply to the callback. On success the
	 * payload carries the merged team view (plus the host's team list and evicted ids);
	 * on failure the payload is null (or, for a store-side rejection, carries the team
	 * list alongside the error). The callback runs on an OkHttp thread — hop to the
	 * client thread before touching plugin state.
	 */
	void sync(String board, Map<String, TeamMemberState> members, Object meta, String selfId,
		int teamPoints, String boardHash, Integer boardVersion, BiConsumer<StorePayload, String> callback)
	{
		StorePayload request = new StorePayload(board, members, meta);
		request.rejoin = selfId;
		request.teamPoints = teamPoints;
		request.boardHash = boardHash;
		request.boardVersion = boardVersion;
		post(request, (payload, error) ->
		{
			if (error != null || payload == null)
			{
				callback.accept(null, error != null ? error : "Unexpected reply");
			}
			else if (payload.error != null)
			{
				callback.accept(payload, payload.error);
			}
			else if (payload.members == null)
			{
				callback.accept(null, "Empty reply");
			}
			else if (!board.equals(payload.board))
			{
				log.debug("Store replied for board {} but we asked for {}", payload.board, board);
				callback.accept(null, "Mismatched reply");
			}
			else
			{
				callback.accept(payload, null);
			}
		});
	}

	/**
	 * Tells the store this member left the given board scope: their row is deleted and the
	 * id tombstoned so cached copies pushed by teammates can't bring it back. The caller
	 * persists and retries until {@code onSuccess} runs (on an OkHttp thread).
	 */
	void remove(String board, String memberId, Runnable onSuccess)
	{
		StorePayload payload = new StorePayload(board, java.util.Collections.emptyMap(), null);
		payload.remove = java.util.Collections.singletonList(memberId);
		// Requires only the URL, not the sync toggle: leaving a store team by turning the
		// toggle OFF must still deliver this one departure notice, or the old team would
		// keep counting the player. No other traffic happens while the toggle is off.
		post(payload, false, (reply, error) ->
		{
			if (error != null)
			{
				log.debug("Could not remove member from old team scope yet: {}", error);
			}
			else
			{
				onSuccess.run();
			}
		});
	}

	/** Files a credit request onto the admins' Requests tab. Callback gets (ok, error). */
	// The board fingerprint rides along: requests pass the store's tamper gate too.
	void submitRequest(String board, CreditRequest request, String boardHash, Integer boardVersion,
		BiConsumer<Boolean, String> callback)
	{
		StorePayload payload = new StorePayload(board, java.util.Collections.emptyMap(), null);
		payload.request = request;
		payload.boardHash = boardHash;
		payload.boardVersion = boardVersion;
		post(payload, (reply, error) ->
		{
			String problem = error != null ? error : reply != null ? reply.error : null;
			callback.accept(problem == null, problem);
		});
	}

	/** Fetches the board code the host pasted on the sheet. Callback gets (json, error). */
	void fetchBoard(BiConsumer<String, String> callback)
	{
		StorePayload payload = new StorePayload(null, null, null);
		payload.fetchBoard = true;
		post(payload, (reply, error) ->
		{
			String problem = error != null ? error : reply == null ? "Unexpected reply"
				: reply.error != null ? reply.error
				: reply.boardJson == null || reply.boardJson.isEmpty() ? "Unexpected reply" : null;
			callback.accept(problem == null ? reply.boardJson : null, problem);
		});
	}

	/** Fetches the host-defined team list (Teams tab); empty when the host defined none. */
	// The board key (nullable) scopes each team's member names to the client's board.
	void fetchTeams(String boardKey, BiConsumer<List<TeamInfo>, String> callback)
	{
		StorePayload payload = new StorePayload(boardKey, null, null);
		payload.teamsOnly = true;
		post(payload, (reply, error) ->
		{
			if (error != null || reply == null)
			{
				callback.accept(null, error != null ? error : "Unexpected reply");
			}
			else
			{
				callback.accept(reply.teams == null ? java.util.Collections.emptyList() : reply.teams, null);
			}
		});
	}

	private void post(StorePayload body, BiConsumer<StorePayload, String> callback)
	{
		post(body, true, callback);
	}

	private void post(StorePayload body, boolean requireEnabled, BiConsumer<StorePayload, String> callback)
	{
		HttpUrl url = HttpUrl.parse(config.teamSyncUrl().trim());
		if ((requireEnabled && !config.teamStoreEnabled()) || url == null)
		{
			// Always answer: callers track in-flight state and would otherwise wait forever
			// (e.g. the store was toggled off between their check and this call).
			callback.accept(null, "Store not configured");
			return;
		}
		Request request = new Request.Builder()
			.url(url)
			.post(RequestBody.create(JSON, gson.toJson(body)))
			.build();
		client().newCall(request).enqueue(new Callback()
		{
			@Override
			public void onFailure(Call call, IOException e)
			{
				log.debug("Team store request failed", e);
				callback.accept(null, "Unreachable");
			}

			@Override
			public void onResponse(Call call, Response response)
			{
				String body = null;
				try (ResponseBody responseBody = response.body())
				{
					if (!response.isSuccessful() || responseBody == null)
					{
						log.debug("Team store returned {}", response.code());
						callback.accept(null, "HTTP " + response.code());
						return;
					}
					body = responseBody.string();
					callback.accept(gson.fromJson(body, StorePayload.class), null);
				}
				catch (JsonSyntaxException e)
				{
					// Google answers with an HTML error page when the script throws
					// (a lock timeout, a bad deployment), which never parses as JSON.
					log.debug("Team store reply was not JSON: {}", body, e);
					callback.accept(null, "Error page - see the log");
				}
				catch (IOException e)
				{
					log.debug("Could not read team store reply", e);
					callback.accept(null, "Reply cut off");
				}
			}
		});
	}
}

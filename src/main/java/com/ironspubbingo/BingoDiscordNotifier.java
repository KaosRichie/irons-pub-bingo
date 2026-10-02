package com.ironspubbingo;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import java.awt.Image;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ScheduledExecutorService;
import javax.imageio.ImageIO;
import javax.inject.Inject;
import javax.inject.Singleton;
import lombok.extern.slf4j.Slf4j;
import net.runelite.api.Client;
import net.runelite.api.GameState;
import net.runelite.api.gameval.InterfaceID;
import net.runelite.api.widgets.Widget;
import net.runelite.client.callback.ClientThread;
import net.runelite.client.ui.DrawManager;
import net.runelite.client.util.ImageUtil;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.HttpUrl;
import okhttp3.MediaType;
import okhttp3.MultipartBody;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/**
 * Posts tile completions (message + screenshot) to a team's Discord webhook.
 * Opt-in via config; nothing is sent unless a webhook URL is set and the toggle is on.
 */
@Slf4j
@Singleton
class BingoDiscordNotifier
{
	private static final MediaType PNG = MediaType.parse("image/png");

	@Inject
	private OkHttpClient okHttpClient;

	@Inject
	private Gson gson;

	@Inject
	private DrawManager drawManager;

	@Inject
	private Client client;

	@Inject
	private ClientThread clientThread;

	@Inject
	private ScheduledExecutorService executor;

	@Inject
	private IronsPubBingoConfig config;

	/** Supplies a note when this client runs an outdated board, else null. Client thread. */
	private volatile java.util.function.Supplier<String> outdatedNote = () -> null;

	void setOutdatedNote(java.util.function.Supplier<String> note)
	{
		outdatedNote = note;
	}

	/** "\n:warning: Sent from an outdated board (v1, v2 is out)", or "" when current. */
	private String outdatedSuffix()
	{
		String note = outdatedNote.get();
		return note == null ? "" : "\n:warning: " + note;
	}

	/** Whether a webhook URL is set, so callers can offer webhook-backed features. */
	boolean webhookConfigured()
	{
		return HttpUrl.parse(config.webhookUrl().trim()) != null;
	}

	/**
	 * Posts one game screenshot to the webhook as proof for a credit request and hands
	 * back a link for the request's proof field. wait=true makes Discord return the
	 * created message, and the webhook's own metadata (a GET on its URL) gives the guild
	 * and channel, which turn the message id into a jump link. The jump link never
	 * expires; attachment CDN URLs do, so they are only the fallback.
	 * The callback gets (link, error) on an arbitrary thread.
	 */
	void postProofScreenshot(String player, String requestDetail, String team,
		java.util.function.BiConsumer<String, String> rawCallback)
	{
		// Exactly one answer, whatever happens: the request dialog waits on it. A client
		// that stops drawing frames (minimized) or a Discord reply that never parses
		// would otherwise leave the request unsent for the rest of the session.
		java.util.concurrent.atomic.AtomicBoolean answered = new java.util.concurrent.atomic.AtomicBoolean();
		java.util.function.BiConsumer<String, String> callback = (link, error) ->
		{
			if (answered.compareAndSet(false, true))
			{
				rawCallback.accept(link, error);
			}
		};
		executor.schedule(() -> callback.accept(null, "Screenshot timed out"), 60, java.util.concurrent.TimeUnit.SECONDS);
		HttpUrl url = HttpUrl.parse(config.webhookUrl().trim());
		if (url == null)
		{
			callback.accept(null, "No Discord webhook set");
			return;
		}
		String content = ":camera_with_flash: **" + (player == null ? "Someone" : player)
			+ "** - credit request proof: " + requestDetail + teamSuffix(team) + outdatedSuffix();
		captureFrame(frame ->
		{
			Map<String, Object> payload = new HashMap<>();
			payload.put("content", content);
			MultipartBody.Builder body = new MultipartBody.Builder()
				.setType(MultipartBody.FORM)
				.addFormDataPart("payload_json", gson.toJson(payload));
			byte[] png = toPng(frame);
			if (png == null)
			{
				callback.accept(null, "Could not capture the screenshot");
				return;
			}
			body.addFormDataPart("files[0]", "proof.png", RequestBody.create(PNG, png));
			Request post = new Request.Builder()
				.url(url.newBuilder().setQueryParameter("wait", "true").build())
				.post(body.build())
				.build();
			okHttpClient.newCall(post).enqueue(new Callback()
			{
				@Override
				public void onFailure(Call call, IOException e)
				{
					callback.accept(null, "Discord unreachable: " + e.getMessage());
				}

				@Override
				public void onResponse(Call call, Response response) throws IOException
				{
					try (Response r = response)
					{
						if (!r.isSuccessful() || r.body() == null)
						{
							callback.accept(null, "Discord webhook returned " + r.code());
							return;
						}
						JsonObject message;
						try
						{
							message = gson.fromJson(r.body().string(), JsonObject.class);
						}
						catch (RuntimeException e)
						{
							message = null;
						}
						if (message == null)
						{
							callback.accept(null, "Discord sent an unreadable reply");
							return;
						}
						resolveMessageLink(url, message, callback);
					}
				}
			});
		});
	}

	/**
	 * Grabs a rendered frame for a screenshot, but not the very next one. One game tick
	 * later the "Bingo tile complete" line is in the chatbox and the loot is in the
	 * inventory, so the picture shows what it is proof of. And after a login the
	 * welcome screen is skipped: XP caught up from mobile completes tiles the moment the
	 * client logs in, when the next frame is the "Welcome to Gielinor" banner. Both
	 * checks retry frame by frame for as long as the player is in the game. If they log
	 * out first there is nothing to photograph, and the post goes out without a picture.
	 */
	private void captureFrame(java.util.function.Consumer<Image> onFrame)
	{
		int[] startTick = {-1};
		clientThread.invokeLater(() ->
		{
			if (client.getGameState() != GameState.LOGGED_IN)
			{
				executor.execute(() -> onFrame.accept(null));
				return true;
			}
			if (startTick[0] < 0)
			{
				startTick[0] = client.getTickCount();
			}
			Widget play = client.getWidget(InterfaceID.WelcomeScreen.PLAY);
			boolean welcomeUp = play != null && !play.isHidden();
			boolean tickPassed = client.getTickCount() > startTick[0];
			if (welcomeUp || !tickPassed)
			{
				return false; // try again next frame
			}
			drawManager.requestNextFrameListener(frame -> executor.execute(() -> onFrame.accept(frame)));
			return true;
		});
	}

	/** Turns the webhook's reply into a permanent jump link, or the attachment URL. */
	private void resolveMessageLink(HttpUrl webhook, JsonObject message,
		java.util.function.BiConsumer<String, String> callback)
	{
		String messageId = message.has("id") ? message.get("id").getAsString() : null;
		String channelId = message.has("channel_id") ? message.get("channel_id").getAsString() : null;
		String attachmentUrl = null;
		if (message.has("attachments") && message.getAsJsonArray("attachments").size() > 0)
		{
			JsonObject attachment = message.getAsJsonArray("attachments").get(0).getAsJsonObject();
			attachmentUrl = attachment.has("url") ? attachment.get("url").getAsString() : null;
		}
		final String fallback = attachmentUrl;
		if (messageId == null || channelId == null)
		{
			finishWithLink(fallback, callback);
			return;
		}
		okHttpClient.newCall(new Request.Builder().url(webhook).get().build()).enqueue(new Callback()
		{
			@Override
			public void onFailure(Call call, IOException e)
			{
				finishWithLink(fallback, callback);
			}

			@Override
			public void onResponse(Call call, Response response) throws IOException
			{
				try (Response r = response)
				{
					String guildId = null;
					if (r.isSuccessful() && r.body() != null)
					{
						try
						{
							JsonObject info = gson.fromJson(r.body().string(), JsonObject.class);
							guildId = info != null && info.has("guild_id") ? info.get("guild_id").getAsString() : null;
						}
						catch (RuntimeException e)
						{
							guildId = null; // fall back to the attachment link
						}
					}
					finishWithLink(guildId == null ? fallback
						: "https://discord.com/channels/" + guildId + "/" + channelId + "/" + messageId, callback);
				}
			}
		});
	}

	private static void finishWithLink(String link, java.util.function.BiConsumer<String, String> callback)
	{
		if (link == null)
		{
			callback.accept(null, "Screenshot posted, but Discord gave no usable link");
		}
		else
		{
			callback.accept(link, null);
		}
	}

	/**
	 * Posts progress on a goal the host flagged with "screenshot": proof lands in Discord
	 * as it happens instead of one screenshot at tile completion. Rides the completion
	 * toggle and webhook - nothing extra to configure.
	 */
	// lootDetail: the drop that made this progress ("Uncut onyx from Zulrah"), or null.
	void postGoalProgress(String player, String tileLabel, String goalLabel, long progress, long target,
		String lootDetail, String team)
	{
		if (!config.postCompletions())
		{
			return;
		}
		HttpUrl url = HttpUrl.parse(config.webhookUrl().trim());
		if (url == null)
		{
			return;
		}
		String message = ":camera_with_flash: **" + (player == null ? "Someone" : player)
			+ "** - " + tileLabel + ": " + goalLabel
			+ " (" + progress + '/' + target + ')' + teamSuffix(team)
			+ (lootDetail == null ? "" : "\n:package: " + lootDetail) + outdatedSuffix();
		captureFrame(frame -> post(url, message, frame));
	}

	/** lootDetail: the drop (or valued loot pile) that finished the tile, or null. */
	void postCompletion(String player, String boardName, List<String> tileLabels, int completed, int total,
		String bonus, String lootDetail, String team)
	{
		if (!config.postCompletions())
		{
			return;
		}
		HttpUrl url = HttpUrl.parse(config.webhookUrl().trim());
		if (url == null)
		{
			return;
		}

		StringBuilder content = new StringBuilder();
		content.append(":tada: **").append(player == null ? "Someone" : player).append("** completed **")
			.append(String.join("**, **", tileLabels)).append("**").append(teamSuffix(team));
		content.append(" — ").append(boardName).append(" (").append(completed).append('/').append(total).append(" tiles)");
		if (lootDetail != null)
		{
			content.append("\n:package: ").append(lootDetail);
		}
		if (bonus != null)
		{
			content.append("\n:sparkles: ").append(bonus);
		}
		String message = content.append(outdatedSuffix()).toString();

		// Grab a rendered frame as proof, then build and send the request off the client thread.
		captureFrame(frame -> post(url, message, frame));
	}

	/** " for team **X**"; the caller resolves the display name (sheet > config > code). */
	private static String teamSuffix(String team)
	{
		return team == null || team.trim().isEmpty() ? "" : " for team **" + team.trim() + "**";
	}

	private void post(HttpUrl url, String message, Image frame)
	{
		Map<String, Object> payload = new HashMap<>();
		payload.put("content", message);

		MultipartBody.Builder body = new MultipartBody.Builder()
			.setType(MultipartBody.FORM)
			.addFormDataPart("payload_json", gson.toJson(payload));

		byte[] png = toPng(frame);
		if (png != null)
		{
			body.addFormDataPart("files[0]", "bingo.png", RequestBody.create(PNG, png));
		}

		Request request = new Request.Builder()
			.url(url)
			.post(body.build())
			.build();
		okHttpClient.newCall(request).enqueue(new Callback()
		{
			@Override
			public void onFailure(Call call, IOException e)
			{
				log.warn("Could not post bingo completion to Discord", e);
			}

			@Override
			public void onResponse(Call call, Response response)
			{
				if (!response.isSuccessful())
				{
					log.warn("Discord webhook returned {}", response.code());
				}
				response.close();
			}
		});
	}

	/** null when there was no frame to capture (the player had logged out). */
	private static byte[] toPng(Image frame)
	{
		if (frame == null)
		{
			return null;
		}
		try
		{
			BufferedImage image = ImageUtil.bufferedImageFromImage(frame);
			ByteArrayOutputStream out = new ByteArrayOutputStream();
			ImageIO.write(image, "png", out);
			return out.toByteArray();
		}
		catch (IOException e)
		{
			log.warn("Could not encode bingo screenshot", e);
			return null;
		}
	}
}

package com.ironspubbingo;

import com.google.gson.Gson;
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
	private ScheduledExecutorService executor;

	@Inject
	private IronsPubBingoConfig config;

	/**
	 * Posts progress on a goal the host flagged with "screenshot": proof lands in Discord
	 * as it happens instead of one screenshot at tile completion. Rides the completion
	 * toggle and webhook - nothing extra to configure.
	 */
	void postGoalProgress(String player, String tileLabel, String goalLabel, long progress, long target)
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
		content.append(":camera_with_flash: **").append(player == null ? "Someone" : player)
			.append("** - ").append(tileLabel).append(": ").append(goalLabel)
			.append(" (").append(progress).append('/').append(target).append(')');
		String team = config.teamName().trim();
		if (!team.isEmpty())
		{
			content.append(" for team **").append(team).append("**");
		}
		String message = content.toString();
		drawManager.requestNextFrameListener(frame -> executor.execute(() -> post(url, message, frame)));
	}

	/** lootDetail: the drop (or valued loot pile) that finished the tile, or null. */
	void postCompletion(String player, String boardName, List<String> tileLabels, int completed, int total,
		String bonus, String lootDetail)
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
			.append(String.join("**, **", tileLabels)).append("**");
		String team = config.teamName().trim();
		if (!team.isEmpty())
		{
			content.append(" for team **").append(team).append("**");
		}
		content.append(" — ").append(boardName).append(" (").append(completed).append('/').append(total).append(" tiles)");
		if (lootDetail != null)
		{
			content.append("\n:package: ").append(lootDetail);
		}
		if (bonus != null)
		{
			content.append("\n:sparkles: ").append(bonus);
		}
		String message = content.toString();

		// Grab the next rendered frame as proof, then build and send the request off the client thread.
		drawManager.requestNextFrameListener(frame -> executor.execute(() -> post(url, message, frame)));
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

	private static byte[] toPng(Image frame)
	{
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

package com.ironspubbingo;

import java.awt.Color;
import java.awt.Dimension;
import java.awt.Graphics2D;
import javax.inject.Inject;
import net.runelite.client.ui.ColorScheme;
import net.runelite.client.ui.overlay.OverlayPanel;
import net.runelite.client.ui.overlay.OverlayPosition;
import net.runelite.client.ui.overlay.components.LineComponent;
import net.runelite.client.ui.overlay.components.TitleComponent;

/**
 * The in-game status box: a newer board, sync problems and the event countdown, each
 * with its own setting. It hides when there is nothing to say.
 */
class BingoStatusOverlay extends OverlayPanel
{
	private static final Color WARNING = new Color(255, 152, 31);

	private final IronsPubBingoPlugin plugin;
	private final IronsPubBingoConfig config;

	@Inject
	BingoStatusOverlay(IronsPubBingoPlugin plugin, IronsPubBingoConfig config)
	{
		super(plugin);
		this.plugin = plugin;
		this.config = config;
		setPosition(OverlayPosition.TOP_CENTER);
	}

	@Override
	public Dimension render(Graphics2D graphics)
	{
		String update = config.boardUpdateOverlay() ? plugin.boardUpdateNotice(false) : null;
		String store = config.overlayStoreWarning() ? plugin.storeOverlayWarning() : null;
		String live = config.overlayLiveSyncWarning() ? plugin.liveSyncOverlayWarning() : null;
		String countdown = config.overlayCountdown() ? plugin.eventCountdownOverlayText() : null;
		if (update == null && store == null && live == null && countdown == null)
		{
			return null;
		}
		panelComponent.setPreferredSize(new Dimension(230, 0));
		panelComponent.getChildren().add(TitleComponent.builder()
			.text("Irons Pub Bingo")
			.color(ColorScheme.BRAND_ORANGE)
			.build());
		if (countdown != null)
		{
			panelComponent.getChildren().add(LineComponent.builder().left(countdown).build());
		}
		if (update != null)
		{
			panelComponent.getChildren().add(LineComponent.builder().left(update).build());
		}
		if (store != null)
		{
			panelComponent.getChildren().add(LineComponent.builder()
				.left("Store: " + store).leftColor(WARNING).build());
		}
		if (live != null)
		{
			panelComponent.getChildren().add(LineComponent.builder()
				.left("Live sync: " + live).leftColor(WARNING).build());
		}
		return super.render(graphics);
	}
}

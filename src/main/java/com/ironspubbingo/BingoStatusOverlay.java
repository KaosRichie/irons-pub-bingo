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
 * The in-game status box: sync problems and the event countdown, each
 * with its own setting. It hides when there is nothing to say.
 */
class BingoStatusOverlay extends OverlayPanel
{
	private static final Color PROBLEM = new Color(255, 70, 70);

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
		String store = config.overlayStoreWarning() ? plugin.storeOverlayWarning() : null;
		String live = config.overlayLiveSyncWarning() ? plugin.liveSyncOverlayWarning() : null;
		String countdown = config.overlayCountdown() ? plugin.eventCountdownOverlayText() : null;
		if (store == null && live == null && countdown == null)
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
		if (store != null)
		{
			addProblem("Store: " + store);
		}
		if (live != null)
		{
			addProblem("Live sync: " + live);
		}
		return super.render(graphics);
	}

	/**
	 * A problem in red. What to do about it ("use Import from store") follows the
	 * " - " in the text and stays white on its own line.
	 */
	private void addProblem(String text)
	{
		int cut = text.indexOf(" - ");
		String problem = cut < 0 ? text : text.substring(0, cut);
		panelComponent.getChildren().add(LineComponent.builder().left(problem).leftColor(PROBLEM).build());
		if (cut >= 0)
		{
			String fix = text.substring(cut + 3);
			panelComponent.getChildren().add(LineComponent.builder()
				.left(Character.toUpperCase(fix.charAt(0)) + fix.substring(1)).build());
		}
	}
}

package com.ironspubbingo;

import java.awt.Dimension;
import java.awt.Graphics2D;
import javax.inject.Inject;
import net.runelite.client.ui.ColorScheme;
import net.runelite.client.ui.overlay.OverlayPanel;
import net.runelite.client.ui.overlay.OverlayPosition;
import net.runelite.client.ui.overlay.components.LineComponent;
import net.runelite.client.ui.overlay.components.TitleComponent;

/**
 * Tells the player in game that a newer board is out, so nobody plays a whole session
 * on an old board without opening the sidebar. Same text as the panel's notice.
 */
class BingoBoardUpdateOverlay extends OverlayPanel
{
	private final IronsPubBingoPlugin plugin;
	private final IronsPubBingoConfig config;

	@Inject
	BingoBoardUpdateOverlay(IronsPubBingoPlugin plugin, IronsPubBingoConfig config)
	{
		super(plugin);
		this.plugin = plugin;
		this.config = config;
		setPosition(OverlayPosition.TOP_CENTER);
	}

	@Override
	public Dimension render(Graphics2D graphics)
	{
		String notice = config.boardUpdateOverlay() ? plugin.boardUpdateNotice() : null;
		if (notice == null)
		{
			return null;
		}
		panelComponent.setPreferredSize(new Dimension(230, 0));
		panelComponent.getChildren().add(TitleComponent.builder()
			.text("Irons Pub Bingo")
			.color(ColorScheme.BRAND_ORANGE)
			.build());
		panelComponent.getChildren().add(LineComponent.builder().left(notice).build());
		return super.render(graphics);
	}
}

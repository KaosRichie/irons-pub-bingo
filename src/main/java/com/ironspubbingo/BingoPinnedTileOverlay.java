package com.ironspubbingo;

import java.awt.Color;
import java.awt.Dimension;
import java.awt.FontMetrics;
import java.awt.Graphics2D;
import java.awt.Point;
import java.awt.Rectangle;
import java.util.List;
import javax.inject.Inject;
import net.runelite.client.ui.ColorScheme;
import net.runelite.client.ui.overlay.OverlayPanel;
import net.runelite.client.ui.overlay.OverlayPosition;
import net.runelite.client.ui.overlay.components.LayoutableRenderableEntity;
import net.runelite.client.ui.overlay.components.LineComponent;
import net.runelite.client.ui.overlay.components.ProgressBarComponent;
import net.runelite.client.ui.overlay.components.TitleComponent;

/**
 * The tiles a player pinned from the board (right-click a tile), with a bar per goal,
 * so progress shows without opening the sidebar.
 */
class BingoPinnedTileOverlay extends OverlayPanel
{
	private static final int WIDTH = 200;
	/** The panel's border leaves this much room for text. */
	private static final int TEXT_WIDTH = WIDTH - 10;
	private static final Color BAR_BACKGROUND = new Color(54, 40, 26);
	private static final Color DIVIDER = new Color(90, 80, 68);

	private final IronsPubBingoPlugin plugin;
	private final IronsPubBingoConfig config;

	@Inject
	BingoPinnedTileOverlay(IronsPubBingoPlugin plugin, IronsPubBingoConfig config)
	{
		super(plugin);
		this.plugin = plugin;
		this.config = config;
		setPosition(OverlayPosition.TOP_LEFT);
	}

	@Override
	public Dimension render(Graphics2D graphics)
	{
		BingoBoard board = plugin.getBoard();
		List<Integer> pinned = config.overlayPinnedTiles() ? plugin.pinnedTiles() : null;
		if (board == null || pinned == null || pinned.isEmpty())
		{
			return null;
		}
		panelComponent.setPreferredSize(new Dimension(WIDTH, 0));
		// Room below each line, so a bar never covers the tails of letters like g and y.
		panelComponent.setGap(new Point(0, 3));
		FontMetrics metrics = graphics.getFontMetrics();
		boolean first = true;
		for (int index : pinned)
		{
			if (index < 0 || index >= board.getTiles().size())
			{
				continue;
			}
			if (!first)
			{
				panelComponent.getChildren().add(new Divider());
			}
			first = false;
			BingoTile tile = board.getTiles().get(index);
			TileProgress merged = plugin.mergedProgressFor(index);
			boolean complete = tile.isComplete(merged);
			panelComponent.getChildren().add(TitleComponent.builder()
				.text(fit(metrics, tile.label))
				.color(complete ? BingoUi.COLOR_GOAL_DONE : ColorScheme.BRAND_ORANGE)
				.build());
			for (int g = 0; g < tile.goals.size(); g++)
			{
				BingoGoal goal = tile.goals.get(g);
				GoalProgress p = merged.goal(g, tile.goals.size());
				long target = goal.goalType == GoalType.MANUAL ? 1 : goal.target();
				long value = merged.manual ? target
					: goal.goalType == GoalType.MANUAL ? 0
					// A goal's number never shows past its target, nor below zero.
					: Math.max(0, Math.min(goal.progressOf(p), target));
				boolean done = merged.manual || goal.isComplete(p);
				panelComponent.getChildren().add(LineComponent.builder()
					.left(fit(metrics, plugin.goalLabel(goal)))
					.leftColor(done ? BingoUi.COLOR_GOAL_DONE : Color.WHITE)
					.build());
				ProgressBarComponent bar = new ProgressBarComponent();
				bar.setMinimum(0);
				bar.setMaximum(Math.max(1, target));
				bar.setValue(value);
				bar.setLabelDisplayMode(ProgressBarComponent.LabelDisplayMode.FULL);
				bar.setForegroundColor(done ? BingoUi.COLOR_COMPLETE : BingoUi.COLOR_PARTIAL);
				bar.setBackgroundColor(BAR_BACKGROUND);
				panelComponent.getChildren().add(bar);
			}
		}
		return super.render(graphics);
	}

	/** Cuts text that would run past the box, ending it with "...". */
	private static String fit(FontMetrics metrics, String text)
	{
		if (text == null || metrics.stringWidth(text) <= TEXT_WIDTH)
		{
			return text;
		}
		int end = text.length();
		while (end > 0 && metrics.stringWidth(text.substring(0, end) + "...") > TEXT_WIDTH)
		{
			end--;
		}
		return text.substring(0, end).trim() + "...";
	}

	/** A thin line between two pinned tiles. */
	private static class Divider implements LayoutableRenderableEntity
	{
		private static final int HEIGHT = 7;
		private final Rectangle bounds = new Rectangle();
		private Point location = new Point();
		private Dimension size = new Dimension(TEXT_WIDTH, HEIGHT);

		@Override
		public Dimension render(Graphics2D graphics)
		{
			graphics.setColor(DIVIDER);
			int y = location.y + HEIGHT / 2;
			graphics.drawLine(location.x, y, location.x + size.width - 1, y);
			Dimension dimension = new Dimension(size.width, HEIGHT);
			bounds.setLocation(location);
			bounds.setSize(dimension);
			return dimension;
		}

		@Override
		public Rectangle getBounds()
		{
			return bounds;
		}

		@Override
		public void setPreferredLocation(Point position)
		{
			location = position;
		}

		@Override
		public void setPreferredSize(Dimension dimension)
		{
			if (dimension != null && dimension.width > 0)
			{
				size = new Dimension(dimension.width, HEIGHT);
			}
		}
	}
}

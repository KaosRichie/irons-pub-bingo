package com.ironspubbingo;

import java.awt.Color;
import java.awt.Dimension;
import java.awt.Graphics2D;
import java.util.List;
import javax.inject.Inject;
import net.runelite.client.ui.ColorScheme;
import net.runelite.client.ui.overlay.OverlayPanel;
import net.runelite.client.ui.overlay.OverlayPosition;
import net.runelite.client.ui.overlay.components.LineComponent;
import net.runelite.client.ui.overlay.components.ProgressBarComponent;
import net.runelite.client.ui.overlay.components.TitleComponent;

/**
 * The tiles a player pinned from the board (right-click a tile), with a bar per goal,
 * so progress shows without opening the sidebar.
 */
class BingoPinnedTileOverlay extends OverlayPanel
{
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
		panelComponent.setPreferredSize(new Dimension(200, 0));
		for (int index : pinned)
		{
			if (index < 0 || index >= board.getTiles().size())
			{
				continue;
			}
			BingoTile tile = board.getTiles().get(index);
			TileProgress merged = plugin.mergedProgressFor(index);
			boolean complete = tile.isComplete(merged);
			panelComponent.getChildren().add(TitleComponent.builder()
				.text(tile.label)
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
					.left(goal.shortDescribe())
					.leftColor(done ? BingoUi.COLOR_GOAL_DONE : Color.WHITE)
					.build());
				ProgressBarComponent bar = new ProgressBarComponent();
				bar.setMinimum(0);
				bar.setMaximum(Math.max(1, target));
				bar.setValue(value);
				bar.setLabelDisplayMode(ProgressBarComponent.LabelDisplayMode.FULL);
				bar.setForegroundColor(done ? BingoUi.COLOR_COMPLETE : BingoUi.COLOR_PARTIAL);
				panelComponent.getChildren().add(bar);
			}
		}
		return super.render(graphics);
	}
}

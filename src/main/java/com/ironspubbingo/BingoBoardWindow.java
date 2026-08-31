package com.ironspubbingo;

import java.awt.BorderLayout;
import java.awt.Color;
import java.awt.Cursor;
import java.awt.Dimension;
import java.awt.GridLayout;
import java.awt.event.ComponentAdapter;
import java.awt.event.ComponentEvent;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;
import java.util.ArrayList;
import java.util.List;
import javax.swing.BorderFactory;
import javax.swing.JFrame;
import javax.swing.JLabel;
import javax.swing.JPanel;
import javax.swing.JScrollPane;
import javax.swing.JSplitPane;
import javax.swing.SwingConstants;
import net.runelite.client.ui.ColorScheme;
import net.runelite.client.ui.FontManager;
import net.runelite.client.util.AsyncBufferedImage;
import net.runelite.client.util.ImageUtil;

/**
 * Resizable pop-out window with a large view of the bingo board — icons, full tile labels,
 * points and progress colors. Opened from the sidebar panel; clicking a tile selects it
 * there. Live-updates together with the panel.
 */
class BingoBoardWindow extends JFrame
{
	private final IronsPubBingoPlugin plugin;
	private final JLabel statusLabel = new JLabel();
	private final BingoGridPanel grid = new BingoGridPanel();
	private static final int DETAIL_WIDTH = 380;
	private final BingoTileDetail detail;
	private final JScrollPane detailScroll;
	private final JSplitPane split;
	private final List<BingoTileCell> cells = new ArrayList<>();
	private final List<JLabel> cellIcons = new ArrayList<>();
	private final List<BingoWrappedLabel> cellLabels = new ArrayList<>();
	private BingoBoard renderedBoard;
	private final javax.swing.Timer countdownTimer;

	BingoBoardWindow(IronsPubBingoPlugin plugin)
	{
		this.plugin = plugin;
		setTitle("Irons Pub Bingo");
		setIconImage(ImageUtil.loadImageResource(IronsPubBingoPlugin.class, "window_icon.png"));
		setDefaultCloseOperation(HIDE_ON_CLOSE);
		setSize(700, 780);
		setMinimumSize(new Dimension(420, 480));

		JPanel content = new JPanel(new BorderLayout(0, 8));
		content.setBorder(BorderFactory.createEmptyBorder(10, 10, 10, 10));
		content.setBackground(ColorScheme.DARK_GRAY_COLOR);

		statusLabel.setFont(FontManager.getRunescapeFont());
		statusLabel.setForeground(Color.WHITE);
		content.add(statusLabel, BorderLayout.NORTH);

		grid.setBackground(ColorScheme.DARK_GRAY_COLOR);
		grid.addComponentListener(new ComponentAdapter()
		{
			@Override
			public void componentResized(ComponentEvent e)
			{
				refresh(); // re-wrap tile labels to the new cell width
			}
		});
		// The same tile detail as the sidebar, under the board, for the selected tile.
		// It keeps the sidebar's fixed content width inside a centering holder - all its
		// wrap widths and bar labels are computed for that basis, and stretching it to
		// the window width breaks them. The split divider lets the player trade board
		// space against detail space instead of the detail claiming a fixed strip.
		detail = new BingoTileDetail(plugin, DETAIL_WIDTH);
		JPanel detailHolder = new JPanel(new java.awt.GridBagLayout());
		detailHolder.setBackground(ColorScheme.DARKER_GRAY_COLOR);
		detailHolder.setBorder(BorderFactory.createEmptyBorder(8, 8, 8, 8));
		java.awt.GridBagConstraints holderConstraints = new java.awt.GridBagConstraints();
		holderConstraints.anchor = java.awt.GridBagConstraints.NORTHWEST;
		holderConstraints.weightx = 1;
		holderConstraints.weighty = 1;
		detailHolder.add(detail, holderConstraints);
		detailScroll = new JScrollPane(detailHolder,
			JScrollPane.VERTICAL_SCROLLBAR_AS_NEEDED, JScrollPane.HORIZONTAL_SCROLLBAR_NEVER);
		detailScroll.setBorder(BorderFactory.createEmptyBorder());
		detailScroll.getViewport().setBackground(ColorScheme.DARKER_GRAY_COLOR);
		detailScroll.setPreferredSize(new Dimension(0, 260));
		detailScroll.setVisible(false);

		split = new JSplitPane(JSplitPane.VERTICAL_SPLIT, grid, detailScroll);
		split.setResizeWeight(1.0);
		split.setBorder(null);
		split.setDividerSize(0);
		split.setBackground(ColorScheme.DARK_GRAY_COLOR);
		content.add(split, BorderLayout.CENTER);
		setContentPane(content);

		// Keeps the "Time left" countdown in the status line ticking while visible.
		countdownTimer = new javax.swing.Timer(1000, e ->
		{
			if (isVisible())
			{
				updateStatusLine();
			}
		});
		countdownTimer.start();
	}

	@Override
	public void dispose()
	{
		countdownTimer.stop();
		super.dispose();
	}

	void open()
	{
		setAlwaysOnTop(plugin.popOutAlwaysOnTop());
		refresh();
		setVisible(true);
		toFront();
	}

	void refresh()
	{
		BingoBoard board = plugin.getBoard();
		if (board != renderedBoard)
		{
			rebuildGrid(board);
			renderedBoard = board;
		}
		if (board == null)
		{
			setTitle("Irons Pub Bingo");
			statusLabel.setText("No board loaded");
			detailScroll.setVisible(false);
			split.setDividerSize(0);
			return;
		}

		detail.setSelectedTile(plugin.selectedTileIndex());
		boolean showDetail = detail.rebuild();
		if (detailScroll.isVisible() != showDetail)
		{
			detailScroll.setVisible(showDetail);
			split.setDividerSize(showDetail ? 6 : 0);
			if (showDetail)
			{
				split.resetToPreferredSizes();
			}
			getContentPane().revalidate();
		}
		detail.revalidate();
		detail.repaint();

		setTitle("Irons Pub Bingo - " + board.getName());
		updateStatusLine();

		int size = board.getSize();
		// Actual cell width: grid width minus the inter-cell gaps, minus padding. Swing's
		// HTML renderer honors width only on <body>, and an over-wide block would render
		// left-anchored and clipped, pushing the text off center.
		int gridWidth = grid.getWidth() > 0 ? grid.getWidth() : 640;
		int textWidth = Math.max(48, (gridWidth - (size - 1) * 4) / size - 16);
		boolean drawLines = plugin.lineDisplay() == LineDisplay.LINES;
		boolean fillMode = plugin.progressFill();
		int selected = plugin.selectedTileIndex();
		grid.setLines(size, drawLines ? plugin.completedLineSegments() : java.util.Collections.emptyList());
		java.util.Set<Integer> lineCells = drawLines ? java.util.Collections.emptySet() : plugin.completedLineCells();
		for (int i = 0; i < cells.size(); i++)
		{
			BingoTile tile = board.getTiles().get(i);
			BingoTileCell cell = cells.get(i);
			boolean complete = plugin.isTileComplete(i);
			cell.setBackground(complete ? BingoUi.COLOR_COMPLETE
				: !fillMode && hasProgress(tile, i) ? BingoUi.COLOR_PARTIAL : BingoUi.COLOR_EMPTY);
			cell.setFillFraction(complete || !fillMode ? 0f : (float) plugin.tileProgressFraction(i));
			Color border = i == selected ? Color.WHITE
				: lineCells.contains(i) ? BingoUi.COLOR_LINE
				: ColorScheme.DARKER_GRAY_HOVER_COLOR;
			cell.setBorder(BorderFactory.createLineBorder(border,
				i == selected || lineCells.contains(i) ? 2 : 1));
			cellLabels.get(i).setWrapWidth(textWidth);
			String tooltip = "<html><b>" + BingoUi.escapeHtml(tile.label) + "</b><br>"
				+ (complete ? "Complete" : summary(tile, i)) + "</html>";
			cell.setToolTipText(tooltip);
			cellIcons.get(i).setToolTipText(tooltip);
			cellLabels.get(i).setToolTipText(tooltip);
		}
		revalidate();
		repaint();
	}

	private void updateStatusLine()
	{
		BingoBoard board = plugin.getBoard();
		if (board == null)
		{
			return;
		}
		StringBuilder status = new StringBuilder(plugin.boardTitleText())
			.append("   |   ").append(plugin.completedCount()).append('/').append(board.getTiles().size()).append(" tiles")
			.append("   |   ").append(plugin.completedLines()).append(" lines");
		if (plugin.totalBoardPoints() > 0)
		{
			status.append("   |   ").append(plugin.earnedPoints()).append('/').append(plugin.totalBoardPoints()).append(" pts");
		}
		String event = plugin.eventStatusText();
		if (!event.isEmpty())
		{
			status.append("   |   ").append(event);
		}
		String text = status.toString();
		if (!text.equals(statusLabel.getText()))
		{
			statusLabel.setText(text);
		}
	}

	private void rebuildGrid(BingoBoard board)
	{
		grid.removeAll();
		cells.clear();
		cellIcons.clear();
		cellLabels.clear();
		if (board == null)
		{
			grid.setLayout(new BorderLayout());
			JLabel hint = new JLabel("Import a board in the Irons Pub Bingo side panel first.", SwingConstants.CENTER);
			hint.setForeground(ColorScheme.LIGHT_GRAY_COLOR);
			grid.add(hint, BorderLayout.CENTER);
		}
		else
		{
			int size = board.getSize();
			grid.setLayout(new GridLayout(size, size, 4, 4));
			for (int i = 0; i < board.getTiles().size(); i++)
			{
				final int tileIndex = i;
				BingoTile tile = board.getTiles().get(i);
				BingoTileCell cell = new BingoTileCell();
				// Icon and text as separately stacked, individually centered components —
				// Swing's compound icon+text label does not center HTML text reliably.
				JLabel iconLabel = new JLabel();
				iconLabel.setAlignmentX(java.awt.Component.CENTER_ALIGNMENT);
				BingoWrappedLabel label = new BingoWrappedLabel(tile.label, SwingConstants.CENTER, 100);
				label.setForeground(Color.WHITE);
				if (tile.pointsValue() > 0)
				{
					label.setSecondary(tile.pointsValue() + " pts", ColorScheme.LIGHT_GRAY_COLOR);
				}
				AsyncBufferedImage itemIcon = plugin.iconFor(tile);
				if (itemIcon != null)
				{
					BingoUi.applyIcon(iconLabel, itemIcon, 32, cell);
				}
				JPanel stack = new JPanel();
				stack.setLayout(new javax.swing.BoxLayout(stack, javax.swing.BoxLayout.Y_AXIS));
				stack.setOpaque(false);
				stack.add(iconLabel);
				stack.add(javax.swing.Box.createVerticalStrut(4));
				stack.add(label);
				cell.setLayout(new java.awt.GridBagLayout());
				cell.add(stack, new java.awt.GridBagConstraints());
				cell.setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
				// Tooltips register the children as mouse-event targets, so they must
				// carry the click handler too or they'd swallow clicks over icon/text.
				MouseAdapter click = new MouseAdapter()
				{
					@Override
					public void mousePressed(MouseEvent e)
					{
						plugin.selectTileInPanel(tileIndex);
					}
				};
				cell.addMouseListener(click);
				iconLabel.addMouseListener(click);
				label.addMouseListener(click);
				cells.add(cell);
				cellIcons.add(iconLabel);
				cellLabels.add(label);
				grid.add(cell);
			}
		}
		grid.revalidate();
		grid.repaint();
	}

	private boolean hasProgress(BingoTile tile, int tileIndex)
	{
		TileProgress tp = plugin.mergedProgressFor(tileIndex);
		for (int g = 0; g < tile.goals.size(); g++)
		{
			if (tile.goals.get(g).progressOf(tp.goal(g, tile.goals.size())) > 0)
			{
				return true;
			}
		}
		return false;
	}

	private String summary(BingoTile tile, int tileIndex)
	{
		TileProgress tp = plugin.mergedProgressFor(tileIndex);
		StringBuilder sb = new StringBuilder();
		for (int g = 0; g < tile.goals.size(); g++)
		{
			BingoGoal goal = tile.goals.get(g);
			if (g > 0)
			{
				sb.append("<br>");
			}
			GoalProgress p = tp.goal(g, tile.goals.size());
			sb.append(Math.min(goal.progressOf(p), goal.target())).append('/').append(goal.target());
		}
		return sb.toString();
	}
}

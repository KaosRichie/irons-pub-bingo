package com.ironspubbingo;

import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.Point;
import java.awt.Rectangle;
import java.awt.RenderingHints;
import java.util.Collections;
import java.util.List;
import javax.swing.JPanel;

/**
 * The bingo grid container: hosts the tile cells and paints translucent strokes straight
 * through completed bingo lines on top of them, classic bingo-card style, so it is obvious
 * which row/column/diagonal a completed line runs along.
 */
class BingoGridPanel extends JPanel
{
	private static final Color LINE_COLOR = new Color(
		BingoUi.COLOR_LINE.getRed(), BingoUi.COLOR_LINE.getGreen(), BingoUi.COLOR_LINE.getBlue(), 170);

	private int boardSize;
	/** Completed lines as {firstCellIndex, lastCellIndex} pairs. */
	private List<int[]> lineSegments = Collections.emptyList();

	void setLines(int boardSize, List<int[]> lineSegments)
	{
		this.boardSize = boardSize;
		this.lineSegments = lineSegments;
		repaint();
	}

	@Override
	protected void paintChildren(Graphics g)
	{
		super.paintChildren(g);
		if (lineSegments.isEmpty() || boardSize <= 0 || getComponentCount() < boardSize * boardSize)
		{
			return;
		}
		Graphics2D g2 = (Graphics2D) g.create();
		g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
		g2.setColor(LINE_COLOR);
		g2.setStroke(new BasicStroke(Math.max(4f, getWidth() / (boardSize * 14f)),
			BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND));
		for (int[] segment : lineSegments)
		{
			Point from = cellCenter(segment[0]);
			Point to = cellCenter(segment[1]);
			g2.drawLine(from.x, from.y, to.x, to.y);
		}
		g2.dispose();
	}

	private Point cellCenter(int cellIndex)
	{
		Rectangle bounds = getComponent(cellIndex).getBounds();
		return new Point(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
	}
}

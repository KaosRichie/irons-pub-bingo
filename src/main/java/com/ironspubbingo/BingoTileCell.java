package com.ironspubbingo;

import java.awt.BorderLayout;
import java.awt.Graphics;
import javax.swing.JPanel;

/**
 * One tile cell on the board grid. Optionally paints a bottom-up fill showing the tile's
 * partial progress, like a progress bar inside the tile.
 */
class BingoTileCell extends JPanel
{
	private float fillFraction;

	BingoTileCell()
	{
		super(new BorderLayout());
	}

	void setFillFraction(float fillFraction)
	{
		if (this.fillFraction != fillFraction)
		{
			this.fillFraction = fillFraction;
			repaint();
		}
	}

	@Override
	protected void paintComponent(Graphics g)
	{
		super.paintComponent(g);
		if (fillFraction > 0f)
		{
			int fillHeight = Math.round(getHeight() * Math.min(1f, fillFraction));
			g.setColor(BingoUi.COLOR_PARTIAL);
			g.fillRect(0, getHeight() - fillHeight, getWidth(), fillHeight);
		}
	}
}

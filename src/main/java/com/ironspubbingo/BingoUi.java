package com.ironspubbingo;

import java.awt.Color;
import java.awt.Image;
import javax.swing.ImageIcon;
import javax.swing.JComponent;
import javax.swing.JLabel;
import javax.swing.SwingUtilities;
import net.runelite.client.util.AsyncBufferedImage;

/**
 * Shared look and rendering helpers for the sidebar panel and the pop-out board window.
 */
final class BingoUi
{
	static final Color COLOR_COMPLETE = new Color(60, 124, 50);
	static final Color COLOR_PARTIAL = new Color(148, 111, 22);
	/** Gold, as on the clan logo: completed bingo lines, check badges, highlights. */
	static final Color COLOR_GOLD = new Color(226, 173, 72);
	/** Completed bingo lines, unless the Line color setting says otherwise. */
	static final Color COLOR_LINE = new Color(255, 0, 0);
	static final Color COLOR_GOAL_DONE = new Color(122, 200, 108);
	static final Color COLOR_CHIP = new Color(40, 40, 40);
	static final Color COLOR_CHIP_EDGE = new Color(64, 64, 64);

	private BingoUi()
	{
	}

	/**
	 * A small rounded label for a stat ("12 / 25 tiles"): bold value, quieter caption.
	 * Painted, so it looks the same in the sidebar and the pop-out window.
	 */
	static final class Chip extends JLabel
	{
		Chip()
		{
			setOpaque(false);
			setFont(net.runelite.client.ui.FontManager.getRunescapeSmallFont());
			setBorder(javax.swing.BorderFactory.createEmptyBorder(3, 9, 3, 9));
		}

		/** Updates the chip; a null caption shows the value alone, a null color means white. */
		void set(String value, String caption, Color valueColor)
		{
			String text = "<html><b>" + escapeHtml(value) + "</b>"
				+ (caption == null ? "" : " <font color='#a0a0a0'>" + escapeHtml(caption) + "</font>") + "</html>";
			if (!text.equals(getText()))
			{
				setText(text);
			}
			setForeground(valueColor == null ? Color.WHITE : valueColor);
		}

		@Override
		protected void paintComponent(java.awt.Graphics graphics)
		{
			java.awt.Graphics2D g = (java.awt.Graphics2D) graphics.create();
			g.setRenderingHint(java.awt.RenderingHints.KEY_ANTIALIASING, java.awt.RenderingHints.VALUE_ANTIALIAS_ON);
			g.setColor(COLOR_CHIP);
			g.fillRoundRect(0, 0, getWidth() - 1, getHeight() - 1, getHeight(), getHeight());
			g.setColor(COLOR_CHIP_EDGE);
			g.drawRoundRect(0, 0, getWidth() - 1, getHeight() - 1, getHeight(), getHeight());
			g.dispose();
			super.paintComponent(graphics);
		}
	}

	/** 1st, 2nd, 3rd, 4th, 11th, 21st... */
	static String ordinal(int n)
	{
		if (n % 100 >= 11 && n % 100 <= 13)
		{
			return n + "th";
		}
		switch (n % 10)
		{
			case 1:
				return n + "st";
			case 2:
				return n + "nd";
			case 3:
				return n + "rd";
			default:
				return n + "th";
		}
	}

	/** Gold, silver, bronze for the top three placements, white after that. */
	static Color rankColor(int rank)
	{
		return rank == 1 ? new Color(255, 215, 0) : rank == 2 ? new Color(232, 232, 232)
			: rank == 3 ? new Color(215, 141, 74) : Color.WHITE;
	}

	static String escapeHtml(String s)
	{
		return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
	}

	/** Sets a (rescaled) item sprite on the label, re-applying once the sprite loads. */
	static void applyIcon(JLabel label, AsyncBufferedImage image, int maxSize, JComponent repaintTarget)
	{
		Runnable apply = () ->
		{
			int w = image.getWidth();
			int h = image.getHeight();
			if (w <= 0 || h <= 0)
			{
				return;
			}
			double scale = Math.min(1.0, (double) maxSize / Math.max(w, h));
			Image scaled = scale < 1.0
				? image.getScaledInstance(Math.max(1, (int) (w * scale)), Math.max(1, (int) (h * scale)), Image.SCALE_SMOOTH)
				: image;
			label.setIcon(new ImageIcon(scaled));
			repaintTarget.revalidate();
			repaintTarget.repaint();
		};
		apply.run();
		image.onLoaded(() -> SwingUtilities.invokeLater(apply));
	}
}

package com.ironspubbingo;

import java.awt.Color;
import java.awt.Image;
import javax.swing.ImageIcon;
import javax.swing.JComponent;
import javax.swing.JLabel;
import javax.swing.SwingUtilities;
import net.runelite.client.ui.ColorScheme;
import net.runelite.client.util.AsyncBufferedImage;

/**
 * Shared look and rendering helpers for the sidebar panel and the pop-out board window.
 */
final class BingoUi
{
	static final Color COLOR_COMPLETE = new Color(60, 124, 50);
	static final Color COLOR_PARTIAL = new Color(148, 111, 22);
	static final Color COLOR_EMPTY = ColorScheme.DARKER_GRAY_COLOR;
	static final Color COLOR_LINE = new Color(214, 58, 46);
	static final Color COLOR_GOAL_DONE = new Color(122, 200, 108);

	private BingoUi()
	{
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

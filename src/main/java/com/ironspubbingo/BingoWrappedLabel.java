package com.ironspubbingo;

import java.awt.Color;
import java.awt.Container;
import java.awt.Dimension;
import java.awt.FontMetrics;
import java.awt.Graphics;
import java.awt.Insets;
import java.awt.event.ComponentAdapter;
import java.awt.event.ComponentEvent;
import java.util.ArrayList;
import java.util.List;
import javax.swing.JComponent;
import javax.swing.SwingConstants;
import net.runelite.client.ui.ColorScheme;
import net.runelite.client.ui.FontManager;

/**
 * Word-wrapping text component that measures and paints every line itself, wrapping to the
 * width it is actually given. Swing's HTML renderer needs a hard-coded pixel width, which
 * silently clips whenever that guess is wider than the real column, so plugin text uses
 * this instead.
 */
class BingoWrappedLabel extends JComponent
{
	private final int alignment;
	private final int fallbackWidth;
	private int explicitWrapWidth;
	private int lastLineCount = -1;
	private String text;
	private String secondary;
	private Color secondaryColor = ColorScheme.LIGHT_GRAY_COLOR;

	BingoWrappedLabel(String text, int fallbackWidth)
	{
		this(text, SwingConstants.LEFT, fallbackWidth);
	}

	BingoWrappedLabel(String text, int alignment, int fallbackWidth)
	{
		this.text = text == null ? "" : text;
		this.alignment = alignment;
		this.fallbackWidth = fallbackWidth;
		setFont(FontManager.getRunescapeSmallFont());
		setForeground(ColorScheme.LIGHT_GRAY_COLOR);
		setAlignmentX(alignment == SwingConstants.CENTER ? CENTER_ALIGNMENT : LEFT_ALIGNMENT);
		addComponentListener(new ComponentAdapter()
		{
			@Override
			public void componentResized(ComponentEvent e)
			{
				// Height depends on width, so re-layout when the new width wraps into a
				// different number of lines. Comparing line counts (not widths) converges:
				// once the height matches the width, no further revalidate is triggered.
				if (lineCount() != lastLineCount)
				{
					revalidate();
				}
			}
		});
	}

	void setText(String text)
	{
		this.text = text == null ? "" : text;
		revalidate();
		repaint();
	}

	/** Optional second block of lines, drawn under the main text in its own color. */
	void setSecondary(String secondary, Color color)
	{
		this.secondary = secondary;
		if (color != null)
		{
			this.secondaryColor = color;
		}
		revalidate();
		repaint();
	}

	/** Forces a wrap width instead of deriving it from the component's own width. */
	void setWrapWidth(int width)
	{
		if (width != explicitWrapWidth)
		{
			explicitWrapWidth = width;
			revalidate();
			repaint();
		}
	}

	private int wrapWidth()
	{
		if (explicitWrapWidth > 0)
		{
			return explicitWrapWidth;
		}
		int width = getWidth();
		if (width <= 0)
		{
			Container parent = getParent();
			if (parent != null && parent.getWidth() > 0)
			{
				Insets parentInsets = parent.getInsets();
				width = parent.getWidth() - parentInsets.left - parentInsets.right;
			}
		}
		if (width <= 0)
		{
			width = fallbackWidth;
		}
		Insets insets = getInsets();
		return Math.max(24, width - insets.left - insets.right);
	}

	/** Wraps to the given width, honoring explicit line breaks in the text. */
	private List<String> wrap(FontMetrics metrics, String value, int width)
	{
		List<String> lines = new ArrayList<>();
		if (value == null || value.isEmpty())
		{
			return lines;
		}
		for (String paragraph : value.split("\n", -1))
		{
			StringBuilder current = new StringBuilder();
			for (String word : paragraph.split(" "))
			{
				if (current.length() == 0)
				{
					current.append(word);
				}
				else if (metrics.stringWidth(current + " " + word) <= width)
				{
					current.append(' ').append(word);
				}
				else
				{
					lines.add(current.toString());
					current = new StringBuilder(word);
				}
			}
			lines.add(current.toString());
		}
		return lines;
	}

	private int lineCount()
	{
		FontMetrics metrics = getFontMetrics(getFont());
		int width = wrapWidth();
		return wrap(metrics, text, width).size() + wrap(metrics, secondary, width).size();
	}

	@Override
	public Dimension getPreferredSize()
	{
		FontMetrics metrics = getFontMetrics(getFont());
		int width = wrapWidth();
		int lines = lineCount();
		lastLineCount = lines;
		Insets insets = getInsets();
		return new Dimension(width + insets.left + insets.right,
			Math.max(1, lines) * metrics.getHeight() + insets.top + insets.bottom);
	}

	@Override
	public Dimension getMaximumSize()
	{
		return new Dimension(Integer.MAX_VALUE, getPreferredSize().height);
	}

	@Override
	protected void paintComponent(Graphics g)
	{
		super.paintComponent(g);
		g.setFont(getFont());
		FontMetrics metrics = g.getFontMetrics();
		Insets insets = getInsets();
		int width = wrapWidth();
		int y = insets.top + metrics.getAscent();

		g.setColor(getForeground());
		y = paintLines(g, metrics, wrap(metrics, text, width), width, insets.left, y);
		if (secondary != null)
		{
			g.setColor(secondaryColor);
			paintLines(g, metrics, wrap(metrics, secondary, width), width, insets.left, y);
		}
	}

	private int paintLines(Graphics g, FontMetrics metrics, List<String> lines, int width, int left, int y)
	{
		for (String line : lines)
		{
			int x = alignment == SwingConstants.CENTER
				? left + (width - metrics.stringWidth(line)) / 2
				: left;
			g.drawString(line, x, y);
			y += metrics.getHeight();
		}
		return y;
	}
}

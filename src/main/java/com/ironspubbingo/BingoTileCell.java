package com.ironspubbingo;

import java.awt.BasicStroke;
import java.awt.BorderLayout;
import java.awt.Color;
import java.awt.Component;
import java.awt.GradientPaint;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.Shape;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;
import java.awt.geom.RoundRectangle2D;
import javax.swing.JPanel;

/**
 * One tile on the board grid, hand-painted: a rounded card whose color tells its state,
 * an optional bottom-up progress fill, a gold outline on tiles in a completed line, and a
 * white outline on the selected tile.
 */
class BingoTileCell extends JPanel
{
	private static final Color EMPTY_TOP = new Color(44, 44, 44);
	private static final Color EMPTY_BOTTOM = new Color(34, 34, 34);
	private static final Color COMPLETE_TOP = new Color(66, 132, 58);
	private static final Color COMPLETE_BOTTOM = new Color(45, 98, 40);
	private static final Color PARTIAL_TOP = new Color(150, 112, 26);
	private static final Color PARTIAL_BOTTOM = new Color(120, 88, 18);
	private static final Color EDGE = new Color(62, 62, 62);
	private static final Color EDGE_HOVER = new Color(110, 110, 110);

	private boolean complete;
	private boolean partial;
	private float fillFraction;
	private boolean selected;
	private boolean inLine;
	private boolean hovered;

	BingoTileCell()
	{
		super(new BorderLayout());
		setOpaque(false);
		trackHover(this);
	}

	/**
	 * Sets everything the cell shows in one go. partial colors the whole tile amber (the
	 * classic look); a fill fraction above zero paints amber up from the bottom instead.
	 */
	void setState(boolean complete, boolean partial, float fillFraction, boolean selected, boolean inLine)
	{
		if (this.complete != complete || this.partial != partial || this.fillFraction != fillFraction
			|| this.selected != selected || this.inLine != inLine)
		{
			this.complete = complete;
			this.partial = partial;
			this.fillFraction = fillFraction;
			this.selected = selected;
			this.inLine = inLine;
			repaint();
		}
	}

	/** Child components cover the cell; they report hover too, so the outline follows the mouse. */
	void trackHover(Component component)
	{
		component.addMouseListener(new MouseAdapter()
		{
			@Override
			public void mouseEntered(MouseEvent e)
			{
				setHovered(true);
			}

			@Override
			public void mouseExited(MouseEvent e)
			{
				// Moving onto a child fires an exit on the parent first; only a real exit counts.
				setHovered(getMousePosition(true) != null);
			}
		});
	}

	private void setHovered(boolean hovered)
	{
		if (this.hovered != hovered)
		{
			this.hovered = hovered;
			repaint();
		}
	}

	@Override
	protected void paintComponent(Graphics graphics)
	{
		Graphics2D g = (Graphics2D) graphics.create();
		g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
		int w = getWidth();
		int h = getHeight();
		float arc = Math.max(6f, Math.min(w, h) / 7f);
		Shape card = new RoundRectangle2D.Float(0.5f, 0.5f, w - 1f, h - 1f, arc, arc);

		Color top = complete ? COMPLETE_TOP : partial ? PARTIAL_TOP : EMPTY_TOP;
		Color bottom = complete ? COMPLETE_BOTTOM : partial ? PARTIAL_BOTTOM : EMPTY_BOTTOM;
		g.setPaint(new GradientPaint(0, 0, top, 0, h, bottom));
		g.fill(card);

		if (!complete && fillFraction > 0f)
		{
			int fillHeight = Math.round(h * Math.min(1f, fillFraction));
			Graphics2D fill = (Graphics2D) g.create();
			fill.clip(card);
			fill.setPaint(new GradientPaint(0, h - fillHeight, PARTIAL_TOP, 0, h, PARTIAL_BOTTOM));
			fill.fillRect(0, h - fillHeight, w, fillHeight);
			fill.dispose();
		}

		float stroke = selected || inLine ? 2f : 1f;
		g.setStroke(new BasicStroke(stroke));
		g.setColor(selected ? Color.WHITE : inLine ? BingoUi.COLOR_LINE : hovered ? EDGE_HOVER
			: complete ? COMPLETE_TOP.brighter() : EDGE);
		float inset = stroke / 2f + 0.5f;
		g.draw(new RoundRectangle2D.Float(inset, inset, w - 2 * inset, h - 2 * inset, arc, arc));
		g.dispose();
	}
}

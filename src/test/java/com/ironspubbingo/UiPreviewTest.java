package com.ironspubbingo;

import java.awt.Color;
import java.awt.Component;
import java.awt.Container;
import java.awt.Dimension;
import java.awt.GridLayout;
import java.awt.image.BufferedImage;
import java.io.File;
import javax.imageio.ImageIO;
import javax.swing.BorderFactory;
import javax.swing.JComponent;
import javax.swing.JList;
import javax.swing.JPanel;
import javax.swing.SwingConstants;
import net.runelite.client.ui.ColorScheme;
import org.junit.Test;
import static org.junit.Assert.assertTrue;

/**
 * Renders the stand-alone UI pieces to build/ui-preview/*.png, so their look can be checked
 * without a logged-in client: the help window, a sample board, and the stat chips.
 */
public class UiPreviewTest
{
	private static final File OUT = new File("build/ui-preview");

	@Test
	public void rendersPreviews() throws Exception
	{
		OUT.mkdirs();
		JComponent help = BingoHelp.content(() ->
		{
		});
		for (int topic = 0; topic < 7; topic++)
		{
			selectTopic(help, topic);
			save(help, 680, 520, "help-" + topic + ".png");
		}

		JPanel board = new BingoGridPanel();
		board.setLayout(new GridLayout(3, 3, 4, 4));
		board.setBackground(ColorScheme.DARK_GRAY_COLOR);
		board.setBorder(BorderFactory.createEmptyBorder(8, 8, 8, 8));
		String[] labels = {"Uncut onyx from Zulrah", "Any pet", "500 Brutus kills", "Barrows chest pieces (3 distinct)",
			"1M Thieving XP", "Tormented demon unique", "50 Seers laps", "Fire cape", "Free space"};
		for (int i = 0; i < 9; i++)
		{
			BingoTileCell cell = new BingoTileCell();
			BingoWrappedLabel label = new BingoWrappedLabel(labels[i], SwingConstants.CENTER, 120);
			label.setForeground(Color.WHITE);
			label.setSecondary((5 + i % 3 * 5) + " pts", ColorScheme.LIGHT_GRAY_COLOR);
			cell.setLayout(new java.awt.GridBagLayout());
			cell.add(label, new java.awt.GridBagConstraints());
			boolean complete = i < 3 || i == 4;
			cell.setState(complete, !complete && i % 2 == 1, !complete && i == 6 ? 0.6f : 0f, i == 5, i < 3);
			board.add(cell);
		}
		((BingoGridPanel) board).setLines(3, java.util.Collections.singletonList(new int[]{0, 2}));
		save(board, 460, 460, "board.png");

		JPanel chips = new JPanel(new java.awt.FlowLayout(java.awt.FlowLayout.LEFT, 6, 6));
		chips.setBackground(ColorScheme.DARK_GRAY_COLOR);
		chips.add(BingoUi.chip("12 / 25", "tiles", null));
		chips.add(BingoUi.chip("2", "lines", BingoUi.COLOR_GOLD));
		chips.add(BingoUi.chip("85 / 200", "pts", null));
		chips.add(BingoUi.chip("1st", null, BingoUi.COLOR_GOLD));
		save(chips, 460, 40, "chips.png");
		assertTrue(new File(OUT, "board.png").isFile());
	}

	private static void selectTopic(Component root, int index)
	{
		if (root instanceof JList)
		{
			((JList<?>) root).setSelectedIndex(index);
			return;
		}
		if (root instanceof Container)
		{
			for (Component child : ((Container) root).getComponents())
			{
				selectTopic(child, index);
			}
		}
	}

	private static void save(JComponent component, int width, int height, String name) throws Exception
	{
		component.setSize(new Dimension(width, height));
		layout(component);
		BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB);
		java.awt.Graphics2D g = image.createGraphics();
		component.printAll(g);
		g.dispose();
		ImageIO.write(image, "png", new File(OUT, name));
	}

	private static void layout(Component component)
	{
		component.doLayout();
		if (component instanceof Container)
		{
			for (Component child : ((Container) component).getComponents())
			{
				layout(child);
			}
		}
	}
}

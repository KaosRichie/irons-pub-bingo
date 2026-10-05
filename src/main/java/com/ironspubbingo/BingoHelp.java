package com.ironspubbingo;

import java.awt.BorderLayout;
import java.awt.Color;
import java.awt.Component;
import java.awt.Dimension;
import java.awt.FlowLayout;
import java.awt.Window;
import java.util.LinkedHashMap;
import java.util.Map;
import javax.swing.BorderFactory;
import javax.swing.DefaultListCellRenderer;
import javax.swing.JButton;
import javax.swing.JComponent;
import javax.swing.JDialog;
import javax.swing.JEditorPane;
import javax.swing.JLabel;
import javax.swing.JList;
import javax.swing.JPanel;
import javax.swing.JScrollPane;
import javax.swing.ListSelectionModel;
import javax.swing.SwingUtilities;
import javax.swing.event.HyperlinkEvent;
import net.runelite.client.ui.ColorScheme;
import net.runelite.client.ui.FontManager;
import net.runelite.client.util.LinkBrowser;

/**
 * The in-game help: a topic list on the left and one short page per topic on the right,
 * instead of one long wall of text. Keep it in step with README.md's player section.
 */
final class BingoHelp
{
	static final String README_URL = "https://github.com/KaosRichie/irons-pub-bingo";
	static final String FORGE_URL = "https://kaosrichie.github.io/irons-pub-bingo/board-builder.html";

	private static final String GOLD = "#e2ad48";
	private static final String MUTED = "#a6a6a6";

	private BingoHelp()
	{
	}

	/** Opens the help window over the given component. lineColor is the Line color setting. */
	static void show(Component parent, Color lineColor)
	{
		Window owner = parent == null ? null : SwingUtilities.getWindowAncestor(parent);
		JDialog dialog = new JDialog(owner, "Irons Pub Bingo - Help");
		dialog.setContentPane(content(dialog::dispose, lineColor));
		dialog.setSize(680, 520);
		dialog.setMinimumSize(new Dimension(520, 380));
		dialog.setLocationRelativeTo(parent);
		dialog.setVisible(true);
	}

	/** The whole help view, also used on its own to preview the layout. */
	static JComponent content(Runnable onClose, Color lineColor)
	{
		Map<String, String> pages = pages(lineColor);

		JEditorPane page = new JEditorPane("text/html", "");
		page.setEditable(false);
		page.putClientProperty(JEditorPane.HONOR_DISPLAY_PROPERTIES, Boolean.TRUE);
		page.setFont(FontManager.getRunescapeFont());
		page.setForeground(ColorScheme.LIGHT_GRAY_COLOR);
		page.setBackground(ColorScheme.DARKER_GRAY_COLOR);
		page.setBorder(BorderFactory.createEmptyBorder(14, 18, 14, 18));
		page.addHyperlinkListener(e ->
		{
			if (e.getEventType() == HyperlinkEvent.EventType.ACTIVATED && e.getURL() != null)
			{
				LinkBrowser.browse(e.getURL().toString());
			}
		});
		JScrollPane pageScroll = new JScrollPane(page);
		pageScroll.setBorder(BorderFactory.createEmptyBorder());
		pageScroll.getViewport().setBackground(ColorScheme.DARKER_GRAY_COLOR);

		JList<String> topics = new JList<>(pages.keySet().toArray(new String[0]));
		topics.setSelectionMode(ListSelectionModel.SINGLE_SELECTION);
		topics.setBackground(ColorScheme.DARK_GRAY_COLOR);
		topics.setFixedCellHeight(32);
		topics.setCellRenderer(new DefaultListCellRenderer()
		{
			@Override
			public Component getListCellRendererComponent(JList<?> list, Object value, int index,
				boolean selected, boolean focused)
			{
				JLabel label = (JLabel) super.getListCellRendererComponent(list, value, index, selected, false);
				label.setFont(selected ? FontManager.getRunescapeBoldFont() : FontManager.getRunescapeFont());
				label.setForeground(selected ? ColorScheme.BRAND_ORANGE : ColorScheme.LIGHT_GRAY_COLOR);
				label.setBackground(selected ? ColorScheme.DARKER_GRAY_COLOR : ColorScheme.DARK_GRAY_COLOR);
				label.setBorder(BorderFactory.createCompoundBorder(
					BorderFactory.createMatteBorder(0, 3, 0, 0, selected ? ColorScheme.BRAND_ORANGE : ColorScheme.DARK_GRAY_COLOR),
					BorderFactory.createEmptyBorder(0, 12, 0, 8)));
				return label;
			}
		});
		topics.addListSelectionListener(e ->
		{
			String topic = topics.getSelectedValue();
			if (topic != null)
			{
				page.setText(pages.get(topic));
				page.setCaretPosition(0);
			}
		});
		topics.setSelectedIndex(0);
		JPanel side = new JPanel(new BorderLayout());
		side.setBackground(ColorScheme.DARK_GRAY_COLOR);
		side.setBorder(BorderFactory.createEmptyBorder(10, 0, 10, 0));
		side.setPreferredSize(new Dimension(170, 0));
		side.add(topics, BorderLayout.NORTH);

		JPanel buttons = new JPanel(new FlowLayout(FlowLayout.RIGHT, 8, 8));
		buttons.setBackground(ColorScheme.DARK_GRAY_COLOR);
		buttons.add(linkButton("Full Readme", README_URL));
		buttons.add(linkButton("Bingo Forge", FORGE_URL));
		JButton close = new JButton("Close");
		close.setFocusable(false);
		close.addActionListener(e -> onClose.run());
		buttons.add(close);

		JPanel root = new JPanel(new BorderLayout());
		root.setBackground(ColorScheme.DARK_GRAY_COLOR);
		root.add(side, BorderLayout.WEST);
		root.add(pageScroll, BorderLayout.CENTER);
		root.add(buttons, BorderLayout.SOUTH);
		return root;
	}

	private static JButton linkButton(String text, String url)
	{
		JButton button = new JButton(text);
		button.setFocusable(false);
		button.setToolTipText(url);
		button.addActionListener(e -> LinkBrowser.browse(url));
		return button;
	}

	// ---------------------------------------------------------------- pages

	private static Map<String, String> pages(Color lineColor)
	{
		Map<String, String> pages = new LinkedHashMap<>();
		pages.put("Getting started", page("Getting started",
			p("Your host shares a board. The plugin tracks your tiles as you play and adds up "
				+ "progress across your team.")
				+ h("With a team store")
				+ ol("In the plugin settings, turn on <b>Use team store</b> and paste the store URL from your host.",
					"In the panel, press <b>Import board from store</b>.",
					"Press <b>Choose team</b> and pick your team.")
				+ p("The <b>Get started</b> card in the panel always shows the next step.")
				+ h("Without a team store")
				+ ul("Press <b>Import board</b> and paste the board code from your host.",
					"Put your team code from the host in the plugin settings.")));
		pages.put("The board", page("The board",
			legend(lineColor)
				+ ul("Click a tile to see its goals, who contributed what, and its actions.",
					"Hover a tile for a quick summary.",
					"The window button next to the title opens a large board you can resize.",
					"A completed tile shows the team's progress as it stood when it completed. "
						+ "Tracking carries on in the background.")));
		pages.put("Team sync", page("Team sync",
			p("Progress adds up across the team: counts add together, and a list of different items "
				+ "counts each item once.")
				+ h("Two ways to sync")
				+ ul("<b>Live sync</b> shares progress instantly with teammates who are online, through a RuneLite party.",
					"<b>Team store</b> syncs every couple of minutes, even when nobody else is online. "
						+ "The Store button shows its status. Click it to pause or resume.")
				+ h("Good to know")
				+ ul("<b>Sync now</b> syncs right away. <b>Portal</b> opens the team's page in your browser.",
					"Each team keeps its own progress. Switching teams parks yours, switching back restores it.")));
		pages.put("Credit requests", page("Credit requests",
			p("The tracker can miss progress, for example on mobile or while the client was closed. "
				+ "Requests need the team store.")
				+ ol("Click the tile, open <b>Actions</b> and press <b>Request admin credit</b>.",
					"Enter the amount, or tick that the whole tile is complete.",
					"Add a note and a proof link. With a Discord webhook set, the plugin can take "
						+ "the screenshot, post it and attach its link for you.")
				+ p("An admin reviews the request. Approved credit counts for the whole team. "
					+ "The portal shows every request and its status.")));
		pages.put("Discord", page("Discord",
			p("Set a <b>Webhook URL</b> in the plugin settings to post to your team's Discord channel.")
				+ ul("With <b>Post completions to Discord</b> on, completed tiles post with a screenshot, "
						+ "plus any bingo lines or blackout.",
					"With it on, goals your host flagged also post every step of progress with a screenshot.",
					"Credit requests can post a proof screenshot and attach its link.",
					"Posts name your team and say when you are on an outdated board.")));
		pages.put("Tips", page("Tips",
			ul("Keep the built-in <b>Loot Tracker</b> plugin enabled. Drops, chests and raid loot come from it.",
				"Only loot the Loot Tracker sees counts. Most thieving chests don't show up there.",
				"For pet tiles, turn on the game setting <b>Collection log - New addition notification</b>. "
					+ "It also names the pet.",
				"XP and kill count goals start at zero when you import the board. Earlier XP and kills don't count.",
				"A newer board shows as a notice in the panel. "
					+ "Reimport it from the store in one click.",
				"Right-click a tile on the board to pin it to the in-game overlay. "
					+ "The <b>In-game Overlay</b> settings pick what the overlay shows.")));
		pages.put("Hosting", page("Hosting",
			p("Build the board in <a href='" + FORGE_URL + "'>Bingo Forge</a>, which runs in your browser, "
				+ "and export its code.")
				+ p("The <a href='" + README_URL + "'>full Readme</a> covers setting up a team store "
					+ "on Cloudflare, the board format and every goal type.")));
		return pages;
	}

	private static String page(String title, String body)
	{
		return "<html><body style='margin:0'>"
			+ "<div style='color:" + GOLD + "; font-size:15pt; font-weight:bold; margin-bottom:6px'>" + title + "</div>"
			+ body + "</body></html>";
	}

	private static String h(String text)
	{
		return "<div style='color:#ffffff; font-weight:bold; margin-top:12px; margin-bottom:2px'>" + text + "</div>";
	}

	private static String p(String text)
	{
		return "<p style='margin-top:6px; margin-bottom:4px'>" + text + "</p>";
	}

	private static String ul(String... items)
	{
		StringBuilder out = new StringBuilder("<ul style='margin-top:4px; margin-left:18px'>");
		for (String item : items)
		{
			out.append("<li style='margin-bottom:5px'>").append(item).append("</li>");
		}
		return out.append("</ul>").toString();
	}

	private static String ol(String... items)
	{
		StringBuilder out = new StringBuilder("<ol style='margin-top:4px; margin-left:22px'>");
		for (String item : items)
		{
			out.append("<li style='margin-bottom:5px'>").append(item).append("</li>");
		}
		return out.append("</ol>").toString();
	}

	/** The tile colors, as small swatches with what they mean. */
	private static String legend(Color lineColor)
	{
		Color line = lineColor == null ? BingoUi.COLOR_LINE : lineColor;
		String lineHex = String.format("#%02x%02x%02x", line.getRed(), line.getGreen(), line.getBlue());
		return "<table cellspacing='0' cellpadding='3' style='margin-top:4px; margin-bottom:6px'>"
			+ swatch("#2c2c2c", "No progress yet")
			+ swatch("#96701a", "Some progress")
			+ swatch("#42843a", "Complete")
			+ swatch(lineHex, "A completed bingo line. Line style and Line color in the settings change how it looks.")
			+ "</table>";
	}

	private static String swatch(String color, String meaning)
	{
		return "<tr><td bgcolor='" + color + "' width='18'>&nbsp;</td><td style='color:" + MUTED
			+ "; padding-left:8px'>" + meaning + "</td></tr>";
	}
}

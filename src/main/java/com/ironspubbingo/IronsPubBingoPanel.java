package com.ironspubbingo;

import java.awt.Color;
import java.awt.Cursor;
import java.awt.Dimension;
import java.awt.Graphics2D;
import java.awt.GridLayout;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;
import java.awt.image.BufferedImage;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import javax.swing.BorderFactory;
import javax.swing.Box;
import javax.swing.BoxLayout;
import javax.swing.Icon;
import javax.swing.ImageIcon;
import javax.swing.JButton;
import javax.swing.JCheckBox;
import javax.swing.JComboBox;
import javax.swing.JLabel;
import javax.swing.JOptionPane;
import javax.swing.JPanel;
import javax.swing.JScrollPane;
import javax.swing.JTextArea;
import javax.swing.JTextField;
import javax.swing.SwingConstants;
import javax.swing.SwingUtilities;
import javax.swing.Timer;
import net.runelite.client.ui.ColorScheme;
import net.runelite.client.ui.FontManager;
import net.runelite.client.ui.PluginPanel;
import net.runelite.client.ui.components.ProgressBar;
import net.runelite.client.util.AsyncBufferedImage;
import net.runelite.client.util.ImageUtil;
import net.runelite.client.util.LinkBrowser;

class IronsPubBingoPanel extends PluginPanel
{
	private static final int SYNC_COOLDOWN_SECONDS = 10;
	private static final int CONTENT_WIDTH = PluginPanel.PANEL_WIDTH - 32;
	private static final String DOT_GREEN = "<font color='#7ac86c'>&#9679;</font> ";
	private static final String DOT_ORANGE = "<font color='#f5b83d'>&#9679;</font> ";
	private static final String DOT_GRAY = "<font color='#787878'>&#9679;</font> ";
	private static final String DOT_RED = "<font color='#e06c55'>&#9679;</font> ";

	private final IronsPubBingoPlugin plugin;
	private final BingoTileDetail tileDetail;

	private final JLabel boardNameLabel = new JLabel();
	private final JLabel teamNameLabel = new JLabel();
	private final JLabel pointsLabel = new JLabel();
	private static final Icon MEDAL_GOLD = medalIcon(new Color(0xFF, 0xD7, 0x00), new Color(0xB8, 0x86, 0x0B));
	private static final Icon MEDAL_SILVER = medalIcon(new Color(0xE8, 0xE8, 0xE8), new Color(0x8F, 0x8F, 0x8F));
	private static final Icon MEDAL_BRONZE = medalIcon(new Color(0xD7, 0x8D, 0x4A), new Color(0x8B, 0x5A, 0x2B));
	private final JLabel eventStatusLabel = new JLabel();
	private final BingoWrappedLabel boardUpdateLabel = new BingoWrappedLabel("", CONTENT_WIDTH);
	private final JButton connectButton = new JButton("Connect live");
	private final JButton storePauseButton = new JButton("Pause store");
	private final JButton syncButton = new JButton("Sync now");
	private final JButton portalButton = new JButton("Portal");
	private final JButton chooseTeamButton = new JButton("Choose team");
	private final JButton advancedToggle = new JButton();
	private final JButton setupToggle = new JButton();
	private final JButton infoToggle = new JButton();
	private final Card infoCard = new Card();
	private final JPanel content = new JPanel();
	private final Card loggedOutCard = new Card();
	private final BingoGridPanel gridContainer = new BingoGridPanel();
	private final JPanel gridWrap = new JPanel(new java.awt.GridBagLayout());
	/** Last width the grid was sized for; guards the resize listener against loops. */
	private int lastGridWidth;

	private final Card headerCard = new Card();
	private final Card boardCard = new Card();
	private final Card detailCard = new Card();
	private final Card teamCard = new Card();
	private final Card setupCard = new Card();
	private final Card advancedCard = new Card();

	private final List<BingoTileCell> cells = new ArrayList<>();
	private int selectedTile = -1;
	/** A Choose-team fetch is running; refresh() must not fight its button state. */
	private boolean fetchingTeams;
	/** Animates the "Store: Syncing..." dots. */
	private int syncPulse;
	private int syncCooldown;
	private final Timer cooldownTimer;
	private final Timer countdownTimer;

	/** Horizontal row (icon beside text) that never stretches vertically in a BoxLayout. */
	private static class Row extends JPanel
	{
		Row()
		{
			super(new java.awt.BorderLayout(8, 0));
			setBackground(ColorScheme.DARKER_GRAY_COLOR);
			setAlignmentX(LEFT_ALIGNMENT);
		}

		@Override
		public Dimension getMaximumSize()
		{
			return new Dimension(Integer.MAX_VALUE, getPreferredSize().height);
		}
	}

	/** Section container: full panel width, fixed to its preferred height, own background. */
	private static class Card extends JPanel
	{
		Card()
		{
			setLayout(new BoxLayout(this, BoxLayout.Y_AXIS));
			setBackground(ColorScheme.DARKER_GRAY_COLOR);
			setBorder(BorderFactory.createEmptyBorder(8, 8, 8, 8));
			setAlignmentX(LEFT_ALIGNMENT);
		}

		@Override
		public Dimension getMaximumSize()
		{
			return new Dimension(Integer.MAX_VALUE, getPreferredSize().height);
		}
	}

	IronsPubBingoPanel(IronsPubBingoPlugin plugin)
	{
		this.plugin = plugin;
		this.tileDetail = new BingoTileDetail(plugin, CONTENT_WIDTH);

		setLayout(new BoxLayout(this, BoxLayout.Y_AXIS));
		setBorder(BorderFactory.createEmptyBorder(8, 8, 8, 8));
		setBackground(ColorScheme.DARK_GRAY_COLOR);

		// ---- header card: identity, status, primary actions ----

		JLabel title = new JLabel("Irons Pub Bingo");
		title.setFont(FontManager.getRunescapeBoldFont());
		title.setForeground(Color.WHITE);

		JButton popOutButton = new JButton(popOutIcon());
		popOutButton.setToolTipText("Open the board in a separate, resizable window");
		popOutButton.setFocusable(false);
		popOutButton.setContentAreaFilled(false);
		popOutButton.setBorder(BorderFactory.createEmptyBorder(2, 2, 2, 2));
		popOutButton.setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
		popOutButton.addActionListener(e -> plugin.openBoardWindow());

		Row titleRow = new Row();
		titleRow.add(title, java.awt.BorderLayout.CENTER);
		titleRow.add(popOutButton, java.awt.BorderLayout.EAST);

		smallLabel(boardNameLabel, ColorScheme.LIGHT_GRAY_COLOR);
		smallLabel(teamNameLabel, ColorScheme.LIGHT_GRAY_COLOR);
		smallLabel(pointsLabel, ColorScheme.LIGHT_GRAY_COLOR);
		smallLabel(eventStatusLabel, ColorScheme.BRAND_ORANGE);
		boardUpdateLabel.setForeground(new Color(224, 108, 85));

		JButton importButton = new JButton("Import board");
		importButton.addActionListener(e -> importBoard());

		headerCard.add(titleRow);
		headerCard.add(Box.createVerticalStrut(3));
		// The medal is the label's own trailing icon, so it sits right behind the text.
		pointsLabel.setHorizontalTextPosition(SwingConstants.LEADING);
		pointsLabel.setIconTextGap(4);

		headerCard.add(boardNameLabel);
		headerCard.add(teamNameLabel);
		headerCard.add(pointsLabel);
		headerCard.add(eventStatusLabel);
		headerCard.add(boardUpdateLabel);

		// ---- board card: the grid, centered within the card ----

		gridContainer.setBackground(ColorScheme.DARKER_GRAY_COLOR);
		gridWrap.setBackground(ColorScheme.DARKER_GRAY_COLOR);
		gridWrap.setAlignmentX(LEFT_ALIGNMENT);
		gridWrap.add(gridContainer, new java.awt.GridBagConstraints());
		// The sidebar is resizable: keep the board square and filling the card's actual
		// width instead of the default panel width, so a wider sidebar means a bigger board.
		gridWrap.addComponentListener(new java.awt.event.ComponentAdapter()
		{
			@Override
			public void componentResized(java.awt.event.ComponentEvent e)
			{
				resizeGridToFit();
			}
		});
		boardCard.add(gridWrap);

		// ---- tile detail card ----

		detailCard.add(sectionHeader("Tile"));
		detailCard.add(Box.createVerticalStrut(6));
		detailCard.add(tileDetail);

		// ---- team card ----

		connectButton.addActionListener(e -> toggleTeam());
		connectButton.setToolTipText("Uses the party service to update board state live with teammates who are online");
		storePauseButton.addActionListener(e -> plugin.setStorePaused(!plugin.storePaused()));
		portalButton.addActionListener(e ->
		{
			if (plugin.portalUrl() != null)
			{
				LinkBrowser.browse(plugin.portalUrl());
			}
		});
		syncButton.addActionListener(e ->
		{
			plugin.requestTeamSync();
			startSyncCooldown();
		});
		cooldownTimer = new Timer(1000, e ->
		{
			syncCooldown--;
			if (syncCooldown <= 0)
			{
				((Timer) e.getSource()).stop();
				syncButton.setText("Sync now");
			}
			else
			{
				syncButton.setText("Sync now (" + syncCooldown + ")");
			}
			refreshButtons();
		});

		// Ticks the event countdown once a second; only touches the label when it changes.
		// Also pulses the store's "syncing" dots so a waiting request visibly moves.
		countdownTimer = new Timer(1000, e ->
		{
			String text = plugin.eventStatusText();
			if (!text.equals(eventStatusLabel.getText()))
			{
				eventStatusLabel.setVisible(!text.isEmpty());
				eventStatusLabel.setText(text);
			}
			if (plugin.storeBusy() && plugin.storeConfigured())
			{
				syncPulse = (syncPulse + 1) % 3;
				StringBuilder dots = new StringBuilder();
				for (int i = 0; i <= syncPulse; i++)
				{
					dots.append('.');
				}
				storePauseButton.setText("<html>" + DOT_ORANGE + "Store: Syncing" + dots + "</html>");
			}
		});
		countdownTimer.start();

		JPanel teamBody = sectionBody();
		teamBody.add(Box.createVerticalStrut(6));
		teamBody.add(buttonRow(connectButton));
		teamBody.add(Box.createVerticalStrut(4));
		teamBody.add(buttonRow(storePauseButton));
		teamBody.add(Box.createVerticalStrut(4));
		teamBody.add(buttonRow(syncButton, portalButton));
		teamCard.add(collapsibleHeader("Team", teamBody));
		teamCard.add(teamBody);

		// ---- setup foldout: once-per-event actions, kept away from the daily buttons ----

		chooseTeamButton.addActionListener(e -> chooseTeam());
		setupCard.add(buttonRow(importButton));
		setupCard.add(Box.createVerticalStrut(4));
		setupCard.add(buttonRow(chooseTeamButton));
		wireFoldout(setupToggle, setupCard, "Setup");

		// ---- advanced card ----

		wireFoldout(advancedToggle, advancedCard, "Advanced");

		JButton clearBoardButton = smallButton("Clear board");
		clearBoardButton.addActionListener(e -> clearBoard());

		JButton clearTeamButton = smallButton("Clear cached team data");
		clearTeamButton.setToolTipText("Forget stored teammate progress, e.g. after switching teams");
		clearTeamButton.addActionListener(e ->
		{
			int answer = JOptionPane.showConfirmDialog(this,
				"Forget all cached teammate progress? Online teammates re-send theirs on the next sync.",
				"Irons Pub Bingo", JOptionPane.YES_NO_OPTION);
			if (answer == JOptionPane.YES_OPTION)
			{
				plugin.resetTeamData();
			}
		});

		advancedCard.add(clearBoardButton);
		advancedCard.add(Box.createVerticalStrut(4));
		advancedCard.add(clearTeamButton);
		advancedCard.setVisible(false);

		// ---- layout ----

		// Everything lives inside one content panel so the whole thing can hide while
		// logged out (progress and team state are per-account, so there is nothing
		// meaningful to show or do before login).
		content.setLayout(new BoxLayout(content, BoxLayout.Y_AXIS));
		content.setBackground(ColorScheme.DARK_GRAY_COLOR);
		content.setAlignmentX(LEFT_ALIGNMENT);
		content.add(headerCard);
		content.add(Box.createVerticalStrut(8));
		content.add(boardCard);
		content.add(Box.createVerticalStrut(8));
		content.add(detailCard);
		content.add(Box.createVerticalStrut(8));
		content.add(teamCard);
		content.add(Box.createVerticalStrut(8));
		content.add(setupToggle);
		content.add(Box.createVerticalStrut(4));
		content.add(setupCard);
		content.add(Box.createVerticalStrut(4));
		content.add(advancedToggle);
		content.add(Box.createVerticalStrut(4));
		content.add(advancedCard);

		// ---- info foldout ----

		JButton readmeButton = new JButton("README");
		readmeButton.setToolTipText("How the plugin, teams, store and credit requests work");
		readmeButton.addActionListener(e -> showReadme());
		infoCard.add(buttonRow(readmeButton));
		wireFoldout(infoToggle, infoCard, "Info");
		content.add(Box.createVerticalStrut(4));
		content.add(infoToggle);
		content.add(Box.createVerticalStrut(4));
		content.add(infoCard);

		// ---- logged-out view: shown instead of the content until an account is active ----

		JLabel loggedOutLogo = new JLabel(new ImageIcon(
			ImageUtil.loadImageResource(IronsPubBingoPlugin.class, "logo.png")));
		loggedOutLogo.setAlignmentX(CENTER_ALIGNMENT);
		JLabel loggedOutTitle = new JLabel("Irons Pub Bingo");
		loggedOutTitle.setFont(FontManager.getRunescapeBoldFont());
		loggedOutTitle.setForeground(Color.WHITE);
		loggedOutTitle.setAlignmentX(CENTER_ALIGNMENT);
		BingoWrappedLabel loggedOutText = new BingoWrappedLabel(
			"Log in to get started - your board and team are tied to the account you play on.",
			SwingConstants.CENTER, CONTENT_WIDTH - 16);
		JButton loggedOutReadme = new JButton("README");
		loggedOutReadme.addActionListener(e -> showReadme());
		loggedOutCard.add(loggedOutLogo);
		loggedOutCard.add(Box.createVerticalStrut(8));
		loggedOutCard.add(loggedOutTitle);
		loggedOutCard.add(Box.createVerticalStrut(4));
		loggedOutCard.add(loggedOutText);
		loggedOutCard.add(Box.createVerticalStrut(10));
		// Centered like its siblings: a LEFT_ALIGNMENT row in a centered BoxLayout
		// column gets pushed off to the side.
		JPanel loggedOutReadmeRow = buttonRow(loggedOutReadme);
		loggedOutReadmeRow.setAlignmentX(CENTER_ALIGNMENT);
		loggedOutReadmeRow.setMaximumSize(new Dimension(Integer.MAX_VALUE, 30));
		loggedOutCard.add(loggedOutReadmeRow);

		loggedOutCard.setVisible(false);
		add(loggedOutCard);
		add(content);
	}

	/**
	 * The in-client README: the player-facing half of README.md, wrapped for the
	 * dialog. Keep it in step with the README's Players section when either changes.
	 */
	private void showReadme()
	{
		JTextArea text = new JTextArea(
			"GETTING STARTED\n"
				+ "- Without a team store: Setup -> Import board, paste the code from\n"
				+ "  your host, and put the team code in the settings.\n"
				+ "- With a team store, in order:\n"
				+ "  1. Settings: turn on Use team store, paste the store URL.\n"
				+ "  2. Setup -> Import board -> Import from store.\n"
				+ "  3. Setup -> Choose team, and pick your team from the list.\n"
				+ "- While you set up, the Store line in the Team section shows which\n"
				+ "  step is still missing.\n"
				+ "- Tiles turn amber on progress and green when complete.\n"
				+ "- Click a tile for its goals, who contributed, and its actions\n"
				+ "  (manual tick, credit request, reset).\n"
				+ "\n"
				+ "TEAM PLAY\n"
				+ "- Put the team code from your host in the settings, or pick it with\n"
				+ "  Choose team, then Connect live sync.\n"
				+ "- Progress combines across the team: counts add up, distinct item\n"
				+ "  lists count each item once, manual ticks apply team-wide.\n"
				+ "- Pause store sync stops store traffic without leaving the team.\n"
				+ "\n"
				+ "NOTES\n"
				+ "- Keep the built-in Loot Tracker enabled - chest and raid loot comes\n"
				+ "  from its events.\n"
				+ "- For tiles chasing a specific pet, enable the game setting\n"
				+ "  Collection log - New addition notification.\n"
				+ "- XP and kill-count goals start counting when you import the board.\n"
				+ "- Each team keeps its own progress. Changing your team code (or the\n"
				+ "  store toggle) switches the board to that team - nothing counts for\n"
				+ "  two teams, and coming back restores what you had.\n"
				+ "- Optional: set a Discord webhook to post your completions with a\n"
				+ "  screenshot.\n"
				+ "\n"
				+ "TEAM PORTAL (browser)\n"
				+ "- The team store URL in any browser shows the live board, all credit\n"
				+ "  requests and their status, and a form to request credit with proof\n"
				+ "  links - for mobile players and anyone without the plugin. Open it\n"
				+ "  with the Team section's Portal button.\n"
				+ "- Credit requests count only after an admin approves them.\n"
				+ "\n"
				+ "HOSTS\n"
				+ "- Bingo Forge, the board builder, runs in your browser:\n"
				+ "  https://kaosrichie.github.io/irons-pub-bingo/board-builder.html\n"
				+ "- The full README - board format, every goal type and the team store\n"
				+ "  sheet - is at github.com/KaosRichie/irons-pub-bingo");
		text.setEditable(false);
		text.setFont(FontManager.getRunescapeSmallFont());
		text.setBackground(ColorScheme.DARKER_GRAY_COLOR);
		text.setForeground(ColorScheme.LIGHT_GRAY_COLOR);
		text.setBorder(BorderFactory.createEmptyBorder(8, 8, 8, 8));
		JOptionPane.showMessageDialog(this, text, "Irons Pub Bingo - README", JOptionPane.PLAIN_MESSAGE);
	}

	/** Hand-painted pop-out glyph (window with an arrow to the top right), theme colored. */
	private static Icon popOutIcon()
	{
		BufferedImage image = new BufferedImage(14, 14, BufferedImage.TYPE_INT_ARGB);
		Graphics2D g = image.createGraphics();
		g.setColor(ColorScheme.LIGHT_GRAY_COLOR);
		g.drawRect(0, 3, 10, 10);
		g.drawLine(5, 8, 13, 0);
		g.drawLine(13, 0, 13, 4);
		g.drawLine(13, 0, 9, 0);
		g.dispose();
		return new ImageIcon(image);
	}

	/** Collapsible section: a toggle button revealing a card, like the Advanced foldout. */
	private void wireFoldout(JButton toggle, Card card, String title)
	{
		toggle.setText(title + "  ▸");
		toggle.setFont(FontManager.getRunescapeSmallFont());
		toggle.setAlignmentX(LEFT_ALIGNMENT);
		toggle.setMaximumSize(new Dimension(Integer.MAX_VALUE, 26));
		toggle.setHorizontalAlignment(SwingConstants.LEFT);
		toggle.setFocusable(false);
		card.setVisible(false);
		toggle.addActionListener(e ->
		{
			card.setVisible(!card.isVisible());
			toggle.setText(title + (card.isVisible() ? "  ▾" : "  ▸"));
			revalidate();
			repaint();
		});
	}

	// ---------------------------------------------------------------- small ui helpers

	private static void smallLabel(JLabel label, Color color)
	{
		label.setFont(FontManager.getRunescapeSmallFont());
		label.setForeground(color);
		label.setAlignmentX(LEFT_ALIGNMENT);
	}

	private static JLabel sectionHeader(String text)
	{
		JLabel label = new JLabel(text.toUpperCase());
		label.setFont(FontManager.getRunescapeSmallFont());
		label.setForeground(ColorScheme.BRAND_ORANGE);
		label.setAlignmentX(LEFT_ALIGNMENT);
		return label;
	}

	/**
	 * A key section's header that folds its body when clicked: looks exactly like a
	 * normal section header (plus a small arrow on the right), stays expanded by
	 * default - unlike the plain-button foldouts used for the utility sections.
	 */
	private JPanel collapsibleHeader(String title, JPanel body)
	{
		JPanel header = new JPanel(new java.awt.BorderLayout());
		header.setBackground(ColorScheme.DARKER_GRAY_COLOR);
		header.setAlignmentX(LEFT_ALIGNMENT);
		header.setMaximumSize(new Dimension(Integer.MAX_VALUE, 18));
		header.setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
		JLabel titleLabel = sectionHeader(title);
		JLabel arrow = new JLabel("▾");
		arrow.setFont(FontManager.getRunescapeSmallFont());
		arrow.setForeground(ColorScheme.LIGHT_GRAY_COLOR);
		header.add(titleLabel, java.awt.BorderLayout.CENTER);
		header.add(arrow, java.awt.BorderLayout.EAST);
		MouseAdapter toggle = new MouseAdapter()
		{
			@Override
			public void mousePressed(MouseEvent e)
			{
				body.setVisible(!body.isVisible());
				arrow.setText(body.isVisible() ? "▾" : "▸");
				revalidate();
				repaint();
			}
		};
		header.addMouseListener(toggle);
		titleLabel.addMouseListener(toggle);
		arrow.addMouseListener(toggle);
		return header;
	}

	/** Vertical sub-panel holding a collapsible card's content. */
	private static JPanel sectionBody()
	{
		JPanel body = new JPanel();
		body.setLayout(new BoxLayout(body, BoxLayout.Y_AXIS));
		body.setBackground(ColorScheme.DARKER_GRAY_COLOR);
		body.setAlignmentX(LEFT_ALIGNMENT);
		return body;
	}

	private static JPanel buttonRow(JButton only)
	{
		only.setFocusable(false);
		JPanel row = new JPanel(new GridLayout(1, 1));
		row.setBackground(ColorScheme.DARKER_GRAY_COLOR);
		row.setAlignmentX(LEFT_ALIGNMENT);
		row.setMaximumSize(new Dimension(Integer.MAX_VALUE, 26));
		row.add(only);
		return row;
	}

	private static JPanel buttonRow(JButton left, JButton right)
	{
		left.setFocusable(false);
		right.setFocusable(false);
		JPanel row = new JPanel(new GridLayout(1, 2, 6, 0));
		row.setBackground(ColorScheme.DARKER_GRAY_COLOR);
		row.setAlignmentX(LEFT_ALIGNMENT);
		row.setMaximumSize(new Dimension(Integer.MAX_VALUE, 26));
		row.add(left);
		row.add(right);
		return row;
	}

	private static JButton smallButton(String text)
	{
		JButton button = new JButton(text);
		button.setFont(FontManager.getRunescapeSmallFont());
		button.setAlignmentX(LEFT_ALIGNMENT);
		button.setMaximumSize(new Dimension(Integer.MAX_VALUE, 24));
		button.setFocusable(false);
		return button;
	}

	private void startSyncCooldown()
	{
		syncCooldown = SYNC_COOLDOWN_SECONDS;
		syncButton.setText("Sync now (" + syncCooldown + ")");
		refreshButtons();
		cooldownTimer.restart();
	}

	private void toggleTeam()
	{
		if (plugin.inTeamParty())
		{
			plugin.leaveTeam();
			refresh();
			return;
		}
		if (plugin.inAnyParty())
		{
			int answer = JOptionPane.showConfirmDialog(this,
				"You are in a different RuneLite party. Connecting to your bingo team will leave it. Continue?",
				"Irons Pub Bingo", JOptionPane.YES_NO_OPTION);
			if (answer != JOptionPane.YES_OPTION)
			{
				return;
			}
		}
		String error = plugin.joinTeam();
		if (error != null)
		{
			JOptionPane.showMessageDialog(this, error, "Team sync", JOptionPane.ERROR_MESSAGE);
		}
		refresh();
	}

	/** Stops the panel's Swing timers; called when the plugin shuts down. */
	void stopTimers()
	{
		cooldownTimer.stop();
		countdownTimer.stop();
		tileDetail.stopTimers();
	}

	/** Selects a tile in the detail view (e.g. clicked in the pop-out window). */
	void selectTile(int tileIndex)
	{
		selectedTile = tileIndex;
		refresh();
	}

	int getSelectedTile()
	{
		return selectedTile;
	}

	// ---------------------------------------------------------------- board grid

	/** Rebuilds the grid from scratch (board loaded/cleared). */
	void rebuild()
	{
		BingoBoard board = plugin.getBoard();
		gridContainer.removeAll();
		cells.clear();
		selectedTile = -1;

		if (board == null)
		{
			gridContainer.setLayout(new java.awt.BorderLayout());
			gridContainer.setPreferredSize(new Dimension(CONTENT_WIDTH, 48));
			gridContainer.setMaximumSize(new Dimension(CONTENT_WIDTH, 48));
			BingoWrappedLabel hint = new BingoWrappedLabel(
				"No board loaded.\nAsk your bingo host for the board code and use Import board.", CONTENT_WIDTH);
			gridContainer.add(hint, java.awt.BorderLayout.CENTER);
		}
		else
		{
			int size = board.getSize();
			gridContainer.setLayout(new GridLayout(size, size, 2, 2));
			int width = gridWrap.getWidth() > 0 ? gridWrap.getWidth() : CONTENT_WIDTH;
			lastGridWidth = width;
			gridContainer.setMaximumSize(new Dimension(width, width));
			gridContainer.setPreferredSize(new Dimension(width, width));

			int cellSize = width / size;
			for (int i = 0; i < size * size; i++)
			{
				final int tileIndex = i;
				BingoTile tile = board.getTiles().get(i);
				BingoTileCell cell = new BingoTileCell();
				JLabel content = new JLabel(String.valueOf(i + 1), SwingConstants.CENTER);
				content.setFont(FontManager.getRunescapeSmallFont());
				content.setForeground(new Color(255, 255, 255, 140));
				AsyncBufferedImage itemIcon = plugin.iconFor(tile);
				if (itemIcon != null)
				{
					content.setText(null);
					BingoUi.applyIcon(content, itemIcon, Math.min(cellSize - 4, 32), cell);
				}
				cell.add(content, java.awt.BorderLayout.CENTER);
				cell.setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
				cell.addMouseListener(new MouseAdapter()
				{
					@Override
					public void mousePressed(MouseEvent e)
					{
						selectedTile = tileIndex;
						refresh();
						plugin.refreshBoardWindow();
					}
				});
				cells.add(cell);
				gridContainer.add(cell);
			}
		}

		refresh();
		revalidate();
		repaint();
	}

	/** Updates colors, labels and the detail view for current progress. */
	void refresh()
	{
		// Progress and team state are per-account: hide everything until login.
		boolean loggedIn = plugin.isLoggedIn();
		loggedOutCard.setVisible(!loggedIn);
		content.setVisible(loggedIn);
		if (!loggedIn)
		{
			revalidate();
			repaint();
			return;
		}
		BingoBoard board = plugin.getBoard();
		String eventText = plugin.eventStatusText();
		eventStatusLabel.setVisible(!eventText.isEmpty());
		eventStatusLabel.setText(eventText);
		eventStatusLabel.setToolTipText(plugin.eventWindowTooltip());
		String updateNotice = plugin.boardUpdateNotice();
		boardUpdateLabel.setVisible(updateNotice != null);
		boardUpdateLabel.setText(updateNotice == null ? "" : updateNotice);
		if (!fetchingTeams)
		{
			chooseTeamButton.setEnabled(plugin.storeConfigured());
			chooseTeamButton.setToolTipText(plugin.storeConfigured()
				? "Pick your team from the list the host defined on the team store sheet"
				: "Needs the team store: turn on 'Use team store' and set the URL in the settings");
		}
		String teamName = plugin.teamDisplayName();
		String teamMode = plugin.teamModeText();
		teamNameLabel.setVisible(teamName != null);
		teamNameLabel.setText(teamName == null ? "" : "Team: " + teamName);
		teamNameLabel.setToolTipText(teamMode == null ? null
			: "store team".equals(teamMode)
				? "Store team - this team is on the host's team list; progress syncs live and via the team store"
				: "Custom team - this code isn't on the host's team list; progress syncs live (party) only, never to the store. Use Choose team (Setup) to pick a store team.");
		if (board == null)
		{
			boardNameLabel.setText("No board loaded");
		}
		else
		{
			boardNameLabel.setText(plugin.boardTitleText());

			boolean drawLines = plugin.lineDisplay() == LineDisplay.LINES;
			boolean fillMode = plugin.progressFill();
			gridContainer.setLines(board.getSize(),
				drawLines ? plugin.completedLineSegments() : java.util.Collections.emptyList());
			Set<Integer> lineCells = drawLines ? java.util.Collections.emptySet() : plugin.completedLineCells();
			for (int i = 0; i < cells.size(); i++)
			{
				BingoTile tile = board.getTiles().get(i);
				BingoTileCell cell = cells.get(i);
				boolean complete = plugin.isTileComplete(i);
				cell.setBackground(complete ? BingoUi.COLOR_COMPLETE
					: !fillMode && hasProgress(tile, i) ? BingoUi.COLOR_PARTIAL : BingoUi.COLOR_EMPTY);
				cell.setFillFraction(complete || !fillMode ? 0f : (float) plugin.tileProgressFraction(i));
				Color border = i == selectedTile ? Color.WHITE
					: lineCells.contains(i) ? BingoUi.COLOR_LINE
					: ColorScheme.DARKER_GRAY_HOVER_COLOR;
				cell.setBorder(BorderFactory.createLineBorder(border,
					i == selectedTile || lineCells.contains(i) ? 2 : 1));
				cell.setToolTipText("<html><b>" + BingoUi.escapeHtml(tile.label) + "</b>"
					+ (tile.pointsValue() > 0 ? " (" + tile.pointsValue() + " pts)" : "") + "<br>"
					+ (complete ? "Complete" : goalSummary(tile, i)) + "</html>");
			}
		}

		refreshButtons();
		refreshPointsLine();
		rebuildDetail();
		revalidate();
		repaint();
	}

	private void refreshButtons()
	{
		// The live and store buttons ARE the status: blip + state as text, click to act.
		String liveDot = plugin.inTeamParty() ? DOT_GREEN
			: plugin.inAnyParty() ? DOT_ORANGE : DOT_GRAY;
		connectButton.setText("<html>" + liveDot + "Live sync: "
			+ BingoUi.escapeHtml(plugin.teamStatusText()) + "</html>");

		// Amber, not red, for a failed attempt that has succeeded before: nothing is
		// lost, the next sync resends everything.
		// Green means "syncing fine". A missing board or team is not an error, but it is
		// not fine either - amber, matching the text the button shows.
		String storeDot = !plugin.storeConfigured() ? DOT_GRAY
			: plugin.storePaused() ? DOT_GRAY
			: plugin.storeBusy() ? DOT_ORANGE
			: plugin.storeSetupHint() != null ? DOT_ORANGE
			: !plugin.storeHasError() ? (plugin.storeEverSynced() ? DOT_GREEN : DOT_ORANGE)
			: plugin.storeEverSynced() ? DOT_ORANGE : DOT_RED;
		storePauseButton.setText("<html>" + storeDot
			+ BingoUi.escapeHtml(storeButtonState()) + "</html>");
		storePauseButton.setEnabled(plugin.storeConfigured());

		syncButton.setEnabled(plugin.getBoard() != null && syncCooldown <= 0);
		portalButton.setEnabled(plugin.portalUrl() != null);
	}

	/** Squares the board to the card's current inner width (the sidebar is resizable). */
	private void resizeGridToFit()
	{
		int width = gridWrap.getWidth();
		if (width <= 0 || width == lastGridWidth || plugin.getBoard() == null)
		{
			return;
		}
		lastGridWidth = width;
		gridContainer.setPreferredSize(new Dimension(width, width));
		gridContainer.setMaximumSize(new Dimension(width, width));
		gridContainer.revalidate();
		gridContainer.repaint();
	}

	/** Compact store state for the button; the tooltip carries the full detail. */
	private String storeButtonState()
	{
		if (!plugin.storeConfigured())
		{
			return "Store: Off";
		}
		if (plugin.storePaused())
		{
			return "Store: Paused";
		}
		if (plugin.storeBusy())
		{
			return "Store: Syncing...";
		}
		// A next step to take beats a bare "waiting" or "error".
		String hint = plugin.storeSetupHint();
		if (hint != null)
		{
			return "Store: " + hint;
		}
		if (plugin.storeHasError())
		{
			return "Store: " + plugin.storeErrorShort();
		}
		String syncedAt = plugin.storeSyncedAtText();
		return syncedAt == null ? "Store: Not synced yet" : "Store: Synced " + syncedAt;
	}

	/** Fetches the host-defined team list from the store and lets the player pick one. */
	private void chooseTeam()
	{
		if (!plugin.storeConfigured())
		{
			return; // button is disabled in this state; belt and braces
		}
		fetchingTeams = true;
		chooseTeamButton.setEnabled(false);
		chooseTeamButton.setText("Fetching teams...");
		plugin.fetchStoreTeams((teams, error) -> SwingUtilities.invokeLater(() ->
		{
			fetchingTeams = false;
			chooseTeamButton.setEnabled(true);
			chooseTeamButton.setText("Choose team");
			if (error != null || teams == null)
			{
				JOptionPane.showMessageDialog(this,
					"Could not fetch the team list: " + (error == null ? "unexpected reply" : error),
					"Irons Pub Bingo", JOptionPane.WARNING_MESSAGE);
				return;
			}
			if (teams.isEmpty())
			{
				JOptionPane.showMessageDialog(this,
					"The host hasn't listed any teams on the sheet (Teams tab) yet.\n"
						+ "The store accepts no progress until they do - ask your host.",
					"Irons Pub Bingo", JOptionPane.INFORMATION_MESSAGE);
				return;
			}
			String[] labels = new String[teams.size()];
			for (int i = 0; i < teams.size(); i++)
			{
				BingoTeamStore.TeamInfo team = teams.get(i);
				labels[i] = team.name == null || team.name.isEmpty()
					? team.code : team.name + "  (" + team.code + ")";
			}
			JComboBox<String> box = new JComboBox<>(labels);
			int answer = JOptionPane.showConfirmDialog(this, box, "Choose your team",
				JOptionPane.OK_CANCEL_OPTION, JOptionPane.PLAIN_MESSAGE);
			if (answer == JOptionPane.OK_OPTION)
			{
				plugin.setTeamCode(teams.get(box.getSelectedIndex()).code);
			}
		}));
	}

	/** Header points line: "23 / 219 pts", plus a medal + colored placement on store events. */
	private void refreshPointsLine()
	{
		boolean show = plugin.getBoard() != null && plugin.totalBoardPoints() > 0;
		pointsLabel.setVisible(show);
		if (!show)
		{
			return;
		}
		int rank = plugin.placementRank();
		String text = plugin.earnedPoints() + " / " + plugin.totalBoardPoints() + " pts";
		if (rank > 0)
		{
			String color = rank == 1 ? "#ffd700" : rank == 2 ? "#e8e8e8" : rank == 3 ? "#d78d4a" : "#ffffff";
			text = "<html>" + text + "  &#183;  <font color='" + color + "'>" + ordinal(rank) + "</font></html>";
		}
		pointsLabel.setText(text);
		pointsLabel.setIcon(rank == 1 ? MEDAL_GOLD : rank == 2 ? MEDAL_SILVER : rank == 3 ? MEDAL_BRONZE : null);
	}

	private static String ordinal(int n)
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

	/** A little medal: rimmed disc with a centered, faded inner ring and a top-left shine. */
	private static Icon medalIcon(Color base, Color rim)
	{
		// 9px medal on an 11px-tall canvas: the 2 transparent bottom rows lift the disc
		// so its center lines up with the digits' visual center (the label centers the
		// icon on the full line height, descent included, which otherwise sits it low).
		BufferedImage image = new BufferedImage(9, 11, BufferedImage.TYPE_INT_ARGB);
		Graphics2D g = image.createGraphics();
		g.setRenderingHint(java.awt.RenderingHints.KEY_ANTIALIASING,
			java.awt.RenderingHints.VALUE_ANTIALIAS_ON);
		// Float geometry so everything shares the exact center (4.5, 4.5).
		g.setColor(rim);
		g.fill(new java.awt.geom.Ellipse2D.Float(0.5f, 0.5f, 8f, 8f));
		g.setColor(base);
		g.fill(new java.awt.geom.Ellipse2D.Float(1.3f, 1.3f, 6.4f, 6.4f));
		g.setColor(new Color(rim.getRed(), rim.getGreen(), rim.getBlue(), 110));
		g.draw(new java.awt.geom.Ellipse2D.Float(2.2f, 2.2f, 4.6f, 4.6f));
		g.setColor(new Color(255, 255, 255, 180));
		g.fill(new java.awt.geom.Ellipse2D.Float(2.1f, 1.7f, 1.7f, 1.2f));
		g.dispose();
		return new ImageIcon(image);
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

	private String goalSummary(BingoTile tile, int tileIndex)
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

	// ---------------------------------------------------------------- tile detail

	private void rebuildDetail()
	{
		tileDetail.setSelectedTile(selectedTile);
		detailCard.setVisible(tileDetail.rebuild());
	}

	// ---------------------------------------------------------------- dialogs

	private void importBoard()
	{
		JTextArea textArea = new JTextArea(12, 28);
		textArea.setLineWrap(true);
		JScrollPane scroll = new JScrollPane(textArea);

		// The box always opens empty: filling it is an explicit click (store, paste)
		// or typing - no silent clipboard peeking.
		JButton pasteButton = new JButton("Paste from clipboard");
		pasteButton.setFocusable(false);
		pasteButton.addActionListener(e ->
		{
			String text = readClipboard();
			if (text == null || text.trim().isEmpty())
			{
				JOptionPane.showMessageDialog(textArea, "The clipboard is empty.",
					"Irons Pub Bingo", JOptionPane.INFORMATION_MESSAGE);
				return;
			}
			textArea.setText(text.trim());
			textArea.setCaretPosition(0);
		});

		// Fills the text box from the store's Board code tab - the import itself still
		// goes through the same OK button as a hand-pasted code.
		JButton storeButton = new JButton("Import from store");
		storeButton.setFocusable(false);
		storeButton.setEnabled(plugin.storeConfigured());
		storeButton.addActionListener(e ->
		{
			storeButton.setEnabled(false);
			storeButton.setText("Fetching from store...");
			plugin.fetchStoreBoard((json, error) -> SwingUtilities.invokeLater(() ->
			{
				storeButton.setEnabled(plugin.storeConfigured());
				storeButton.setText("Import from store");
				if (error != null || json == null)
				{
					JOptionPane.showMessageDialog(textArea,
						"Could not get the board: " + (error == null ? "unexpected reply" : error),
						"Irons Pub Bingo", JOptionPane.WARNING_MESSAGE);
					return;
				}
				textArea.setText(json);
				textArea.setCaretPosition(0);
			}));
		});

		JPanel buttons = new JPanel(new GridLayout(2, 1, 0, 4));
		buttons.add(storeButton);
		buttons.add(pasteButton);

		JPanel content = new JPanel(new java.awt.BorderLayout(0, 6));
		content.add(buttons, java.awt.BorderLayout.NORTH);
		content.add(scroll, java.awt.BorderLayout.CENTER);

		int answer = JOptionPane.showConfirmDialog(this, content,
			"Paste the board code (JSON) from your bingo host", JOptionPane.OK_CANCEL_OPTION,
			JOptionPane.PLAIN_MESSAGE);
		if (answer != JOptionPane.OK_OPTION)
		{
			return;
		}
		String json = textArea.getText();
		if (json == null || json.trim().isEmpty())
		{
			return;
		}
		String error = plugin.loadBoardFromJson(json.trim());
		if (error != null)
		{
			JOptionPane.showMessageDialog(this, error, "Board could not be loaded", JOptionPane.ERROR_MESSAGE);
			return;
		}
		rebuild();

		List<String> notes = plugin.lintBoard();
		if (!notes.isEmpty())
		{
			JTextArea noteArea = new JTextArea(String.join("\n\n", notes), Math.min(12, notes.size() * 3), 28);
			noteArea.setLineWrap(true);
			noteArea.setWrapStyleWord(true);
			noteArea.setEditable(false);
			JOptionPane.showMessageDialog(this, new JScrollPane(noteArea),
				"Board loaded, with " + notes.size() + (notes.size() == 1 ? " note" : " notes"),
				JOptionPane.WARNING_MESSAGE);
		}
	}

	private static String readClipboard()
	{
		try
		{
			Object data = java.awt.Toolkit.getDefaultToolkit().getSystemClipboard()
				.getData(java.awt.datatransfer.DataFlavor.stringFlavor);
			return data instanceof String ? (String) data : null;
		}
		catch (java.awt.datatransfer.UnsupportedFlavorException | java.io.IOException
			| IllegalStateException e)
		{
			return null;
		}
	}


	private void clearBoard()
	{
		if (plugin.getBoard() == null)
		{
			return;
		}
		int answer = JOptionPane.showConfirmDialog(this,
			"Remove the current board? Tracked progress stays saved and returns if you re-import the same board.",
			"Irons Pub Bingo", JOptionPane.YES_NO_OPTION);
		if (answer == JOptionPane.YES_OPTION)
		{
			plugin.clearBoard();
			rebuild();
		}
	}
}

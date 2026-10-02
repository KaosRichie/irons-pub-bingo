package com.ironspubbingo;

import java.awt.Color;
import java.awt.Dimension;
import java.awt.GridLayout;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import javax.swing.BorderFactory;
import javax.swing.Box;
import javax.swing.BoxLayout;
import javax.swing.JButton;
import javax.swing.JCheckBox;
import javax.swing.JComboBox;
import javax.swing.JLabel;
import javax.swing.JOptionPane;
import javax.swing.JPanel;
import javax.swing.JTextField;
import javax.swing.SwingConstants;
import javax.swing.SwingUtilities;
import javax.swing.Timer;
import net.runelite.client.ui.ColorScheme;
import net.runelite.client.ui.FontManager;
import net.runelite.client.ui.components.ProgressBar;
import net.runelite.client.util.AsyncBufferedImage;

/**
 * The tile detail view: title, goals with progress bars, per-member bars, and the
 * Details/Actions foldouts. One instance lives in the sidebar panel and another under
 * the pop-out board, so both surfaces show the same thing and stay in sync.
 */
class BingoTileDetail extends JPanel
{
	/** Name suffix the team store puts on admin-credited members. */
	private static final String VERIFIED_SUFFIX = " (verified)";

	private final IronsPubBingoPlugin plugin;
	private final int widthBasis;

	private int selectedTile = -1;
	private boolean detailsExpanded;
	private boolean actionsExpanded;
	/** Goals whose contributor rows are unfolded (click the goal's bar to toggle). */
	private final java.util.Set<Integer> expandedGoals = new java.util.HashSet<>();
	/** A credit request is on its way to the store; the button says so meanwhile. */
	private boolean requestInFlight;

	BingoTileDetail(IronsPubBingoPlugin plugin, int widthBasis)
	{
		this.plugin = plugin;
		this.widthBasis = widthBasis;
		setLayout(new BoxLayout(this, BoxLayout.Y_AXIS));
		setBackground(ColorScheme.DARKER_GRAY_COLOR);
		setAlignmentX(LEFT_ALIGNMENT);
	}

	void setSelectedTile(int tileIndex)
	{
		selectedTile = tileIndex;
	}

	/**
	 * Rebuilds the view for the current selection.
	 *
	 * @return whether there is a tile to show (drives the surrounding card's visibility)
	 */
	boolean rebuild()
	{
		removeAll();
		BingoBoard board = plugin.getBoard();
		boolean show = board != null && selectedTile >= 0 && selectedTile < board.getTiles().size();
		setVisible(show);
		if (!show)
		{
			return false;
		}

		BingoTile tile = board.getTiles().get(selectedTile);
		// A completed tile shows the snapshot from the moment it completed.
		TileProgress merged = plugin.displayProgressFor(selectedTile);
		TileProgress own = plugin.progressFor(selectedTile);
		boolean teamView = plugin.hasTeamData();
		Map<String, TileProgress> members = teamView ? plugin.memberProgressFor(selectedTile) : null;

		BingoWrappedLabel titleLabel = new BingoWrappedLabel(
			(plugin.showTileNumbers() ? (selectedTile + 1) + ". " : "") + tile.label, widthBasis - 44);
		titleLabel.setFont(FontManager.getRunescapeBoldFont());
		titleLabel.setForeground(Color.WHITE);
		AsyncBufferedImage itemIcon = plugin.iconFor(tile);
		if (itemIcon == null)
		{
			add(titleLabel);
		}
		else
		{
			// Fixed wrap width beside the icon: deriving it from the layout would measure
			// once before and once after the icon's width is known, and a title sitting on
			// a wrap boundary would visibly twitch between one and two lines.
			JLabel iconLabel = new JLabel();
			BingoUi.applyIcon(iconLabel, itemIcon, 32, this);
			titleLabel.setWrapWidth(widthBasis - 44);
			JPanel titleRow = new JPanel(new java.awt.BorderLayout(8, 0));
			titleRow.setBackground(ColorScheme.DARKER_GRAY_COLOR);
			titleRow.setAlignmentX(LEFT_ALIGNMENT);
			titleRow.setMaximumSize(new Dimension(Integer.MAX_VALUE, 40));
			titleRow.add(iconLabel, java.awt.BorderLayout.WEST);
			titleRow.add(titleLabel, java.awt.BorderLayout.CENTER);
			add(titleRow);
		}

		if (tile.pointsValue() > 0 || tile.goals.size() > 1)
		{
			StringBuilder meta = new StringBuilder();
			if (tile.pointsValue() > 0)
			{
				meta.append(tile.pointsValue()).append(" pts");
			}
			if (tile.goals.size() > 1)
			{
				if (meta.length() > 0)
				{
					meta.append("  ·  ");
				}
				meta.append(tile.anyMode ? "Complete ANY goal" : "Complete ALL goals");
			}
			BingoWrappedLabel metaLabel = new BingoWrappedLabel(meta.toString(), widthBasis);
			metaLabel.setForeground(ColorScheme.BRAND_ORANGE);
			add(Box.createVerticalStrut(2));
			add(metaLabel);
		}

		if (tile.description != null && !tile.description.trim().isEmpty())
		{
			BingoWrappedLabel desc = new BingoWrappedLabel(tile.description.trim(), widthBasis);
			add(Box.createVerticalStrut(4));
			add(desc);
		}

		// A manual tick overrides the bars visually; the tracked numbers underneath are
		// untouched, so unticking shows the real progress again.
		boolean ticked = merged.manual;

		add(Box.createVerticalStrut(6));
		for (int g = 0; g < tile.goals.size(); g++)
		{
			BingoGoal goal = tile.goals.get(g);
			GoalProgress p = merged.goal(g, tile.goals.size());
			boolean done = ticked || goal.isComplete(p);
			if (g > 0)
			{
				add(Box.createVerticalStrut(6));
			}

			BingoWrappedLabel goalLabel = new BingoWrappedLabel(goal.shortDescribe(), widthBasis);
			goalLabel.setForeground(done ? BingoUi.COLOR_GOAL_DONE : ColorScheme.LIGHT_GRAY_COLOR);
			if (goal.hasExtraDetail())
			{
				goalLabel.setToolTipText(goal.describe());
			}
			add(goalLabel);

			if (goal.goalType == GoalType.MANUAL)
			{
				ProgressBar manualBar = progressBar(ticked ? 1 : 0, 1, 18);
				manualBar.setCenterLabel(ticked ? "1 / 1" : "0 / 1");
				add(manualBar);
				continue;
			}

			long target = goal.target();
			long tracked = Math.min(goal.progressOf(p), target);
			long value = ticked ? target : tracked;
			// Keep the real numbers visible on an overridden bar.
			String centerLabel = ticked && tracked < target
				? "Ticked  (" + formatCount(tracked) + " / " + formatCount(target) + ")"
				: formatCount(value) + " / " + formatCount(target);

			// Who contributed what, largest share first. The goal bar is painted in one
			// segment per contributor and unfolds their rows when clicked, so the
			// contributions live on the bar itself instead of behind a separate toggle.
			List<MemberBar> bars = new ArrayList<>();
			List<GoalBar.Segment> segments = new ArrayList<>();
			if (teamView)
			{
				final int goalIndex = g;
				final int goalCount = tile.goals.size();
				List<Map.Entry<String, TileProgress>> ordered = new ArrayList<>(members.entrySet());
				ordered.sort((a, b) -> Long.compare(
					goal.progressOf(b.getValue().goal(goalIndex, goalCount)),
					goal.progressOf(a.getValue().goal(goalIndex, goalCount))));
				for (Map.Entry<String, TileProgress> entry : ordered)
				{
					long share = goal.progressOf(entry.getValue().goal(goalIndex, goalCount));
					if (share <= 0)
					{
						continue;
					}
					String memberName = entry.getKey();
					boolean verified = memberName.endsWith(VERIFIED_SUFFIX);
					if (verified)
					{
						// The "(verified)" suffix would eat the name's space - a
						// checkmark says the same thing.
						memberName = memberName.substring(0,
							memberName.length() - VERIFIED_SUFFIX.length()) + verifiedMark();
					}
					segments.add(new GoalBar.Segment(memberName, share));
					// Hand-painted: RuneLite's ProgressBar gives its left label only a
					// third of the width, truncating names long before space runs out.
					MemberBar memberBar = new MemberBar(memberName, formatCount(share),
						Math.min(1f, share / (float) target), widthBasis);
					if (verified)
					{
						memberBar.setToolTipText("Credited by an admin on the team sheet (verified progress)");
					}
					bars.add(memberBar);
				}
			}
			final int goalIdx = g;
			boolean expanded = expandedGoals.contains(goalIdx);
			GoalBar bar = new GoalBar(value, target, centerLabel, ticked ? new ArrayList<>() : segments,
				bars.isEmpty() ? null : expanded, widthBasis);
			bar.setToolTipText(barTooltip(goal, segments));
			if (!bars.isEmpty())
			{
				bar.addMouseListener(new java.awt.event.MouseAdapter()
				{
					@Override
					public void mouseClicked(java.awt.event.MouseEvent e)
					{
						if (!expandedGoals.remove(goalIdx))
						{
							expandedGoals.add(goalIdx);
						}
						rebuild();
						revalidate();
						repaint();
					}
				});
			}
			add(bar);
			if (expanded)
			{
				for (MemberBar memberRow : bars)
				{
					add(Box.createVerticalStrut(2));
					add(memberRow);
				}
			}
		}

		// Who ticked the tile sits right under the bars, before any foldouts.
		if (teamView && merged.manual)
		{
			StringBuilder tickedBy = new StringBuilder();
			for (Map.Entry<String, TileProgress> entry : members.entrySet())
			{
				if (entry.getValue().manual)
				{
					if (tickedBy.length() > 0)
					{
						tickedBy.append(", ");
					}
					tickedBy.append(entry.getKey());
				}
			}
			BingoWrappedLabel tickedByLabel = new BingoWrappedLabel("Ticked off by: " + tickedBy, widthBasis);
			add(Box.createVerticalStrut(2));
			add(tickedByLabel);
		}

		// Long item and source lists live behind a toggle - but only when the goal labels
		// don't already say everything, so simple tiles stay clutter-free.
		// Each entry is {full goal description or null, received items or null}.
		List<String[]> extraInfo = new ArrayList<>();
		for (int g = 0; g < tile.goals.size(); g++)
		{
			BingoGoal goal = tile.goals.get(g);
			GoalProgress p = merged.goal(g, tile.goals.size());
			String description = goal.hasExtraDetail() ? goal.describe() : null;
			String received = null;
			if (goal.usesMatchedSet() && p.matched != null && !p.matched.isEmpty())
			{
				received = "Received: " + String.join(", ", sortedNames(p.matched));
			}
			else if (p.got != null && !p.got.isEmpty())
			{
				// Counted drops: "Uncut onyx x2, Zulrah's scales x300", biggest first.
				List<Map.Entry<String, Long>> entries = new ArrayList<>(p.got.entrySet());
				entries.sort((a, b) -> Long.compare(b.getValue(), a.getValue()));
				StringBuilder list = new StringBuilder("Received: ");
				for (int i = 0; i < entries.size(); i++)
				{
					list.append(i > 0 ? ", " : "").append(entries.get(i).getKey());
					if (entries.get(i).getValue() > 1)
					{
						list.append(" x").append(formatCount(entries.get(i).getValue()));
					}
				}
				received = list.toString();
			}
			if (description != null || received != null)
			{
				extraInfo.add(new String[]{description, received});
			}
		}

		if (!extraInfo.isEmpty())
		{
			add(Box.createVerticalStrut(6));
			JButton detailsToggle = smallButton(detailsExpanded ? "Details  ▾" : "Details  ▸");
			detailsToggle.setHorizontalAlignment(SwingConstants.LEFT);
			detailsToggle.addActionListener(e ->
			{
				detailsExpanded = !detailsExpanded;
				rebuild();
				revalidate();
				repaint();
			});
			add(detailsToggle);

			if (detailsExpanded)
			{
				for (int i = 0; i < extraInfo.size(); i++)
				{
					String[] info = extraInfo.get(i);
					int topGap = i == 0 ? 4 : 6;
					if (info[0] != null)
					{
						BingoWrappedLabel infoLabel = new BingoWrappedLabel(info[0], widthBasis - 8);
						infoLabel.setBorder(BorderFactory.createEmptyBorder(topGap, 8, 0, 0));
						add(infoLabel);
						topGap = 0;
					}
					if (info[1] != null)
					{
						BingoWrappedLabel receivedLabel = new BingoWrappedLabel(info[1], widthBasis - 8);
						receivedLabel.setForeground(BingoUi.COLOR_GOAL_DONE);
						receivedLabel.setBorder(BorderFactory.createEmptyBorder(topGap, 8, 0, 0));
						add(receivedLabel);
					}
				}
			}
		}

		add(Box.createVerticalStrut(6));

		// On a store team every completion claim goes through an admin, so the manual
		// tick disappears entirely - a self-serve tick would bypass the review the
		// Requests tab exists for. Party-only teams keep it (there is no reviewer).
		final int tileIndex = selectedTile;
		final boolean ownTicked = own.manual;
		JButton tick = null;
		if (!plugin.storeConfigured())
		{
			tick = smallButton(ownTicked ? "Remove manual tick" : "Tick off tile (manual)");
			tick.setToolTipText(ownTicked
				? "Un-tick this tile (your manual completion is removed team-wide)"
				: "Mark this tile completed by hand (for tiles the tracker can't count)");
			tick.addActionListener(e -> plugin.setManualComplete(tileIndex, !ownTicked));
		}

		JButton request = smallButton(requestInFlight ? "Sending request..." : "Request admin credit");
		request.setEnabled(plugin.storeConfigured() && !requestInFlight);
		request.addActionListener(e -> requestCredit(tileIndex, tile));

		JButton reset = smallButton("Reset tile progress");
		reset.addActionListener(e ->
		{
			int answer = JOptionPane.showConfirmDialog(this,
				"Reset all tracked progress on this tile?", "Irons Pub Bingo", JOptionPane.YES_NO_OPTION);
			if (answer == JOptionPane.YES_OPTION)
			{
				plugin.resetTileProgress(tileIndex);
			}
		});

		// All tile actions behind one foldout; its state survives the constant detail
		// rebuilds via the actionsExpanded field.
		JButton actionsToggle = smallButton("Actions  " + (actionsExpanded ? "▾" : "▸"));
		actionsToggle.setHorizontalAlignment(SwingConstants.LEFT);
		JPanel actionsCard = new JPanel();
		actionsCard.setLayout(new BoxLayout(actionsCard, BoxLayout.Y_AXIS));
		actionsCard.setBackground(ColorScheme.DARKER_GRAY_COLOR);
		actionsCard.setAlignmentX(LEFT_ALIGNMENT);
		if (tick != null)
		{
			actionsCard.add(tick);
			actionsCard.add(Box.createVerticalStrut(4));
		}
		actionsCard.add(request);
		actionsCard.add(Box.createVerticalStrut(4));
		actionsCard.add(reset);
		actionsCard.setVisible(actionsExpanded);
		actionsToggle.addActionListener(e ->
		{
			actionsExpanded = !actionsCard.isVisible();
			actionsCard.setVisible(actionsExpanded);
			actionsToggle.setText("Actions  " + (actionsExpanded ? "▾" : "▸"));
			revalidate();
			repaint();
		});
		add(actionsToggle);
		add(Box.createVerticalStrut(4));
		add(actionsCard);
		return true;
	}

	/** Dialog for a credit request: amount or completion, plus a note for the admin. */
	private void requestCredit(int tileIndex, BingoTile tile)
	{
		JPanel form = new JPanel(new GridLayout(0, 1, 0, 4));
		JComboBox<String> goalBox = null;
		if (tile.goals.size() > 1)
		{
			String[] labels = new String[tile.goals.size()];
			for (int g = 0; g < tile.goals.size(); g++)
			{
				labels[g] = (g + 1) + ". " + tile.goals.get(g).shortDescribe();
			}
			goalBox = new JComboBox<>(labels);
			form.add(new JLabel("Goal:"));
			form.add(goalBox);
		}
		JTextField amount = new JTextField();
		JCheckBox complete = new JCheckBox("Mark the whole tile complete instead");
		JTextField note = new JTextField();
		JTextField links = new JTextField();
		JCheckBox proofShot = new JCheckBox("Attach a screenshot (posts to your Discord webhook)");
		proofShot.setEnabled(plugin.webhookConfigured());
		proofShot.setToolTipText(plugin.webhookConfigured()
			? "Screenshots the game, posts it to your Discord webhook and files its link as proof"
			: "Set a Discord webhook in the settings first");
		form.add(new JLabel("Amount to credit (e.g. 40):"));
		form.add(amount);
		form.add(complete);
		form.add(new JLabel("Note for the admin (e.g. laps 0 to 40):"));
		form.add(note);
		form.add(new JLabel("Proof link(s) - screenshots on Discord/Imgur:"));
		form.add(links);
		form.add(proofShot);

		int answer = JOptionPane.showConfirmDialog(this, form,
			"Request admin credit - " + tile.label, JOptionPane.OK_CANCEL_OPTION, JOptionPane.PLAIN_MESSAGE);
		if (answer != JOptionPane.OK_OPTION)
		{
			return;
		}
		Long add = null;
		String amountText = amount.getText().trim();
		if (!amountText.isEmpty())
		{
			try
			{
				add = Long.parseLong(amountText);
			}
			catch (NumberFormatException e)
			{
				add = -1L;
			}
			if (add <= 0)
			{
				JOptionPane.showMessageDialog(this, "Amount must be a whole number above 0.",
					"Irons Pub Bingo", JOptionPane.WARNING_MESSAGE);
				return;
			}
		}
		if (add == null && !complete.isSelected())
		{
			JOptionPane.showMessageDialog(this,
				"Fill in an amount, or tick \"mark the whole tile complete\".",
				"Irons Pub Bingo", JOptionPane.WARNING_MESSAGE);
			return;
		}
		Integer goalIndex = goalBox == null ? null : goalBox.getSelectedIndex();
		requestInFlight = true;
		rebuild();
		revalidate();
		repaint();
		final Long addFinal = add;
		final String noteText = note.getText().trim();
		final String manualLinks = links.getText().trim();
		if (proofShot.isSelected())
		{
			// Screenshot first, so its Discord link rides along as a proof link. A failed
			// screenshot never blocks the request itself.
			String what = complete.isSelected() ? "tile complete" : "+" + addFinal;
			String goalPart = goalIndex == null ? ""
				: " on goal " + (goalIndex + 1) + " (" + tile.goals.get(goalIndex).shortDescribe() + ")";
			String detail = tile.label + " (" + what + goalPart + ")";
			plugin.postProofScreenshot(detail, (link, shotError) -> SwingUtilities.invokeLater(() ->
				sendRequest(tileIndex, goalIndex, addFinal, complete.isSelected(), noteText,
					link == null ? manualLinks : manualLinks.isEmpty() ? link : manualLinks + " " + link,
					shotError)));
		}
		else
		{
			sendRequest(tileIndex, goalIndex, addFinal, complete.isSelected(), noteText, manualLinks, null);
		}
	}

	private void sendRequest(int tileIndex, Integer goalIndex, Long add, boolean complete,
		String note, String links, String screenshotError)
	{
		plugin.submitCreditRequest(tileIndex, goalIndex, add, complete, note, links,
			(ok, error) -> SwingUtilities.invokeLater(() ->
			{
				requestInFlight = false;
				rebuild();
				revalidate();
				repaint();
				String message = ok ? "Request sent - a team admin will review it on the sheet."
					: "Could not send the request: " + error;
				if (ok && screenshotError != null)
				{
					message += "\nThe screenshot didn't attach (" + screenshotError
						+ ") - add a proof link yourself if the admin needs one.";
				}
				JOptionPane.showMessageDialog(this, message, "Irons Pub Bingo",
					ok && screenshotError == null ? JOptionPane.INFORMATION_MESSAGE : JOptionPane.WARNING_MESSAGE);
			}));
	}

	/**
	 * A thin per-member bar: fill fraction behind, name left, count right. The name gets
	 * every pixel the count doesn't need (clipped with ".." only when truly out of room).
	 */
	private static class MemberBar extends JPanel
	{
		private final String name;
		private final String count;
		private final float fraction;

		MemberBar(String name, String count, float fraction, int widthBasis)
		{
			this.name = name;
			this.count = count;
			this.fraction = fraction;
			setPreferredSize(new Dimension(widthBasis, 14));
			setMaximumSize(new Dimension(Integer.MAX_VALUE, 14));
			setMinimumSize(new Dimension(40, 14));
			setAlignmentX(LEFT_ALIGNMENT);
			setFont(FontManager.getRunescapeSmallFont());
		}

		@Override
		protected void paintComponent(java.awt.Graphics g)
		{
			super.paintComponent(g);
			int w = getWidth();
			int h = getHeight();
			g.setColor(ColorScheme.DARK_GRAY_COLOR);
			g.fillRect(0, 0, w, h);
			g.setColor(fraction >= 1f ? BingoUi.COLOR_COMPLETE : BingoUi.COLOR_PARTIAL);
			g.fillRect(0, 0, Math.round(w * Math.max(0f, Math.min(1f, fraction))), h);

			java.awt.FontMetrics metrics = g.getFontMetrics(getFont());
			int baseline = (h + metrics.getAscent() - metrics.getDescent()) / 2;
			int countWidth = metrics.stringWidth(count);
			String shownName = name;
			int available = w - countWidth - 12;
			if (metrics.stringWidth(shownName) > available)
			{
				while (shownName.length() > 1
					&& metrics.stringWidth(shownName + "..") > available)
				{
					shownName = shownName.substring(0, shownName.length() - 1);
				}
				shownName += "..";
			}
			g.setFont(getFont());
			g.setColor(Color.BLACK);
			g.drawString(shownName, 5, baseline + 1);
			g.drawString(count, w - countWidth - 3, baseline + 1);
			g.setColor(Color.WHITE);
			g.drawString(shownName, 4, baseline);
			g.drawString(count, w - countWidth - 4, baseline);
		}
	}

	/** Tooltip for a goal bar: the full goal text (when it says more) and the contributors. */
	private static String barTooltip(BingoGoal goal, List<GoalBar.Segment> segments)
	{
		StringBuilder tip = new StringBuilder("<html>");
		if (goal.hasExtraDetail())
		{
			tip.append(goal.describe());
		}
		if (!segments.isEmpty())
		{
			tip.append(tip.length() > 6 ? "<br>" : "").append("Click to show contributors");
			for (GoalBar.Segment segment : segments)
			{
				tip.append("<br>").append(segment.name).append(": ").append(formatCount(segment.amount));
			}
		}
		return tip.length() > 6 ? tip.append("</html>").toString() : null;
	}

	/**
	 * A goal's progress bar, painted in one segment per contributor (alternating shades,
	 * largest first) with the count centered and, when it can unfold contributor rows,
	 * a small arrow on the right.
	 */
	private static class GoalBar extends JPanel
	{
		static class Segment
		{
			final String name;
			final long amount;

			Segment(String name, long amount)
			{
				this.name = name;
				this.amount = amount;
			}
		}

		private final long value;
		private final long target;
		private final String label;
		private final List<Segment> segments;
		/** null: nothing to unfold; otherwise whether the rows are currently shown. */
		private final Boolean expanded;

		GoalBar(long value, long target, String label, List<Segment> segments, Boolean expanded, int widthBasis)
		{
			this.value = value;
			this.target = Math.max(1, target);
			this.label = label;
			this.segments = segments;
			this.expanded = expanded;
			setPreferredSize(new Dimension(widthBasis, 18));
			setMaximumSize(new Dimension(Integer.MAX_VALUE, 18));
			setMinimumSize(new Dimension(40, 18));
			setAlignmentX(LEFT_ALIGNMENT);
			setFont(FontManager.getRunescapeSmallFont());
			if (expanded != null)
			{
				setCursor(java.awt.Cursor.getPredefinedCursor(java.awt.Cursor.HAND_CURSOR));
			}
		}

		@Override
		protected void paintComponent(java.awt.Graphics g)
		{
			super.paintComponent(g);
			int w = getWidth();
			int h = getHeight();
			g.setColor(ColorScheme.DARK_GRAY_COLOR);
			g.fillRect(0, 0, w, h);
			Color base = value >= target ? BingoUi.COLOR_COMPLETE : BingoUi.COLOR_PARTIAL;
			if (segments.isEmpty())
			{
				g.setColor(base);
				g.fillRect(0, 0, Math.round(w * Math.min(1f, value / (float) target)), h);
			}
			else
			{
				// Segments in proportion to the target; past it, the bar is simply full.
				int x = 0;
				long shown = 0;
				for (int i = 0; i < segments.size() && shown < target; i++)
				{
					long amount = Math.min(segments.get(i).amount, target - shown);
					shown += amount;
					int end = Math.round(w * Math.min(1f, shown / (float) target));
					g.setColor(i % 2 == 0 ? base : base.darker());
					g.fillRect(x, 0, end - x, h);
					x = end;
				}
			}

			java.awt.FontMetrics metrics = g.getFontMetrics(getFont());
			int baseline = (h + metrics.getAscent() - metrics.getDescent()) / 2;
			int textX = (w - metrics.stringWidth(label)) / 2;
			g.setFont(getFont());
			g.setColor(Color.BLACK);
			g.drawString(label, textX + 1, baseline + 1);
			g.setColor(Color.WHITE);
			g.drawString(label, textX, baseline);
			if (expanded != null)
			{
				String arrow = expanded ? "▾" : "▸";
				int arrowX = w - metrics.stringWidth(arrow) - 4;
				g.setColor(Color.BLACK);
				g.drawString(arrow, arrowX + 1, baseline + 1);
				g.setColor(Color.WHITE);
				g.drawString(arrow, arrowX, baseline);
			}
		}
	}

	/** Compact verified marker, falling back to text if the font lacks the checkmark glyph. */
	private static String verifiedMark()
	{
		return FontManager.getRunescapeSmallFont().canDisplay('✔') ? " ✔" : " (v)";
	}

	/** A progress bar styled for the panel: complete bars go green, partial ones amber. */
	private ProgressBar progressBar(long value, long target, int height)
	{
		ProgressBar bar = new ProgressBar();
		bar.setMaximumValue((int) Math.max(1, Math.min(Integer.MAX_VALUE, target)));
		bar.setValue((int) Math.max(0, Math.min(Integer.MAX_VALUE, value)));
		bar.setForeground(value >= target ? BingoUi.COLOR_COMPLETE : BingoUi.COLOR_PARTIAL);
		bar.setBackground(ColorScheme.DARK_GRAY_COLOR);
		bar.setFont(FontManager.getRunescapeSmallFont());
		bar.setPreferredSize(new Dimension(widthBasis, height));
		bar.setMaximumSize(new Dimension(Integer.MAX_VALUE, height));
		bar.setMinimumSize(new Dimension(40, height));
		bar.setAlignmentX(LEFT_ALIGNMENT);
		return bar;
	}

	/** Received item names, alphabetical and case-insensitive, for stable display. */
	private static List<String> sortedNames(java.util.Collection<String> names)
	{
		List<String> sorted = new ArrayList<>(names);
		sorted.sort(String.CASE_INSENSITIVE_ORDER);
		return sorted;
	}

	/** Compact counts so bar labels stay inside the bar: 1500 -> 1.5k, 5000000 -> 5M. */
	private static String formatCount(long value)
	{
		if (value >= 1_000_000)
		{
			double millions = value / 1_000_000d;
			return (millions == Math.floor(millions) ? String.valueOf((long) millions)
				: String.format("%.1f", millions)) + "M";
		}
		if (value >= 10_000)
		{
			return (value / 1000) + "k";
		}
		return String.valueOf(value);
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
}

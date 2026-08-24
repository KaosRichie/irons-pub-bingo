package com.ironspubbingo;

import net.runelite.client.RuneLite;
import net.runelite.client.externalplugins.ExternalPluginManager;

/**
 * Starts a RuneLite dev client with this plugin loaded ({@code gradlew run}).
 * Lives in its own source set so the plugin builds without any dev or test code.
 */
public class IronsPubBingoDevLauncher
{
	public static void main(String[] args) throws Exception
	{
		ExternalPluginManager.loadBuiltin(IronsPubBingoPlugin.class);
		RuneLite.main(args);
	}
}

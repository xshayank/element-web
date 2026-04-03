/*
Copyright 2025 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

/**
 * Bridge between the RichPresenceServer and the renderer process.
 *
 * Forwards activity-changed events from the IPC server to the renderer via
 * `global.mainWindow.webContents.send("rich-presence-activity", activity)`.
 */

import { type RichPresenceActivity, RichPresenceServer } from "./rich-presence.js";

let richPresenceServer: RichPresenceServer | null = null;

/**
 * Initialise the Rich Presence server and start forwarding activity updates
 * to the renderer.  Safe to call multiple times – subsequent calls are no-ops.
 */
export async function initRichPresence(): Promise<void> {
    if (richPresenceServer) return;

    richPresenceServer = new RichPresenceServer();

    richPresenceServer.on("activity-changed", (activity: RichPresenceActivity | null) => {
        global.mainWindow?.webContents.send("rich-presence-activity", activity);
    });

    await richPresenceServer.start();
}

/**
 * Return the current activity (may be null if no client is connected or the
 * activity was explicitly cleared).
 */
export function getCurrentActivity(): RichPresenceActivity | null {
    return richPresenceServer?.getCurrentActivity() ?? null;
}

/** Shut down the Rich Presence server and clean up sockets/pipes. */
export function destroyRichPresence(): void {
    richPresenceServer?.destroy();
    richPresenceServer = null;
}

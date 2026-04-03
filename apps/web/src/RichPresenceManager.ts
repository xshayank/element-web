/*
Copyright 2025 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

/**
 * RichPresenceManager listens for activity updates from the Element Desktop app
 * (via the Discord-compatible IPC server) and broadcasts them over Matrix using
 * the presence API's `status_msg` field.
 *
 * The status_msg is set to a human-readable string (e.g. "🎮 Playing Valorant")
 * with a machine-readable base64 JSON payload appended using the `||rp:…||`
 * convention.  This lets Element clients show a rich card while other clients
 * still see the human-readable text.
 */

import { logger } from "matrix-js-sdk/src/logger";

import { MatrixClientPeg } from "./MatrixClientPeg";

export interface RichPresenceActivity {
    application_id?: string;
    state?: string;
    details?: string;
    timestamps?: {
        start?: number;
        end?: number;
    };
    assets?: {
        large_image?: string;
        large_text?: string;
        small_image?: string;
        small_text?: string;
    };
    party?: {
        id?: string;
        size?: [number, number];
    };
    buttons?: Array<{ label: string; url: string }>;
    instance?: boolean;
    client_id?: string;
}

/** Prefix/suffix used to embed a base64-encoded rich presence payload in status_msg. */
export const RICH_PRESENCE_STATUS_PREFIX = "||rp:";
export const RICH_PRESENCE_STATUS_SUFFIX = "||";

/** Don't send presence updates more than once every 5 seconds. */
const UPDATE_DEBOUNCE_MS = 5000;

class RichPresenceManager {
    private currentActivity: RichPresenceActivity | null = null;
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;
    private started = false;

    /** Start listening for Rich Presence activity from the desktop app. */
    public start(): void {
        if (this.started) return;
        this.started = true;

        const electron = window.electron;
        if (!electron?.richPresence) return; // Not running in desktop app.

        electron.richPresence.onActivityUpdate((_event: Event, activity: RichPresenceActivity | null) => {
            this.onActivityUpdate(activity);
        });

        // Fetch whatever was already set when we started.
        electron.richPresence.getActivity().then((activity: RichPresenceActivity | null) => {
            if (activity) this.onActivityUpdate(activity);
        });
    }

    /** Stop the manager and clear the presence broadcast. */
    public stop(): void {
        if (!this.started) return;
        this.started = false;
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        void this.broadcastPresence(null);
    }

    /** Return the most recently received activity (may be null). */
    public getCurrentActivity(): RichPresenceActivity | null {
        return this.currentActivity;
    }

    /**
     * Parse a rich presence activity out of a presence `status_msg`.
     *
     * Returns null if the message contains no embedded rich presence payload.
     */
    public static parseFromStatusMsg(statusMsg: string | undefined): RichPresenceActivity | null {
        if (!statusMsg) return null;
        const start = statusMsg.indexOf(RICH_PRESENCE_STATUS_PREFIX);
        if (start === -1) return null;
        const payloadStart = start + RICH_PRESENCE_STATUS_PREFIX.length;
        const end = statusMsg.indexOf(RICH_PRESENCE_STATUS_SUFFIX, payloadStart);
        if (end === -1) return null;
        const b64 = statusMsg.slice(payloadStart, end);
        try {
            return JSON.parse(atob(b64)) as RichPresenceActivity;
        } catch {
            return null;
        }
    }

    /**
     * Build a status_msg string that embeds the rich presence payload.
     * Non-Element clients will see the human-readable prefix; Element clients
     * will parse the embedded JSON.
     */
    public static buildStatusMsg(activity: RichPresenceActivity): string {
        const parts: string[] = [];
        if (activity.assets?.large_text) {
            parts.push(`🎮 Playing ${activity.assets.large_text}`);
        } else if (activity.details) {
            parts.push(`🎮 ${activity.details}`);
        }
        if (activity.state) {
            parts.push(activity.state);
        }
        const humanReadable = parts.join(" — ") || "🎮 Playing a game";
        const encoded = btoa(JSON.stringify(activity));
        return `${humanReadable} ${RICH_PRESENCE_STATUS_PREFIX}${encoded}${RICH_PRESENCE_STATUS_SUFFIX}`;
    }

    // -------------------------------------------------------------------------
    // Private
    // -------------------------------------------------------------------------

    private onActivityUpdate(activity: RichPresenceActivity | null): void {
        this.currentActivity = activity;

        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
            void this.broadcastPresence(activity);
        }, UPDATE_DEBOUNCE_MS);
    }

    private async broadcastPresence(activity: RichPresenceActivity | null): Promise<void> {
        const client = MatrixClientPeg.get();
        if (!client) return;
        if (client.isGuest()) return;

        try {
            const statusMsg = activity ? RichPresenceManager.buildStatusMsg(activity) : "";
            await client.setPresence({ presence: "online", status_msg: statusMsg });
            logger.debug("Rich Presence: broadcast", activity ? "active" : "cleared");
        } catch (err) {
            logger.error("Rich Presence: failed to broadcast presence", err);
        }
    }
}

export default new RichPresenceManager();

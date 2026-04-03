/*
Copyright 2025 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React from "react";

import { type RichPresenceActivity } from "../../../../RichPresenceManager";

interface RichPresenceCardProps {
    activity: RichPresenceActivity;
}

function formatElapsedTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    }
    return `${minutes}:${String(secs).padStart(2, "0")}`;
}

export const RichPresenceCard: React.FC<RichPresenceCardProps> = ({ activity }) => {
    const elapsed = activity.timestamps?.start
        ? formatElapsedTime(Date.now() / 1000 - activity.timestamps.start)
        : null;

    const gameName = activity.assets?.large_text || activity.details || "Unknown Game";

    return (
        <div className="mx_RichPresenceCard">
            <div className="mx_RichPresenceCard_header">
                <span className="mx_RichPresenceCard_label">Playing a game</span>
            </div>
            <div className="mx_RichPresenceCard_body">
                <div className="mx_RichPresenceCard_icon">
                    <div className="mx_RichPresenceCard_iconPlaceholder">{gameName.charAt(0).toUpperCase()}</div>
                </div>
                <div className="mx_RichPresenceCard_info">
                    <div className="mx_RichPresenceCard_gameName">{gameName}</div>
                    {activity.details && activity.details !== gameName && (
                        <div className="mx_RichPresenceCard_details">{activity.details}</div>
                    )}
                    {activity.state && <div className="mx_RichPresenceCard_state">{activity.state}</div>}
                    {elapsed && <div className="mx_RichPresenceCard_elapsed">{elapsed} elapsed</div>}
                </div>
            </div>
        </div>
    );
};

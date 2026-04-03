/*
Copyright 2025 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

/**
 * Discord-compatible Rich Presence IPC server.
 *
 * Implements the exact same IPC protocol Discord uses so that any application
 * already supporting Discord Rich Presence can update Element's user
 * status/activity display without modification.
 *
 * Protocol reference:
 *   - Windows : Named Pipes at \\.\pipe\discord-ipc-{N}
 *   - Unix    : Domain Sockets at {XDG_RUNTIME_DIR||TMPDIR||/tmp}/discord-ipc-{N}
 *
 * Frame format: 8-byte header (LE uint32 opcode + LE uint32 length) + JSON body.
 */

import { EventEmitter } from "node:events";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The subset of the activity object forwarded to the renderer. */
export interface RichPresenceActivity {
    state?: string;
    details?: string;
    timestamps?: { start?: number; end?: number };
    assets?: {
        large_image?: string;
        large_text?: string;
        small_image?: string;
        small_text?: string;
    };
    party?: { id?: string; size?: [number, number] };
    buttons?: Array<{ label: string; url: string }>;
    instance?: boolean;
    /** client_id from the HANDSHAKE opcode */
    client_id?: string;
}

// ---------------------------------------------------------------------------
// Opcode constants
// ---------------------------------------------------------------------------

const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;
const OP_PING = 3;
const OP_PONG = 4;

const HEADER_SIZE = 8; // 4 bytes opcode + 4 bytes length

// ---------------------------------------------------------------------------
// Helper: build the socket path(s) to try
// ---------------------------------------------------------------------------

function getSocketPaths(): string[] {
    const paths: string[] = [];

    if (process.platform === "win32") {
        for (let i = 0; i <= 9; i++) {
            paths.push(`\\\\.\\pipe\\discord-ipc-${i}`);
        }
    } else {
        const runtimeDir =
            process.env["XDG_RUNTIME_DIR"] ??
            process.env["TMPDIR"] ??
            process.env["TMP"] ??
            process.env["TEMP"] ??
            os.tmpdir();

        for (let i = 0; i <= 9; i++) {
            paths.push(`${runtimeDir}/discord-ipc-${i}`);
        }
    }

    return paths;
}

// ---------------------------------------------------------------------------
// Per-connection state
// ---------------------------------------------------------------------------

interface ConnectionState {
    clientId: string | null;
    buffer: Buffer;
}

// ---------------------------------------------------------------------------
// RichPresenceServer
// ---------------------------------------------------------------------------

export class RichPresenceServer extends EventEmitter {
    private server: net.Server | null = null;
    private socketPath: string | null = null;
    private currentActivity: RichPresenceActivity | null = null;
    /** Socket that most recently set the current activity. */
    private activityOwner: net.Socket | null = null;

    /** Start the server, trying discord-ipc-0 … discord-ipc-9 in order. */
    public async start(): Promise<void> {
        const paths = getSocketPaths();

        for (const socketPath of paths) {
            try {
                await this.tryListen(socketPath);
                this.socketPath = socketPath;
                console.log(`[RichPresence] Listening on ${socketPath}`);
                return;
            } catch {
                // Path in use or unavailable – try the next one.
            }
        }

        console.warn("[RichPresence] Could not bind to any discord-ipc socket – Rich Presence disabled.");
    }

    /** Return the most recently reported activity (or null if none). */
    public getCurrentActivity(): RichPresenceActivity | null {
        return this.currentActivity;
    }

    /** Tear down the server and clean up socket files. */
    public destroy(): void {
        this.server?.close();
        this.server = null;

        if (process.platform !== "win32" && this.socketPath) {
            try {
                fs.unlinkSync(this.socketPath);
            } catch {
                // Ignore – file may already be gone.
            }
            this.socketPath = null;
        }
    }

    // -----------------------------------------------------------------------
    // Private helpers
    // -----------------------------------------------------------------------

    /** Attempt to bind a net.Server to the given path, resolving on success. */
    private tryListen(socketPath: string): Promise<void> {
        return new Promise((resolve, reject) => {
            // On Unix, remove a stale socket file before trying to listen.
            if (process.platform !== "win32") {
                try {
                    fs.unlinkSync(socketPath);
                } catch {
                    // Fine if it didn't exist.
                }
            }

            const server = net.createServer((socket) => this.handleConnection(socket));

            server.once("error", (err) => {
                server.close();
                reject(err);
            });

            server.listen(socketPath, () => {
                this.server = server;
                resolve();
            });
        });
    }

    /** Handle a new client connection. */
    private handleConnection(socket: net.Socket): void {
        const state: ConnectionState = { clientId: null, buffer: Buffer.alloc(0) };

        socket.on("data", (chunk: Buffer) => {
            state.buffer = Buffer.concat([state.buffer, chunk]);
            this.processBuffer(socket, state);
        });

        socket.on("close", () => {
            // When a client disconnects, clear the activity only if it was the
            // most recent owner – other connected clients keep their activity.
            if (this.activityOwner === socket) {
                this.setActivity(null, null);
            }
        });

        socket.on("error", (err) => {
            console.error("[RichPresence] Socket error:", err.message);
        });
    }

    /** Drain all complete frames from the receive buffer. */
    private processBuffer(socket: net.Socket, state: ConnectionState): void {
        while (state.buffer.length >= HEADER_SIZE) {
            const opcode = state.buffer.readUInt32LE(0);
            const length = state.buffer.readUInt32LE(4);

            if (state.buffer.length < HEADER_SIZE + length) break; // Not enough data yet.

            const body = state.buffer.subarray(HEADER_SIZE, HEADER_SIZE + length);
            state.buffer = state.buffer.subarray(HEADER_SIZE + length);

            this.handleFrame(socket, state, opcode, body);
        }
    }

    /** Dispatch a decoded frame to the appropriate handler. */
    private handleFrame(socket: net.Socket, state: ConnectionState, opcode: number, body: Buffer): void {
        switch (opcode) {
            case OP_HANDSHAKE:
                this.handleHandshake(socket, state, body);
                break;
            case OP_FRAME:
                this.handleRpcFrame(socket, state, body);
                break;
            case OP_PING:
                this.sendFrame(socket, OP_PONG, body);
                break;
            case OP_CLOSE:
                // Only clear the global activity if this socket owned it.
                if (this.activityOwner === socket) {
                    this.setActivity(null, null);
                }
                socket.destroy();
                break;
            default:
                console.warn(`[RichPresence] Unknown opcode ${opcode} – ignoring`);
        }
    }

    /** Handle HANDSHAKE (opcode 0): validate version, send READY. */
    private handleHandshake(socket: net.Socket, state: ConnectionState, body: Buffer): void {
        let payload: { v?: number; client_id?: string };
        try {
            payload = JSON.parse(body.toString("utf8")) as { v?: number; client_id?: string };
        } catch {
            console.warn("[RichPresence] Malformed HANDSHAKE payload – closing connection");
            socket.destroy();
            return;
        }

        if (payload.v !== 1) {
            console.warn(`[RichPresence] Unsupported protocol version ${payload.v} – closing connection`);
            socket.destroy();
            return;
        }

        state.clientId = payload.client_id ?? null;

        const readyPayload = {
            cmd: "DISPATCH",
            data: {
                v: 1,
                config: {
                    api_endpoint: "//discord.com/api",
                    cdn_host: "cdn.discordapp.com",
                    environment: "production",
                },
            },
            evt: "READY",
            nonce: null,
        };

        this.sendFrame(socket, OP_FRAME, Buffer.from(JSON.stringify(readyPayload), "utf8"));
    }

    /** Handle FRAME (opcode 1): dispatch RPC commands. */
    private handleRpcFrame(socket: net.Socket, state: ConnectionState, body: Buffer): void {
        let rpc: { cmd?: string; args?: Record<string, unknown>; nonce?: string };
        try {
            rpc = JSON.parse(body.toString("utf8")) as typeof rpc;
        } catch {
            console.warn("[RichPresence] Malformed FRAME payload – ignoring");
            return;
        }

        if (rpc.cmd === "SET_ACTIVITY") {
            const args = rpc.args ?? {};
            const rawActivity = (args["activity"] as Partial<RichPresenceActivity>) ?? null;

            const activity: RichPresenceActivity | null = rawActivity
                ? {
                      ...rawActivity,
                      client_id: state.clientId ?? undefined,
                  }
                : null;

            this.setActivity(activity, socket);

            // Acknowledge the command.
            const ackPayload = {
                cmd: "SET_ACTIVITY",
                data: { state: "IDLE", ...(rawActivity ?? {}) },
                evt: null,
                nonce: rpc.nonce ?? null,
            };
            this.sendFrame(socket, OP_FRAME, Buffer.from(JSON.stringify(ackPayload), "utf8"));
        }
    }

    /** Emit a frame to the client. */
    private sendFrame(socket: net.Socket, opcode: number, body: Buffer): void {
        const header = Buffer.allocUnsafe(HEADER_SIZE);
        header.writeUInt32LE(opcode, 0);
        header.writeUInt32LE(body.length, 4);
        socket.write(Buffer.concat([header, body]));
    }

    /** Update the stored activity and emit a change event. */
    private setActivity(activity: RichPresenceActivity | null, owner: net.Socket | null): void {
        this.currentActivity = activity;
        this.activityOwner = owner;
        this.emit("activity-changed", activity);
    }
}

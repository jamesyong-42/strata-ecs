/**
 * Presence — the ephemeral half of collab mode (Part IV, design.md §15). Where boot.ts moves the
 * DURABLE document, this module moves PRESENCE: one live cursor + selection highlight per peer, over
 * the SAME transport channel, but on the ephemeral store instead of the durable one.
 *
 * The whole of it is app glue over `@vibecook/strata-ecs/ephemeral`; there is NO presence protocol here — no
 * join/leave handshake, no TTL bookkeeping, no per-peer diffing. The framework owns all of that:
 *  - `eph.spawn` / `eph.edit().set` — write MY presence into MY partition; it applies to my runtime
 *    immediately and rides the store's own change-throttle onto the wire (design §15.2, Option A).
 *  - `attachEphemeral` — projects every OTHER peer's blobs in as live `Not(Local)` entities that
 *    self-expire on TTL, and publishes {@link EphemeralSyncStatus} on change (§15.3, 006 C7).
 *  - `eph.leave()` — best-effort departure on `pagehide`; the guaranteed despawn on every peer is the
 *    TTL timeout regardless (§15.3).
 *
 * The overlay renders remote presence from the `remotePresence` query (overlayLayer.ts); this module
 * only WRITES my own. `reportCursor` / `reportSelection` are the two write hooks the input + selection
 * layers call — both no-op in local-only mode (no active presence), so those call sites stay mode-blind.
 */

import type { Entity } from "@vibecook/strata-ecs";
import type { DurableStore } from "@vibecook/strata-ecs/durable";
import { DurableSyncStatus } from "@vibecook/strata-ecs/durable";
import {
  attachEphemeral,
  createEphemeralStore,
  EphemeralSyncStatus,
  LoroEphemeralSnapshot,
  type Attachment,
  type EphemeralStore,
} from "@vibecook/strata-ecs/ephemeral";
import { EphemeralStore as LoroEphemeralStore } from "loro-crdt";
import { world } from "../app/worldRef";
import { CursorPos, PresenceInfo, SelectionRef } from "../ecs/schema";
import type { Channel } from "./transport";

/** Presence outbound clock — 33ms (~30Hz), the design's cursor-motion cadence (§15.5). */
const PRESENCE_THROTTLE_MS = 33;
/** Per-peer TTL — a peer whose keepalive lapses (tab closed, network drop) vanishes after this (§15.3). */
const PRESENCE_TTL_MS = 5000;

/** The active presence session — a module singleton, mirroring `activeCollab()`. `null` in local mode. */
interface ActivePresence {
  readonly eph: EphemeralStore;
  readonly doc: DurableStore;
  /** MY presence entity (tagged `Local` by the store; never rendered by the `Not(Local)` overlay query). */
  readonly me: Entity;
  /** Whether MY presence currently carries a `SelectionRef` facet (membership-as-signal, §15.6). */
  hasSelRef: boolean;
}

let active: ActivePresence | null = null;

export interface PresenceOptions {
  /** SAME id as the durable session (the collab session's peerId) — session-unique (006 B5). */
  peerId: string;
  /** The room name — shown in the HUD chips. */
  room: string;
  /** The shared transport (boot.ts owns it): ephemeral blobs ride `{ kind: "ephemeral" }` envelopes. */
  channel: Channel;
  /** The attached durable store — `doc.keyOf` turns a selected shape into a cross-store `SelectionRef`. */
  doc: DurableStore;
  /** Paint the collab status line (the HUD's `.hud-collab` chips). */
  renderChips: (text: string) => void;
}

export interface Presence {
  /**
   * The ephemeral store this presence session drives. boot.ts threads it into the collab session so the
   * observer's ephemeral tab can read its `debugDump()`; nothing else reaches past the write hooks.
   */
  readonly eph: EphemeralStore;
  /** Feed an inbound ephemeral blob to the store's source (wired from the transport by boot.ts). */
  applyInbound(bytes: Uint8Array): void;
  /** Best-effort departure (pagehide): despawn MY presence on every peer NOW, don't wait the TTL. */
  leave(): void;
  /** Tear the binding down: stop the timers, unsubscribe the chips, release the source. */
  dispose(): void;
}

/**
 * Start presence for a collab session: construct the ephemeral store over a fresh Loro `EphemeralStore`,
 * attach it to the app's ONE world (so peers project in), spawn MY presence entity, and wire the HUD
 * chips to both sync-status resources. Returns the transport-inbound sink + the leave/dispose handles.
 */
export function startPresence(opts: PresenceOptions): Presence {
  // The ONE place loro-crdt's EphemeralStore enters this app (the app owns its lifecycle — §15.2).
  const source = new LoroEphemeralSnapshot(new LoroEphemeralStore(PRESENCE_TTL_MS));
  const eph = createEphemeralStore(source, {
    peerId: opts.peerId,
    send: (bytes) => opts.channel.post({ kind: "ephemeral", from: opts.peerId, bytes }),
    throttleMs: PRESENCE_THROTTLE_MS,
    ttlMs: PRESENCE_TTL_MS,
  });
  const attachment: Attachment = attachEphemeral(world, eph);

  // MY presence: a cursor at the origin (the first pointermove moves it) + a deterministic identity.
  const { name, color } = presenceIdentity(opts.peerId);
  const me = eph.spawn({ components: [[CursorPos, { x: 0, y: 0 }], [PresenceInfo, { name, color }]] });
  active = { eph, doc: opts.doc, me, hasSelRef: false };

  // HUD chips: observe BOTH status resources. Each publishes with producer-side set-on-change (006 C7),
  // so an idle network fires NOTHING here — the chips update exactly when peers or sync activity move.
  const renderChips = (): void => {
    const p = world.getResource(EphemeralSyncStatus);
    const d = world.getResource(DurableSyncStatus);
    opts.renderChips(
      `${opts.room} · peers ${p?.peerCount ?? 0} · ` +
        `pending ${d?.pendingInbound ?? 0} · held ${d?.heldCells ?? 0} · applied ${d?.lastAppliedFrame ?? 0}`,
    );
  };
  const unsubEph = world.reactive.observeResource(EphemeralSyncStatus, renderChips);
  const unsubDur = world.reactive.observeResource(DurableSyncStatus, renderChips);
  renderChips(); // initial paint — registration is a frame boundary and never back-fires (002 §4.1a)

  return {
    eph,
    applyInbound: (bytes) => source.apply(bytes),
    leave: () => {
      active = null; // stop reportCursor/reportSelection touching a departing store
      eph.leave();
    },
    dispose: () => {
      active = null;
      unsubEph();
      unsubDur();
      attachment.detach();
    },
  };
}

/**
 * MY cursor moved (called from the input layer's pointermove, in WORLD coords). A pure value write on my
 * own partition — legal every frame; the store's throttle coalesces the stream onto the wire. No-op in
 * local-only mode, so the input layer stays mode-blind.
 */
export function reportCursor(wx: number, wy: number): void {
  if (active === null) return;
  active.eph.edit(active.me).set(CursorPos, { x: wx, y: wy });
}

/**
 * MY selection changed (called from the selection ops with the current selection). The PRIMARY selected
 * shape's durable key becomes a `SelectionRef` facet on my presence — present while I have a durable
 * selection, absent otherwise (membership-as-signal, §15.6). Runtime-only selection stays runtime-only;
 * only the reference travels. No-op in local-only mode.
 */
export function reportSelection(selected: readonly Entity[]): void {
  if (active === null) return;
  const key = selected.length > 0 ? active.doc.keyOf(selected[0]) : undefined;
  if (key !== undefined) {
    if (active.hasSelRef) active.eph.edit(active.me).set(SelectionRef, { targetKey: key });
    else {
      active.eph.addComponent(active.me, SelectionRef, { targetKey: key });
      active.hasSelRef = true;
    }
  } else if (active.hasSelRef) {
    active.eph.removeComponent(active.me, SelectionRef);
    active.hasSelRef = false;
  }
}

// --- deterministic identity (name + color from the session peerId) ----------------------------------

const ADJECTIVES = ["swift", "calm", "bold", "keen", "wry", "lucid", "brisk", "sly", "spry", "deft", "vivid", "nimble"];
const CREATURES = ["otter", "heron", "lynx", "fox", "moth", "wren", "koi", "ibex", "toad", "hare", "crane", "vole"];

/** FNV-1a over the peerId — a stable 32-bit hash so a peer's handle + color are the same on every tab. */
function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * A fun, stable handle + a hashed hue from a peerId — display identity lives in a component, NEVER the key
 * prefix (006 B5). Every peer computes the same name/color for a given id, so labels agree across tabs.
 */
export function presenceIdentity(peerId: string): { name: string; color: string } {
  const h = hash32(peerId);
  const name = `${ADJECTIVES[h % ADJECTIVES.length]} ${CREATURES[(h >>> 8) % CREATURES.length]}`;
  const color = `hsl(${h % 360} 72% 62%)`;
  return { name, color };
}

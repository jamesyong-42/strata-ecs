/**
 * Simulate mode. Enabling randomizes every shape's Velocity in ONE dense out-of-tick column
 * pass (value writes are immediate anywhere, §5.6 — only SHAPE changes are forbidden during
 * an out-of-tick walk) and flips the SimMode resource the simulate phase's runIf reads.
 * Disabling just gates the phase off — shapes freeze mid-flight, and the phase costs zero.
 */

import { simulated } from "../ecs/queries";
import { SimMode, Velocity } from "../ecs/schema";
import { scheduleAutosave } from "./persistence";
import { worldRef } from "./worldRef";

export function isSimOn(): boolean {
  return worldRef.current.getResource(SimMode)?.on === true;
}

/** Fit the bounce box to the board (called after seeding/stress spawns). */
export function setSimBound(bound: number): void {
  const w = worldRef.current;
  w.setResource(SimMode, { on: isSimOn(), bound });
}

export function setSimulate(on: boolean): void {
  const w = worldRef.current;
  const bound = w.getResource(SimMode)?.bound ?? 4000;
  if (on) {
    // one-shot randomize — deterministic, and a nice showcase of immediate column writes
    let seed = 0x9e3779b9;
    const rand = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    w.query(simulated).each((b) => {
      const vx = b.col(Velocity).vx;
      const vy = b.col(Velocity).vy;
      for (let i = 0; i < b.count; i++) {
        const r = b.rows[i];
        const angle = rand() * Math.PI * 2;
        const speed = 30 + rand() * 150; // units/second
        vx[r] = Math.cos(angle) * speed;
        vy[r] = Math.sin(angle) * speed;
      }
    });
    // The randomizer poked the Velocity columns directly — a raw out-of-tick column walk, not a
    // system (a system cannot clear the SimMode trigger this reads) and not edit(). Per 002 §2.2
    // such writes are deliberately "not a stamp source": no chokepoint sees them. invalidate()
    // is the documented escape hatch — a manual whole-component stamp keeping the write visible
    // to any future Velocity observer (there is none today; this models the sanctioned pattern).
    w.reactive.invalidate(Velocity);
  }
  w.setResource(SimMode, { on, bound });
  scheduleAutosave(); // velocities + SimMode are document state — they ride in the snapshot
}

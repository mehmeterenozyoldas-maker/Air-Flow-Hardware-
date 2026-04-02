export interface Agent {
  col: number;
  row: number;
  group: number;
  x: number;
  y: number;
  value: number;
  state: number;
}

export interface Behavior {
  label: string;
  alpha: number;
  wNeigh: number;
  wUser: number;
  lightScale: number;
  lightOffset: number;
  oscAmp: number;
  oscSpeed: number;
}

export type BehaviorKey = 'focusedReading' | 'eveningFamily' | 'stormProtection' | 'festivalPulse';

export const BEHAVIORS: Record<BehaviorKey, Behavior> = {
  focusedReading: {
    label: "Focused Reading Corner",
    alpha: 0.12, wNeigh: 0.5, wUser: -0.8,
    lightScale: 1.0, lightOffset: 0.0,
    oscAmp: 0.0, oscSpeed: 0.0
  },
  eveningFamily: {
    label: "Evening Family Mode",
    alpha: 0.06, wNeigh: 0.7, wUser: -0.2,
    lightScale: 0.8, lightOffset: 0.2,
    oscAmp: 0.10, oscSpeed: 0.6
  },
  stormProtection: {
    label: "Storm Protection",
    alpha: 0.35, wNeigh: 0.4, wUser: 0.3,
    lightScale: 1.1, lightOffset: 0.1,
    oscAmp: 0.20, oscSpeed: 1.3
  },
  festivalPulse: {
    label: "Festival Pulse",
    alpha: 0.25, wNeigh: 0.2, wUser: 0.0,
    lightScale: 0.5, lightOffset: 0.4,
    oscAmp: 0.45, oscSpeed: 0.9
  }
};

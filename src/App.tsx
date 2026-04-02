/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { 
  Activity, 
  Camera, 
  Cpu, 
  Play, 
  Square, 
  Trash2, 
  Usb, 
  Zap, 
  Wind, 
  Users, 
  BookOpen, 
  Music,
  Circle
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { BEHAVIORS, BehaviorKey, Agent } from './types';
import { cn } from './lib/utils';

// Declare global ml5 and p5 types since they are loaded via CDN
declare const ml5: any;
declare const p5: any;

const NUM_COLS = 2;
const NUM_ROWS = 4;
const NUM_AGENTS = NUM_COLS * NUM_ROWS;
const VIDEO_W = 320;
const VIDEO_H = 240;
const SEND_INTERVAL = 100;

export default function App() {
  const canvasRef = useRef<HTMLDivElement>(null);
  const p5Instance = useRef<any>(null);
  
  // Serial State
  const [port, setPort] = useState<any>(null);
  const [writer, setWriter] = useState<any>(null);
  const [sensorData, setSensorData] = useState({ a: 0, b: 0 });
  const [outputs, setOutputs] = useState({ pumpA: 0, valveA: 0, pumpB: 0, valveB: 0 });
  
  // App State
  const [currentBehavior, setCurrentBehavior] = useState<BehaviorKey>('focusedReading');
  const [isRecording, setIsRecording] = useState(false);
  const [isPlayingBack, setIsPlayingBack] = useState(false);
  const [recordedFramesCount, setRecordedFramesCount] = useState(0);
  const [mlStatus, setMlStatus] = useState({ pose: false, hand: false });
  
  // Refs for logic (to avoid closure issues in p5)
  const stateRef = useRef({
    currentBehavior,
    isRecording,
    isPlayingBack,
    sensorA: 0,
    sensorB: 0,
    userX: 0,
    userY: 0,
    userActive: false,
    recordedFrames: [] as number[][],
    playbackIndex: 0,
    agents: [] as Agent[],
    lastSendTime: 0,
    lastLA: 0,
    lastLB: 0,
    lastGroupStateA: 0,
    lastGroupStateB: 0,
    pinchActive: false,
    façadeX: 360,
    façadeY: 90,
    cellW: 80,
    cellH: 80,
    cellPad: 10,
  });

  // Update refs when state changes
  useEffect(() => {
    stateRef.current.currentBehavior = currentBehavior;
    stateRef.current.isRecording = isRecording;
    stateRef.current.isPlayingBack = isPlayingBack;
  }, [currentBehavior, isRecording, isPlayingBack]);

  const connectSerial = async () => {
    try {
      if (!("serial" in navigator)) {
        alert("Web Serial not supported. Use Chrome/Edge.");
        return;
      }
      const p = await (navigator as any).serial.requestPort();
      await p.open({ baudRate: 115200 });
      setPort(p);

      const textDecoder = new TextDecoderStream();
      p.readable.pipeTo(textDecoder.writable);
      const reader = textDecoder.readable.getReader();

      const textEncoder = new TextEncoderStream();
      textEncoder.readable.pipeTo(p.writable);
      const w = textEncoder.writable.getWriter();
      setWriter(w);

      console.log("Serial connected.");
      
      // Read loop
      (async () => {
        let readBuffer = "";
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) {
              readBuffer += value;
              const lines = readBuffer.split(/\r?\n/);
              readBuffer = lines.pop() || "";
              for (let line of lines) {
                line = line.trim();
                if (line.startsWith("S:")) {
                  const parts = line.substring(2).split(",");
                  if (parts.length >= 2) {
                    const a = parseInt(parts[0]);
                    const b = parseInt(parts[1]);
                    if (!Number.isNaN(a)) {
                      stateRef.current.sensorA = a;
                      setSensorData(prev => ({ ...prev, a }));
                    }
                    if (!Number.isNaN(b)) {
                      stateRef.current.sensorB = b;
                      setSensorData(prev => ({ ...prev, b }));
                    }
                  }
                }
              }
            }
          }
        } catch (err) {
          console.error("Read loop error:", err);
        }
      })();
    } catch (err) {
      console.error("Serial connection error:", err);
    }
  };

  const sendSerial = async (str: string) => {
    if (!writer) return;
    try {
      await writer.write(str);
    } catch (err) {
      console.error("Serial write error:", err);
    }
  };

  useEffect(() => {
    const sketch = (p: any) => {
      let video: any;
      let poseNet: any;
      let handpose: any;
      let poses: any[] = [];
      let handPredictions: any[] = [];

      p.setup = () => {
        const canvas = p.createCanvas(950, 540);
        canvas.parent(canvasRef.current);
        
        // Initialize Agents
        stateRef.current.agents = [];
        for (let row = 0; row < NUM_ROWS; row++) {
          for (let col = 0; col < NUM_COLS; col++) {
            const group = (col === 0) ? 0 : 1;
            const x = stateRef.current.façadeX + col * (stateRef.current.cellW + stateRef.current.cellPad);
            const y = stateRef.current.façadeY + row * (stateRef.current.cellH + stateRef.current.cellPad);
            stateRef.current.agents.push({ col, row, group, x, y, value: 0.5, state: 1 });
          }
        }

        // Video & ML
        video = p.createCapture(p.VIDEO);
        video.size(VIDEO_W, VIDEO_H);
        video.hide();

        poseNet = ml5.poseNet(video, { flipHorizontal: true }, () => {
          setMlStatus(prev => ({ ...prev, pose: true }));
        });
        poseNet.on("pose", (results: any) => { poses = results; });

        handpose = ml5.handpose(video, () => {
          setMlStatus(prev => ({ ...prev, hand: true }));
        });
        handpose.on("predict", (results: any) => { handPredictions = results; });
      };

      const neighbourAvg = (index: number) => {
        const a = stateRef.current.agents[index];
        let sum = 0, count = 0;
        for (let j = 0; j < NUM_AGENTS; j++) {
          if (j === index) continue;
          const b = stateRef.current.agents[j];
          const dc = Math.abs(b.col - a.col);
          const dr = Math.abs(b.row - a.row);
          if (dc <= 1 && dr <= 1) {
            sum += b.value;
            count++;
          }
        }
        return count === 0 ? a.value : sum / count;
      };

      const stepModel = () => {
        let LA = (stateRef.current.sensorA - 300) / (900 - 300);
        let LB = (stateRef.current.sensorB - 300) / (900 - 300);
        LA = p.constrain(LA, 0, 1);
        LB = p.constrain(LB, 0, 1);

        const behavior = BEHAVIORS[stateRef.current.currentBehavior];
        const t = p.millis() / 1000.0;
        const newValues = new Array(NUM_AGENTS);

        for (let i = 0; i < NUM_AGENTS; i++) {
          const a = stateRef.current.agents[i];
          const v = a.value;

          let baseLight = (a.group === 0 ? LA : LB) * behavior.lightScale + behavior.lightOffset;
          baseLight = p.constrain(baseLight, 0, 1);

          const phase = t * behavior.oscSpeed + a.row * 0.4 + a.col * 0.8;
          const osc = behavior.oscAmp * (0.5 + 0.5 * Math.sin(phase));
          let base = p.constrain(baseLight + osc, 0, 1);

          const neigh = neighbourAvg(i);

          let userInf = 0;
          if (stateRef.current.userActive) {
            const cx = a.x + stateRef.current.cellW / 2;
            const cy = a.y + stateRef.current.cellH / 2;
            const d = p.dist(cx, cy, stateRef.current.userX, stateRef.current.userY);
            const sigma = 120;
            userInf = Math.exp(-(d * d) / (2 * sigma * sigma));
          }

          let target = base + behavior.wNeigh * (neigh - base) + behavior.wUser * userInf;
          target = p.constrain(target, 0, 1);

          const vNew = p.lerp(v, target, behavior.alpha);
          newValues[i] = p.constrain(vNew, 0, 1);
        }

        for (let i = 0; i < NUM_AGENTS; i++) {
          const v = newValues[i];
          stateRef.current.agents[i].value = v;
          stateRef.current.agents[i].state = (v < 0.33) ? 0 : (v < 0.66 ? 1 : 2);
        }

        computeAndSendGroupOutputs(LA, LB);
      };

      const computeAndSendGroupOutputs = (LA: number, LB: number) => {
        let sumA = 0, countA = 0, sumB = 0, countB = 0;
        for (let i = 0; i < NUM_AGENTS; i++) {
          const a = stateRef.current.agents[i];
          if (a.group === 0) { sumA += a.state; countA++; }
          else { sumB += a.state; countB++; }
        }

        const avgStateA = countA ? sumA / countA : 0;
        const avgStateB = countB ? sumB / countB : 0;

        const groupStateA = Math.round(avgStateA);
        const groupStateB = Math.round(avgStateB);

        stateRef.current.lastGroupStateA = groupStateA;
        stateRef.current.lastGroupStateB = groupStateB;
        stateRef.current.lastLA = LA;
        stateRef.current.lastLB = LB;

        const pA = (groupStateA === 2) ? 1 : 0;
        const vA = (groupStateA === 0) ? 1 : 0;
        const pB = (groupStateB === 2) ? 1 : 0;
        const vB = (groupStateB === 0) ? 1 : 0;

        setOutputs({ pumpA: pA, valveA: vA, pumpB: pB, valveB: vB });

        const bits = "" + pA + vA + pB + vB;
        sendSerial("O:" + bits + "\n");
      };

      const updateUserFromPose = () => {
        if (poses.length === 0) return;
        const pose = poses[0].pose;
        const ls = pose.leftShoulder;
        const rs = pose.rightShoulder;
        if (!ls || !rs || ls.confidence < 0.2 || rs.confidence < 0.2) return;

        const cx = (ls.x + rs.x) / 2;
        const cy = (ls.y + rs.y) / 2;

        stateRef.current.userX = p.map(cx, 0, VIDEO_W,
          stateRef.current.façadeX,
          stateRef.current.façadeX + NUM_COLS * (stateRef.current.cellW + stateRef.current.cellPad) - stateRef.current.cellPad);
        stateRef.current.userY = p.map(cy, 0, VIDEO_H,
          stateRef.current.façadeY,
          stateRef.current.façadeY + NUM_ROWS * (stateRef.current.cellW + stateRef.current.cellPad) - stateRef.current.cellPad);

        stateRef.current.userActive = true;
      };

      const updateFromHandPose = () => {
        if (handPredictions.length === 0) return;
        const hand = handPredictions[0];
        const landmarks = hand.landmarks;
        if (!landmarks || landmarks.length < 9) return;

        const indexTip = landmarks[8];
        const thumbTip = landmarks[4];

        const ix = indexTip[0];
        const iy = indexTip[1];

        stateRef.current.userX = p.map(ix, 0, VIDEO_W,
          stateRef.current.façadeX,
          stateRef.current.façadeX + NUM_COLS * (stateRef.current.cellW + stateRef.current.cellPad) - stateRef.current.cellPad);
        stateRef.current.userY = p.map(iy, 0, VIDEO_H,
          stateRef.current.façadeY,
          stateRef.current.façadeY + NUM_ROWS * (stateRef.current.cellW + stateRef.current.cellPad) - stateRef.current.cellPad);

        stateRef.current.userActive = true;

        // Pinch detection
        const dx = indexTip[0] - thumbTip[0];
        const dy = indexTip[1] - thumbTip[1];
        const dz = indexTip[2] - thumbTip[2];
        const d = Math.sqrt(dx*dx + dy*dy + dz*dz);
        const PINCH_THRESHOLD = 40;

        const currentlyPinching = d < PINCH_THRESHOLD;
        if (currentlyPinching && !stateRef.current.pinchActive) {
          // Cycle behaviors
          const order: BehaviorKey[] = ["focusedReading", "eveningFamily", "stormProtection", "festivalPulse"];
          const idx = order.indexOf(stateRef.current.currentBehavior);
          const next = order[(idx + 1) % order.length];
          setCurrentBehavior(next);
        }
        stateRef.current.pinchActive = currentlyPinching;
      };

      const playbackStep = () => {
        if (!stateRef.current.recordedFrames.length) return;
        const frame = stateRef.current.recordedFrames[stateRef.current.playbackIndex];
        for (let i = 0; i < NUM_AGENTS; i++) {
          const v = frame[i];
          stateRef.current.agents[i].value = v;
          stateRef.current.agents[i].state = (v < 0.33) ? 0 : (v < 0.66 ? 1 : 2);
        }
        computeAndSendGroupOutputs(stateRef.current.lastLA, stateRef.current.lastLB);
        stateRef.current.playbackIndex++;
        if (stateRef.current.playbackIndex >= stateRef.current.recordedFrames.length) {
          stateRef.current.playbackIndex = 0;
        }
      };

      p.draw = () => {
        p.background(5, 8, 15);

        const now = p.millis();
        if (now - stateRef.current.lastSendTime > SEND_INTERVAL) {
          stateRef.current.lastSendTime = now;

          if (stateRef.current.isPlayingBack) {
            playbackStep();
          } else {
            stateRef.current.userActive = false;
            updateUserFromPose();
            updateFromHandPose();
            stepModel();
          }

          if (stateRef.current.isRecording && !stateRef.current.isPlayingBack) {
            const frame = stateRef.current.agents.map(a => a.value);
            stateRef.current.recordedFrames.push(frame);
            setRecordedFramesCount(stateRef.current.recordedFrames.length);
          }
        }

        // Draw Facade
        for (let i = 0; i < NUM_AGENTS; i++) {
          const a = stateRef.current.agents[i];
          const v = a.value;
          const s = a.state;
          
          let c;
          if (s === 0) c = p.color(255, 100, 100, p.map(v, 0, 0.33, 50, 255));
          else if (s === 1) c = p.color(100, 255, 100, p.map(v, 0.33, 0.66, 50, 255));
          else c = p.color(100, 100, 255, p.map(v, 0.66, 1.0, 50, 255));
          
          p.fill(c);
          p.noStroke();
          p.rect(a.x, a.y, stateRef.current.cellW, stateRef.current.cellH, 18);
        }

        // Draw User Marker
        if (stateRef.current.userActive) {
          p.noFill();
          p.stroke(255, 220, 160);
          p.strokeWeight(2);
          p.ellipse(stateRef.current.userX, stateRef.current.userY, 24, 24);
        }

        // Video Preview
        const vw = 220, vh = 160;
        const px = p.width - vw - 20;
        const py = p.height - vh - 20;
        p.image(video, px, py, vw, vh);
        
        // Overlay ML info
        p.noFill();
        p.stroke(0, 255, 0);
        p.strokeWeight(1);
        p.rect(px, py, vw, vh);

        if (poses.length > 0) {
          const pose = poses[0].pose;
          const ls = pose.leftShoulder;
          const rs = pose.rightShoulder;
          if (ls && rs) {
            p.fill(0, 255, 0);
            p.ellipse(p.map(ls.x, 0, VIDEO_W, px, px + vw), p.map(ls.y, 0, VIDEO_H, py, py + vh), 5, 5);
            p.ellipse(p.map(rs.x, 0, VIDEO_W, px, px + vw), p.map(rs.y, 0, VIDEO_H, py, py + vh), 5, 5);
          }
        }
      };
    };

    p5Instance.current = new p5(sketch);
    return () => p5Instance.current.remove();
  }, []);

  const clearRecording = () => {
    stateRef.current.recordedFrames = [];
    stateRef.current.playbackIndex = 0;
    setRecordedFramesCount(0);
    setIsRecording(false);
    setIsPlayingBack(false);
  };

  return (
    <div className="min-h-screen bg-[#05080f] text-slate-200 font-sans selection:bg-blue-500/30">
      {/* Header */}
      <header className="border-b border-white/5 bg-black/20 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-[1400px] mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center shadow-lg shadow-blue-600/20">
              <Activity className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-semibold tracking-tight text-white leading-none">Cyberfaçade</h1>
              <p className="text-[10px] uppercase tracking-widest text-slate-500 font-bold mt-1">Interactive ABM System</p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/5 border border-white/10">
              <div className={cn("w-2 h-2 rounded-full animate-pulse", port ? "bg-emerald-500" : "bg-rose-500")} />
              <span className="text-xs font-medium text-slate-400">{port ? "Serial Connected" : "Serial Disconnected"}</span>
            </div>
            <button 
              onClick={connectSerial}
              className={cn(
                "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all",
                port 
                  ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" 
                  : "bg-blue-600 text-white hover:bg-blue-500 shadow-lg shadow-blue-600/20"
              )}
            >
              <Usb className="w-4 h-4" />
              {port ? "Connected" : "Connect Serial"}
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-[1400px] mx-auto p-6 grid grid-cols-12 gap-6">
        {/* Left Sidebar: Controls & Sensors */}
        <div className="col-span-3 space-y-6">
          {/* Behavior Selector */}
          <section className="bg-white/5 border border-white/10 rounded-2xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-bold uppercase tracking-widest text-slate-500">Behaviors</h2>
              <Zap className="w-4 h-4 text-amber-400" />
            </div>
            <div className="grid gap-2">
              {(Object.keys(BEHAVIORS) as BehaviorKey[]).map((key) => {
                const Icon = {
                  focusedReading: BookOpen,
                  eveningFamily: Users,
                  stormProtection: Wind,
                  festivalPulse: Music
                }[key];
                return (
                  <button
                    key={key}
                    onClick={() => setCurrentBehavior(key)}
                    className={cn(
                      "flex items-center gap-3 px-4 py-3 rounded-xl text-sm transition-all border",
                      currentBehavior === key 
                        ? "bg-blue-600/20 border-blue-500/50 text-blue-400" 
                        : "bg-white/5 border-transparent text-slate-400 hover:bg-white/10"
                    )}
                  >
                    <Icon className="w-4 h-4" />
                    <span className="font-medium">{BEHAVIORS[key].label}</span>
                  </button>
                );
              })}
            </div>
          </section>

          {/* Recording Controls */}
          <section className="bg-white/5 border border-white/10 rounded-2xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-bold uppercase tracking-widest text-slate-500">Sequencer</h2>
              <div className="flex items-center gap-1.5">
                <div className={cn("w-1.5 h-1.5 rounded-full", isRecording ? "bg-rose-500 animate-pulse" : "bg-slate-700")} />
                <span className="text-[10px] font-bold text-slate-500 uppercase">{recordedFramesCount} Frames</span>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => { setIsRecording(!isRecording); setIsPlayingBack(false); }}
                className={cn(
                  "flex items-center justify-center gap-2 py-2.5 rounded-xl text-xs font-bold transition-all border",
                  isRecording 
                    ? "bg-rose-500/20 border-rose-500/50 text-rose-400" 
                    : "bg-white/5 border-white/10 text-slate-400 hover:bg-white/10"
                )}
              >
                <Circle className={cn("w-3 h-3", isRecording && "fill-current")} />
                {isRecording ? "Stop Rec" : "Record"}
              </button>
              <button
                onClick={() => { setIsPlayingBack(!isPlayingBack); setIsRecording(false); }}
                className={cn(
                  "flex items-center justify-center gap-2 py-2.5 rounded-xl text-xs font-bold transition-all border",
                  isPlayingBack 
                    ? "bg-emerald-500/20 border-emerald-500/50 text-emerald-400" 
                    : "bg-white/5 border-white/10 text-slate-400 hover:bg-white/10"
                )}
              >
                {isPlayingBack ? <Square className="w-3 h-3" /> : <Play className="w-3 h-3" />}
                {isPlayingBack ? "Stop Play" : "Playback"}
              </button>
              <button
                onClick={clearRecording}
                className="col-span-2 flex items-center justify-center gap-2 py-2.5 rounded-xl text-xs font-bold bg-white/5 border border-white/10 text-slate-400 hover:bg-rose-500/20 hover:text-rose-400 hover:border-rose-500/50 transition-all"
              >
                <Trash2 className="w-3 h-3" />
                Clear Sequence
              </button>
            </div>
          </section>

          {/* Sensor Telemetry */}
          <section className="bg-white/5 border border-white/10 rounded-2xl p-5 space-y-4">
            <h2 className="text-xs font-bold uppercase tracking-widest text-slate-500">Telemetry</h2>
            <div className="space-y-4">
              <div className="space-y-2">
                <div className="flex justify-between text-[10px] font-bold uppercase text-slate-500">
                  <span>LDR Sensor A</span>
                  <span className="text-blue-400">{sensorData.a}</span>
                </div>
                <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
                  <motion.div 
                    className="h-full bg-blue-500"
                    animate={{ width: `${(sensorData.a / 1023) * 100}%` }}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex justify-between text-[10px] font-bold uppercase text-slate-500">
                  <span>LDR Sensor B</span>
                  <span className="text-blue-400">{sensorData.b}</span>
                </div>
                <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
                  <motion.div 
                    className="h-full bg-blue-500"
                    animate={{ width: `${(sensorData.b / 1023) * 100}%` }}
                  />
                </div>
              </div>
            </div>
          </section>
        </div>

        {/* Center: Main Visualization */}
        <div className="col-span-6 space-y-6">
          <div className="relative bg-black rounded-3xl border border-white/10 overflow-hidden shadow-2xl">
            <div ref={canvasRef} className="w-full h-full flex items-center justify-center" />
            
            {/* Overlay Status */}
            <div className="absolute top-6 left-6 flex gap-3">
              <div className="px-3 py-1.5 rounded-full bg-black/40 backdrop-blur-md border border-white/10 flex items-center gap-2">
                <Camera className={cn("w-3 h-3", mlStatus.pose ? "text-emerald-400" : "text-slate-500")} />
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-300">
                  Pose: {mlStatus.pose ? "Active" : "Init..."}
                </span>
              </div>
              <div className="px-3 py-1.5 rounded-full bg-black/40 backdrop-blur-md border border-white/10 flex items-center gap-2">
                <Activity className={cn("w-3 h-3", mlStatus.hand ? "text-emerald-400" : "text-slate-500")} />
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-300">
                  Hand: {mlStatus.hand ? "Active" : "Init..."}
                </span>
              </div>
            </div>

            {/* Mode Indicator */}
            <AnimatePresence>
              {isPlayingBack && (
                <motion.div 
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  className="absolute top-6 right-6 px-3 py-1.5 rounded-full bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 flex items-center gap-2"
                >
                  <Play className="w-3 h-3 fill-current" />
                  <span className="text-[10px] font-bold uppercase tracking-wider">Playback Mode</span>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Legend */}
          <div className="grid grid-cols-3 gap-4">
            <div className="bg-white/5 border border-white/10 rounded-2xl p-4 flex items-center gap-4">
              <div className="w-10 h-10 rounded-xl bg-rose-500/20 flex items-center justify-center border border-rose-500/30">
                <div className="w-4 h-4 rounded-full bg-rose-500" />
              </div>
              <div>
                <p className="text-xs font-bold text-white leading-none">Deflate</p>
                <p className="text-[10px] text-slate-500 mt-1 uppercase font-bold tracking-wider">State 0 (Low)</p>
              </div>
            </div>
            <div className="bg-white/5 border border-white/10 rounded-2xl p-4 flex items-center gap-4">
              <div className="w-10 h-10 rounded-xl bg-emerald-500/20 flex items-center justify-center border border-emerald-500/30">
                <div className="w-4 h-4 rounded-full bg-emerald-500" />
              </div>
              <div>
                <p className="text-xs font-bold text-white leading-none">Medium</p>
                <p className="text-[10px] text-slate-500 mt-1 uppercase font-bold tracking-wider">State 1 (Mid)</p>
              </div>
            </div>
            <div className="bg-white/5 border border-white/10 rounded-2xl p-4 flex items-center gap-4">
              <div className="w-10 h-10 rounded-xl bg-blue-500/20 flex items-center justify-center border border-blue-500/30">
                <div className="w-4 h-4 rounded-full bg-blue-500" />
              </div>
              <div>
                <p className="text-xs font-bold text-white leading-none">Inflate</p>
                <p className="text-[10px] text-slate-500 mt-1 uppercase font-bold tracking-wider">State 2 (High)</p>
              </div>
            </div>
          </div>
        </div>

        {/* Right Sidebar: Hardware Status */}
        <div className="col-span-3 space-y-6">
          <section className="bg-white/5 border border-white/10 rounded-2xl p-5 space-y-6">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-bold uppercase tracking-widest text-slate-500">Hardware I/O</h2>
              <Cpu className="w-4 h-4 text-blue-400" />
            </div>
            
            <div className="grid gap-6">
              {/* Group A */}
              <div className="space-y-3">
                <h3 className="text-[10px] font-bold uppercase tracking-wider text-slate-500 flex items-center gap-2">
                  <div className="w-1 h-1 rounded-full bg-blue-500" />
                  Actuators Group A
                </h3>
                <div className="grid grid-cols-2 gap-3">
                  <div className={cn(
                    "p-3 rounded-xl border transition-all",
                    outputs.pumpA ? "bg-blue-500/10 border-blue-500/50 text-blue-400" : "bg-white/5 border-transparent text-slate-600"
                  )}>
                    <p className="text-[10px] font-bold uppercase mb-1">Pump A</p>
                    <p className="text-lg font-mono font-bold">{outputs.pumpA}</p>
                  </div>
                  <div className={cn(
                    "p-3 rounded-xl border transition-all",
                    outputs.valveA ? "bg-rose-500/10 border-rose-500/50 text-rose-400" : "bg-white/5 border-transparent text-slate-600"
                  )}>
                    <p className="text-[10px] font-bold uppercase mb-1">Valve A</p>
                    <p className="text-lg font-mono font-bold">{outputs.valveA}</p>
                  </div>
                </div>
              </div>

              {/* Group B */}
              <div className="space-y-3">
                <h3 className="text-[10px] font-bold uppercase tracking-wider text-slate-500 flex items-center gap-2">
                  <div className="w-1 h-1 rounded-full bg-emerald-500" />
                  Actuators Group B
                </h3>
                <div className="grid grid-cols-2 gap-3">
                  <div className={cn(
                    "p-3 rounded-xl border transition-all",
                    outputs.pumpB ? "bg-blue-500/10 border-blue-500/50 text-blue-400" : "bg-white/5 border-transparent text-slate-600"
                  )}>
                    <p className="text-[10px] font-bold uppercase mb-1">Pump B</p>
                    <p className="text-lg font-mono font-bold">{outputs.pumpB}</p>
                  </div>
                  <div className={cn(
                    "p-3 rounded-xl border transition-all",
                    outputs.valveB ? "bg-rose-500/10 border-rose-500/50 text-rose-400" : "bg-white/5 border-transparent text-slate-600"
                  )}>
                    <p className="text-[10px] font-bold uppercase mb-1">Valve B</p>
                    <p className="text-lg font-mono font-bold">{outputs.valveB}</p>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* Interaction Guide */}
          <section className="bg-blue-600/10 border border-blue-500/20 rounded-2xl p-5 space-y-3">
            <h2 className="text-xs font-bold uppercase tracking-widest text-blue-400">Gesture Guide</h2>
            <ul className="space-y-2">
              <li className="flex items-start gap-2 text-[11px] text-slate-400">
                <div className="w-1 h-1 rounded-full bg-blue-400 mt-1.5 shrink-0" />
                <span>Move your <strong className="text-slate-200">shoulders</strong> to influence the façade flow globally.</span>
              </li>
              <li className="flex items-start gap-2 text-[11px] text-slate-400">
                <div className="w-1 h-1 rounded-full bg-blue-400 mt-1.5 shrink-0" />
                <span>Use your <strong className="text-slate-200">index finger</strong> for precise local interaction.</span>
              </li>
              <li className="flex items-start gap-2 text-[11px] text-slate-400">
                <div className="w-1 h-1 rounded-full bg-blue-400 mt-1.5 shrink-0" />
                <span><strong className="text-slate-200">Pinch</strong> your thumb and index finger to cycle through behaviors.</span>
              </li>
            </ul>
          </section>
        </div>
      </main>
    </div>
  );
}

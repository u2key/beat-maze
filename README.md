# beat-maze
A lightweight, ultra-low latency browser-based multiplayer rhythm game powered by WebTransport/WebSocket.

## Features

### Core Gameplay
- **Rhythm-Based Mechanic**: Players control a line that auto-advances, tapping to turn 90° when needed (inspired by Dancing Line)
- **Multiplayer Support**: Real-time synchronization with other players via WebSocket
- **Dynamic Difficulty**: BPM changes from 100 to 160 BPM throughout the game
- **Score System**: Points for accurate turns with combo multipliers

### Music & Audio System
- **Dynamic Background Music**: Procedurally generated music that adapts to game BPM in real-time
- **BPM-Synchronized Melody**: The background melody changes based on current BPM:
  - **BPM 100** (Intro): Slow, melodic intro pattern
  - **BPM 120** (Moderate): Mid-tempo energetic section
  - **BPM 140** (Fast): Rapid-fire fast-paced section
  - **BPM 160** (Intense): Climactic high-energy section
- **Multi-Layer Audio**:
  - **Melody**: Triangle wave synth for the main melodic line
  - **Bass**: Deep sine wave providing harmonic foundation
  - **Drums**: Kick drums on strong beats + hi-hat for added energy at higher tempos
- **Synchronized with Gameplay**: All music timing is perfectly synced with the beat-based game mechanics

## Getting Started

### Installation
```bash
npm install
```

### Running the Server
```bash
node server.js
```

The server will start on `http://localhost:25561`

## How to Play
1. Press **START** to begin a game
2. **Tap** or **click** to turn your line 90°
3. **Avoid walls** along the track
4. **Follow the music rhythm** - timing your turns with the beat for better accuracy
5. **Score points** for successful navigation and combos

## Technical Details

### Music System Implementation
The music system uses Web Audio API to generate:
- Frequency-based note generation using A4=440Hz standard
- Attack-decay-sustain-release (ADSR) envelopes for natural sound
- Gain node mixing for independent volume control of melody, bass, and drums
- Synchronized scheduling with game beat calculations using BPM schedule

### Game Architecture
- **Track Segments**: Predefined path the player must follow
- **BPM Schedule**: Dynamic tempo changes at specific beat intervals
- **Beat Timing**: All game events synchronized to beat time rather than wall-clock time
- **Network Sync**: Player positions, scores, and turns broadcast in real-time

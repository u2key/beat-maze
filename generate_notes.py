import sys
import os
import json
import librosa
import math

def snap_to_grid(t, beats, tempo):
    if len(beats) == 0:
        # Fallback to static tempo grid if no beats detected
        beat_duration = 60.0 / tempo
        step = round(t / (beat_duration / 4.0)) # 16th note grid
        return step * (beat_duration / 4.0)
        
    if t < beats[0]:
        beat_duration = 60.0 / tempo
        dist = beats[0] - t
        beats_before = round(dist / beat_duration)
        return beats[0] - beats_before * beat_duration
        
    if t >= beats[-1]:
        beat_duration = 60.0 / tempo
        dist = t - beats[-1]
        beats_after = round(dist / beat_duration)
        return beats[-1] + beats_after * beat_duration
        
    # Find containing beat interval
    idx = 0
    for i in range(len(beats) - 1):
        if beats[i] <= t < beats[i+1]:
            idx = i
            break
            
    b0 = beats[idx]
    b1 = beats[idx+1]
    rel = (t - b0) / (b1 - b0)
    
    # Grid options: quarter notes (0.0, 1.0), 8th (0.5), 16th (0.25, 0.75), triplets (0.333, 0.667)
    candidates = [0.0, 0.25, 0.3333, 0.5, 0.6667, 0.75, 1.0]
    best_cand = min(candidates, key=lambda c: abs(rel - c))
    return b0 + best_cand * (b1 - b0)

def analyze_mp3(file_path, output_json_path):
    if not os.path.exists(file_path):
        print(f"Error: File {file_path} does not exist.")
        sys.exit(1)
        
    print(f"Loading audio file: {file_path}...")
    y, sr = librosa.load(file_path, sr=None)
    
    print("Estimating tempo (BPM) and beat grid...")
    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
    if hasattr(tempo, '__iter__'):
        tempo = float(tempo[0])
    else:
        tempo = float(tempo)
    
    if tempo <= 0 or math.isnan(tempo):
        tempo = 120.0
        
    print(f"Estimated Tempo: {tempo:.2f} BPM")
    
    # Get beat times from frames
    beat_times = librosa.frames_to_time(beat_frames, sr=sr)
    
    print("Calculating onset strength envelope...")
    onset_env = librosa.onset.onset_strength(y=y, sr=sr)
    
    print("Detecting precise onset peaks (with backtracking)...")
    # Using backtrack=True to snap onset detections to local energy minima for maximum timing accuracy
    onset_frames = librosa.onset.onset_detect(onset_envelope=onset_env, sr=sr, backtrack=True)
    raw_onset_times = librosa.frames_to_time(onset_frames, sr=sr)
    
    lead_in = 2.5
    snapped_candidates = {}
    
    for idx, t in enumerate(raw_onset_times):
        if t < lead_in:
            continue
            
        frame = onset_frames[idx]
        strength = float(onset_env[frame]) if frame < len(onset_env) else 0.0
        
        # Snap the raw onset time to the closest rhythmic beat grid point
        snapped_time = snap_to_grid(t, beat_times, tempo)
        snapped_time = round(snapped_time, 3)
        
        # Keep the strongest onset if multiple onsets snap to the same grid point
        if snapped_time not in snapped_candidates or strength > snapped_candidates[snapped_time]["strength"]:
            snapped_candidates[snapped_time] = {
                "time": snapped_time,
                "strength": strength
            }
            
    # Sort candidates chronologically
    candidates = sorted(list(snapped_candidates.values()), key=lambda x: x["time"])
    
    # Minimum gap between turns (8th note length)
    min_gap = 60.0 / tempo / 2.0
    if min_gap < 0.22:
        min_gap = 0.22
        
    print(f"Selecting peak beats using greedy grid alignment (min gap: {min_gap:.3f}s)...")
    
    # Sort candidates by strength descending for greedy peak selection
    candidates.sort(key=lambda x: x["strength"], reverse=True)
    
    selected_times = []
    for c in candidates:
        t = c["time"]
        conflict = False
        for s_t in selected_times:
            if abs(t - s_t) < min_gap:
                conflict = True
                break
        if not conflict:
            selected_times.append(t)
            
    # Sort chosen times chronologically
    selected_times.sort()
    
    # Generate alternating segments/turns
    segments = []
    current_dir = 0
    
    # Initial start segment
    segments.append({
        "time": 0.0,
        "dir": 0
    })
    
    for t in selected_times:
        current_dir = 1 - current_dir
        segments.append({
            "time": t,
            "dir": current_dir
        })
        
    # Build song metadata
    song_data = {
        "title": os.path.basename(file_path).replace('.mp3', '').replace('_', ' ').title(),
        "bpm": round(tempo, 2),
        "leadIn": lead_in,
        "segments": segments
    }
    
    # Ensure output directory exists
    os.makedirs(os.path.dirname(os.path.abspath(output_json_path)), exist_ok=True)
    
    with open(output_json_path, 'w', encoding='utf-8') as f:
        json.dump(song_data, f, indent=2)
        
    print(f"Successfully generated notes! Saved to {output_json_path}")
    print(f"Total turns: {len(segments) - 1}")

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python generate_notes.py <input.mp3> <output.json>")
        sys.exit(1)
    analyze_mp3(sys.argv[1], sys.argv[2])

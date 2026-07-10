import sys
import os
import json
import librosa
import math

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
    
    # Construct an 8th-note grid aligned with the estimated BPM
    grid_times = []
    if len(beat_times) > 1:
        for i in range(len(beat_times) - 1):
            b0 = beat_times[i]
            b1 = beat_times[i+1]
            grid_times.append(b0)
            grid_times.append(b0 + 0.5 * (b1 - b0)) # 8th note sub-beat
        grid_times.append(beat_times[-1])
    else:
        # Fallback to static grid if beat tracking yielded insufficient beats
        beat_duration = 60.0 / tempo
        total_duration = len(y) / sr
        step = 0
        while step * (beat_duration / 2.0) < total_duration:
            grid_times.append(step * (beat_duration / 2.0))
            step += 1
            
    print("Calculating onset strength envelope...")
    onset_env = librosa.onset.onset_strength(y=y, sr=sr)
    
    # Map each grid candidate time to its local onset strength (volume change indicator)
    candidates = []
    lead_in = 2.5
    
    for t in grid_times:
        if t < lead_in:
            continue
        # Convert time to frame index to query envelope strength
        frame = librosa.time_to_frames(t, sr=sr)
        if frame < len(onset_env):
            strength = float(onset_env[frame])
            candidates.append({
                "time": float(t),
                "strength": strength
            })
            
    # Minimum gap between turns (8th note length)
    min_gap = 60.0 / tempo / 2.0
    if min_gap < 0.22:
        min_gap = 0.22
        
    print(f"Selecting peak beats using greedy grid alignment (min gap: {min_gap:.3f}s)...")
    
    # Greedy peak selection: Sort candidates by onset strength descending.
    # Keep the strongest beats, and discard any that are too close (violating min_gap).
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
